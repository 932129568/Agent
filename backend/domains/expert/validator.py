# -*- coding: utf-8 -*-
"""Canonical asset scanning and semantic validation for expert packages."""
import os
import re
import stat
import unicodedata

from .frontmatter import parse_frontmatter
from .jsonio import read_limited, sha256_bytes, strict_json_bytes
from .model import (DEFAULT_LIMITS, ID_RE, METADATA_PATHS, SECRET_NAMES,
                    SETTINGS_PATHS, TEXT_EXTENSIONS, VERSION_RE, failure)

METADATA_FIELDS = {
    'name', 'version', 'description', 'author', 'expertType', 'agentName', 'teamInfo',
    'agents', 'skills', 'displayName', 'profession', 'displayDescription', 'categoryId',
    'tags', 'quickPrompts', 'defaultInitPrompt', 'members', 'settings', 'limits',
    'icon', 'avatar', 'homepage', 'license', 'repository', 'preview', 'resources',
}
AGENT_FIELDS = {'name', 'description', 'displayName', 'profession', 'maxTurns'}
SKILL_FIELDS = {'name', 'description'}
SECRET_SUFFIXES = ('.pem', '.key', '.p12', '.pfx', '.kdbx')
RESOURCE_REF_RE = re.compile(r'@(references|templates)/([A-Za-z0-9._/-]+)')


def _secure_lstat(path):
    try:
        info = os.lstat(path)
    except OSError as error:
        failure('PATH_UNAVAILABLE', '路径无法读取', path=path, details=type(error).__name__)
    if stat.S_ISLNK(info.st_mode):
        failure('LINK_NOT_ALLOWED', '禁止符号链接', path=path)
    is_junction = getattr(os.path, 'isjunction', lambda value: False)
    if is_junction(path):
        failure('REPARSE_NOT_ALLOWED', '禁止 junction/reparse 路径', path=path)
    reparse = getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0)
    if reparse and getattr(info, 'st_file_attributes', 0) & reparse:
        failure('REPARSE_NOT_ALLOWED', '禁止 reparse 路径', path=path)
    return info


def _check_ancestors(path):
    current = os.path.abspath(path)
    while True:
        _secure_lstat(current)
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent


def canonical_root(path):
    absolute = os.path.abspath(os.path.expanduser(str(path)))
    _check_ancestors(absolute)
    root = os.path.normcase(os.path.realpath(absolute))
    if not os.path.isdir(root):
        failure('DIRECTORY_REQUIRED', '只允许目录导入', path=path)
    return root


def _relative(path, root):
    candidate = os.path.normcase(os.path.realpath(os.path.abspath(path)))
    try:
        if os.path.commonpath((root, candidate)) != root:
            failure('PATH_ESCAPE', '路径逃逸包根目录', path=path)
    except ValueError:
        failure('PATH_ESCAPE', '路径盘符或 UNC 逃逸', path=path)
    return os.path.relpath(candidate, root).replace(os.sep, '/')


def safe_declared_path(value, field, metadata_path):
    if not isinstance(value, str) or not value.strip():
        failure('INVALID_RESOURCE_PATH', '资源声明必须是非空字符串', path=metadata_path, field=field)
    raw = value.strip()
    if '\x00' in raw or '\\' in raw or raw.startswith(('/', '//')) or re.match(r'^[A-Za-z]:', raw):
        failure('PATH_ESCAPE', '禁止绝对、UNC、盘符或混合斜杠路径', path=metadata_path, field=field)
    parts = [part for part in raw.split('/') if part not in ('', '.')]
    if not parts or any(part == '..' for part in parts):
        failure('PATH_ESCAPE', '资源声明包含越界片段', path=metadata_path, field=field)
    return '/'.join(parts)


def scan_package(source, limits=None):
    """Read only regular files under canonical root, with pre-read limits."""
    limits = limits or DEFAULT_LIMITS
    root = canonical_root(source)
    records = {}
    folded = {}
    stack = [(root, '', 0)]
    total = 0
    while stack:
        directory, prefix, depth = stack.pop()
        if depth > limits['maxDepth']:
            failure('DEPTH_TOO_LARGE', '包目录深度超限', path=directory)
        _secure_lstat(directory)
        try:
            entries = sorted(os.scandir(directory), key=lambda entry: entry.name)
        except OSError:
            failure('PATH_UNAVAILABLE', '目录无法枚举', path=directory)
        for entry in entries:
            path = entry.path
            relative = (prefix + '/' + entry.name).lstrip('/')
            info = _secure_lstat(path)
            key = unicodedata.normalize('NFC', relative).casefold()
            if key in folded:
                failure('CASEFOLD_COLLISION', '路径在 NFC/case-fold 后冲突', path=path,
                        details={'other': folded[key]})
            folded[key] = relative
            if stat.S_ISDIR(info.st_mode):
                stack.append((path, relative, depth + 1))
                continue
            if not stat.S_ISREG(info.st_mode):
                failure('NOT_REGULAR_FILE', '包内只允许普通文件或目录', path=path)
            if info.st_nlink > 1:
                failure('HARDLINK_NOT_ALLOWED', '禁止硬链接文件', path=path)
            lower = entry.name.casefold()
            if lower in SECRET_NAMES or lower.endswith(SECRET_SUFFIXES):
                failure('SECRET_FILE_NOT_ALLOWED', '秘密或密钥文件不得进入专家包', path=relative)
            if len(records) >= limits['maxFiles']:
                failure('TOO_MANY_FILES', '包文件数超限', path=relative)
            if info.st_size > limits['maxFileBytes']:
                failure('FILE_TOO_LARGE', '单文件超过大小上限', path=relative)
            if total + info.st_size > limits['maxPackageBytes']:
                failure('PACKAGE_TOO_LARGE', '包总大小超限', path=relative)
            before = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
            data = read_limited(path, limits['maxFileBytes'], relative)
            after_info = _secure_lstat(path)
            after = (after_info.st_dev, after_info.st_ino, after_info.st_size, after_info.st_mtime_ns)
            if before != after:
                failure('TOCTOU_CHANGED', '读取期间文件发生变化', path=relative)
            total += len(data)
            records[relative] = {
                'path': relative, 'size': len(data), 'sha256': sha256_bytes(data), 'data': data,
                'absolute': os.path.normcase(os.path.realpath(path)),
            }
    return {'root': root, 'records': records, 'totalBytes': total}


def _text(record, field, limit):
    if record['size'] > limit:
        failure('TEXT_TOO_LARGE', '文本资源超过大小上限', path=record['path'], field=field)
    try:
        return record['data'].decode('utf-8')
    except UnicodeDecodeError as error:
        failure('INVALID_UTF8', '文本必须是 UTF-8', path=record['path'], field=field,
                line=1, column=error.start + 1)


def _load_metadata(records, limits):
    present = []
    for relative in METADATA_PATHS:
        if relative in records:
            record = records[relative]
            if record['size'] > limits['maxMetadataBytes']:
                failure('METADATA_TOO_LARGE', 'plugin.json 超过大小上限', path=relative)
            present.append((relative, strict_json_bytes(record['data'], relative)))
    if not present:
        failure('METADATA_NOT_FOUND', '未找到三种受支持位置的 plugin.json')
    first_path, metadata = present[0]
    if not isinstance(metadata, dict):
        failure('METADATA_NOT_OBJECT', 'plugin.json 必须是对象', path=first_path)
    conflicts = []
    for relative, other in present[1:]:
        fields = set(metadata) | set(other)
        for field in sorted(fields):
            if metadata.get(field) != other.get(field):
                conflicts.append({'path': relative, 'field': field})
    if conflicts:
        failure('METADATA_CONFLICT', '多份 plugin.json 元数据冲突', path=first_path,
                details=conflicts)
    warnings = ['MULTIPLE_METADATA_IDENTICAL'] if len(present) > 1 else []
    unknown = sorted(key for key in metadata if key not in METADATA_FIELDS and not key.startswith('x-harbor-'))
    if unknown:
        failure('METADATA_FIELD_UNKNOWN', 'plugin.json 含未知核心字段', path=first_path,
                field=unknown[0])
    return first_path, metadata, warnings


def _id(value, field, path):
    if not isinstance(value, str) or not ID_RE.match(value):
        failure('INVALID_ID', 'ID 必须匹配受控 kebab/dot 规则', path=path, field=field)
    folded = unicodedata.normalize('NFC', value).casefold()
    if folded != value:
        failure('NON_CANONICAL_ID', 'ID 必须使用 NFC 小写形式', path=path, field=field)
    return value


def _localized(value, field, path, required=False):
    if value is None and not required:
        return
    if not isinstance(value, dict) or any(key not in ('en', 'zh') for key in value):
        failure('INVALID_LOCALIZED_FIELD', '展示字段只允许 en/zh map', path=path, field=field)
    if any(not isinstance(item, str) or len(item) > 1024 for item in value.values()):
        failure('INVALID_LOCALIZED_FIELD', '展示字段文本非法或超限', path=path, field=field)


def _agent_paths(metadata, metadata_path, records):
    declared = metadata.get('agents', './agents/')
    items = [declared] if isinstance(declared, str) else declared
    if not isinstance(items, list) or any(not isinstance(item, str) for item in items):
        failure('INVALID_AGENTS', 'agents 必须是目录字符串或文件数组', path=metadata_path, field='agents')
    selected = []
    for item in items:
        relative = safe_declared_path(item, 'agents', metadata_path)
        if relative in records and relative.endswith('.md'):
            selected.append(relative)
            continue
        prefix = relative.rstrip('/') + '/'
        selected.extend(path for path in records if path.startswith(prefix) and path.endswith('.md')
                        and '/' not in path[len(prefix):])
    if not selected:
        failure('AGENTS_NOT_FOUND', '未找到任何 Agent Markdown', path=metadata_path, field='agents')
    return sorted(set(selected))


def _validate_agents(metadata, metadata_path, records, limits, warnings):
    agents = {}
    for relative in _agent_paths(metadata, metadata_path, records):
        if len(agents) >= limits['maxAgents']:
            failure('TOO_MANY_AGENTS', 'Agent 数量超限', path=relative)
        frontmatter, body = parse_frontmatter(records[relative]['data'], relative)
        unknown = sorted(key for key in frontmatter if key not in AGENT_FIELDS and not key.startswith('x-harbor-'))
        if unknown:
            failure('AGENT_FIELD_UNKNOWN', 'Agent frontmatter 含未知核心字段', path=relative, field=unknown[0])
        agent_id = _id(frontmatter.get('name'), 'name', relative)
        stem = relative.rsplit('/', 1)[-1][:-3]
        if agent_id != stem:
            failure('AGENT_NAME_MISMATCH', 'Agent name 必须与 Markdown stem 完全一致',
                    path=relative, field='name', details={'stem': stem})
        if agent_id == 'team-lead':
            failure('GENERIC_AGENT_NAME', '不允许无语义的裸 team-lead', path=relative)
        if not isinstance(frontmatter.get('description'), str) or not frontmatter['description'].strip():
            failure('DESCRIPTION_REQUIRED', 'Agent description 必填', path=relative, field='description')
        _localized(frontmatter.get('displayName'), 'displayName', relative)
        _localized(frontmatter.get('profession'), 'profession', relative)
        turns = frontmatter.get('maxTurns', limits['maxActorTurns'])
        if not isinstance(turns, int) or isinstance(turns, bool) or turns < 1:
            failure('INVALID_LIMIT', 'maxTurns 必须是正整数', path=relative, field='maxTurns')
        if turns > limits['maxActorTurns']:
            warnings.append('AGENT_LIMIT_INTERSECTED:' + relative)
        if len(body.encode('utf-8')) > limits['maxPromptBytes']:
            failure('PROMPT_TOO_LARGE', 'Agent 提示词超过大小上限', path=relative)
        if not body.strip():
            failure('PROMPT_EMPTY', 'Agent 提示词不能为空', path=relative)
        key = unicodedata.normalize('NFC', agent_id).casefold()
        if key in agents:
            failure('AGENT_ID_COLLISION', 'Agent ID 在 NFC/case-fold 后冲突', path=relative)
        agents[key] = {
            'id': agent_id, 'path': relative, 'sha256': records[relative]['sha256'],
            'description': frontmatter['description'], 'displayName': frontmatter.get('displayName'),
            'profession': frontmatter.get('profession'), 'maxTurns': min(turns, limits['maxActorTurns']),
        }
    return agents


def _validate_skills(metadata, metadata_path, records, limits, warnings):
    declared = metadata.get('skills', [])
    if isinstance(declared, str):
        declared = [declared]
    if not isinstance(declared, list) or any(not isinstance(item, str) for item in declared):
        failure('INVALID_SKILLS', 'skills 必须是目录数组', path=metadata_path, field='skills')
    if len(declared) > limits['maxSkills']:
        failure('TOO_MANY_SKILLS', 'Skill 数量超限', path=metadata_path, field='skills')
    skills, readable, resources, scripts = [], [], [], []
    folded = set()
    for declared_path in declared:
        directory = safe_declared_path(declared_path, 'skills', metadata_path)
        name = directory.rsplit('/', 1)[-1]
        folded_name = unicodedata.normalize('NFC', name).casefold()
        if folded_name in folded:
            failure('SKILL_ID_COLLISION', 'Skill 名称在 NFC/case-fold 后冲突', path=directory)
        folded.add(folded_name)
        skill_path = directory + '/SKILL.md'
        if skill_path not in records:
            failure('SKILL_NOT_FOUND', 'Skill 缺少 SKILL.md', path=skill_path)
        frontmatter, body = parse_frontmatter(records[skill_path]['data'], skill_path)
        unknown = sorted(key for key in frontmatter if key not in SKILL_FIELDS and not key.startswith('x-harbor-'))
        if unknown:
            failure('SKILL_FIELD_UNKNOWN', 'SKILL.md 含未知核心字段', path=skill_path, field=unknown[0])
        if frontmatter.get('name') != name:
            failure('SKILL_NAME_MISMATCH', 'SKILL.md name 必须与目录一致', path=skill_path, field='name')
        description = frontmatter.get('description')
        if not isinstance(description, str) or not description.strip() or len(description) > 1024:
            failure('SKILL_DESCRIPTION_INVALID', 'Skill description 为空或超过 1024 字符', path=skill_path)
        if len(name) > 128:
            failure('SKILL_NAME_TOO_LONG', 'Skill name 超过 128 字符', path=skill_path)
        readable.append(skill_path)
        skill_resources, skill_scripts = [], []
        for kind in ('references', 'templates'):
            prefix = directory + '/' + kind + '/'
            for path, record in records.items():
                if not path.startswith(prefix) or path == skill_path:
                    continue
                extension = os.path.splitext(path)[1].casefold()
                if extension not in TEXT_EXTENSIONS:
                    failure('RESOURCE_TYPE_NOT_ALLOWED', 'references/templates 只允许白名单文本', path=path)
                skill_resources.append({'path': path, 'kind': kind, 'size': record['size'],
                                        'sha256': record['sha256']})
                readable.append(path)
        script_prefix = directory + '/scripts/'
        for path, record in records.items():
            if path.startswith(script_prefix):
                skill_scripts.append({'path': path, 'type': 'script', 'size': record['size'],
                                      'sha256': record['sha256'], 'executable': False})
        for match in RESOURCE_REF_RE.finditer(body):
            reference = safe_declared_path(match.group(1) + '/' + match.group(2), 'resource', skill_path)
            full = directory + '/' + reference
            if full not in readable:
                failure('RESOURCE_REF_NOT_FOUND', 'SKILL.md 引用了不存在或不可读的资源',
                        path=skill_path, field=reference)
        if len(body.encode('utf-8')) > limits['maxPromptBytes']:
            failure('PROMPT_TOO_LARGE', 'SKILL.md 提示词超过大小上限', path=skill_path)
        resources.extend(skill_resources)
        scripts.extend(skill_scripts)
        skills.append({'name': name, 'description': description, 'path': skill_path,
                       'sha256': records[skill_path]['sha256'], 'resources': skill_resources,
                       'scripts': skill_scripts})
    if len(resources) > limits['maxResources']:
        failure('TOO_MANY_RESOURCES', 'references/templates 数量超限', path=metadata_path)
    return skills, readable, resources, scripts


def _validate_team(metadata, metadata_path, agents, records, limits):
    kind = metadata.get('expertType', 'agent')
    if kind not in ('agent', 'team'):
        failure('INVALID_EXPERT_TYPE', 'expertType 只允许 agent/team', path=metadata_path)
    agent_name = _id(metadata.get('agentName'), 'agentName', metadata_path)
    if agent_name not in agents:
        failure('LEAD_NOT_FOUND', 'agentName 对应的 Agent 不存在', path=metadata_path, field='agentName')
    if kind == 'agent':
        return {'kind': kind, 'leadAgent': agent_name, 'memberAgents': [], 'members': []}
    team_info = metadata.get('teamInfo')
    if not isinstance(team_info, dict) or set(team_info) - {'leadAgent', 'memberAgents'}:
        failure('INVALID_TEAM_INFO', 'teamInfo 只允许 leadAgent/memberAgents', path=metadata_path, field='teamInfo')
    lead = _id(team_info.get('leadAgent'), 'teamInfo.leadAgent', metadata_path)
    if lead != agent_name:
        failure('TEAM_LEAD_MISMATCH', 'leadAgent 必须与 agentName/lead MD name 一致', path=metadata_path)
    members = team_info.get('memberAgents')
    if not isinstance(members, list) or len(members) < 1 or len(members) + 1 > limits['maxMembers']:
        failure('INVALID_TEAM_SIZE', 'Team members 数量不符合限额', path=metadata_path)
    if any(not isinstance(member, str) for member in members):
        failure('INVALID_TEAM_INFO', 'memberAgents 必须是字符串数组', path=metadata_path)
    if len(set(members)) != len(members) or lead in members:
        failure('TEAM_MEMBER_DUPLICATE', 'memberAgents 重复或包含 lead', path=metadata_path)
    for member in members:
        _id(member, 'teamInfo.memberAgents', metadata_path)
        if member not in agents:
            failure('MEMBER_NOT_FOUND', 'memberAgents 引用了不存在的 Agent', path=metadata_path, field=member)
    listed = metadata.get('members')
    if not isinstance(listed, list) or len(listed) != len(members) + 1:
        failure('TEAM_MEMBERS_MISMATCH', 'members[] 必须包含 lead 与全部 member', path=metadata_path)
    by_id = {}
    for item in listed:
        if not isinstance(item, dict) or not isinstance(item.get('id'), str) or item['id'] in by_id:
            failure('TEAM_MEMBERS_MISMATCH', 'members[] id 重复或非法', path=metadata_path)
        by_id[item['id']] = item
        expected_role = 'lead' if item['id'] == lead else 'member'
        if item.get('role') != expected_role:
            failure('TEAM_MEMBER_ROLE_MISMATCH', 'members[] role 与 teamInfo 不一致',
                    path=metadata_path, field=item['id'])
    if set(by_id) != set(members + [lead]):
        failure('TEAM_MEMBERS_MISMATCH', 'members[] 与 teamInfo 引用集合不一致', path=metadata_path)
    settings_path = next((path for path in SETTINGS_PATHS if path in records), None)
    if not settings_path:
        failure('TEAM_SETTINGS_REQUIRED', 'Team 缺少 settings.json', path=metadata_path)
    settings = strict_json_bytes(records[settings_path]['data'], settings_path)
    if not isinstance(settings, dict) or settings.get('agent') != agent_name:
        failure('TEAM_SETTINGS_MISMATCH', 'settings.agent 必须与 agentName/lead MD name 一致',
                path=settings_path, field='agent')
    _localized(metadata.get('displayName'), 'displayName', metadata_path, required=True)
    _localized(metadata.get('profession'), 'profession', metadata_path, required=True)
    if metadata.get('displayName') != metadata.get('profession'):
        failure('TEAM_DISPLAY_MISMATCH', 'Team profession/displayName 必须一致', path=metadata_path)
    return {'kind': kind, 'leadAgent': lead, 'memberAgents': members,
            'members': listed, 'settingsPath': settings_path}


def validate_package(scanned, limits=None):
    limits = dict(DEFAULT_LIMITS, **(limits or {}))
    records = scanned['records']
    metadata_path, metadata, warnings = _load_metadata(records, limits)
    package_id = _id(metadata.get('name'), 'name', metadata_path)
    version = metadata.get('version')
    if not isinstance(version, str) or not VERSION_RE.match(version):
        failure('INVALID_VERSION', 'version 必须是严格 MAJOR.MINOR.PATCH[-label]', path=metadata_path)
    agents = _validate_agents(metadata, metadata_path, records, limits, warnings)
    team = _validate_team(metadata, metadata_path, agents, records, limits)
    skills, readable, resources, scripts = _validate_skills(metadata, metadata_path, records, limits, warnings)
    readable.extend(agent['path'] for agent in agents.values())
    package_limits = dict(limits)
    declared_limits = metadata.get('limits', {})
    if not isinstance(declared_limits, dict):
        failure('INVALID_LIMIT', '包 limits 必须是对象', path=metadata_path, field='limits')
    for key, value in declared_limits.items():
        if key not in limits or not isinstance(value, int) or isinstance(value, bool) or value < 1:
            failure('INVALID_LIMIT', '包 limits 字段或值非法', path=metadata_path, field=key)
        if value > limits[key]:
            warnings.append('PACKAGE_LIMIT_INTERSECTED:' + key)
        package_limits[key] = min(value, limits[key])
    return {
        'schema_version': 1, 'package_id': package_id, 'version': version,
        'kind': team['kind'], 'metadata': metadata, 'agents': list(agents.values()),
        'team': team, 'skills': skills, 'resources': resources, 'scripts': scripts,
        'limits': package_limits, 'readable_paths': sorted(set(readable)),
        'validation': {'valid': True, 'warnings': warnings, 'files': len(records)},
    }
