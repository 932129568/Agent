# -*- coding: utf-8 -*-
"""Controlled WorkBuddy builtin expert package conversion.

The builtin importer never relaxes ``ExpertPackageService`` validation.  It
converts the eight bundled WorkBuddy packages into a temporary Harbor package,
then calls the same strict ``import_directory`` path used by user imports.
"""
import copy
import json
import os
import shutil
import tempfile

from ... import paths
from .model import DEFAULT_LIMITS, METADATA_PATHS, SECRET_NAMES, SETTINGS_PATHS, TEXT_EXTENSIONS
from .validator import METADATA_FIELDS, SECRET_SUFFIXES

AGENT_FRONTMATTER_FIELDS = frozenset({'name', 'description', 'displayName', 'profession', 'maxTurns'})
SKILL_FRONTMATTER_FIELDS = frozenset({'name', 'description'})


def _safe_relative(value, field):
    """Normalize a declared package-relative path without allowing escapes."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError('%s must be a non-empty relative path' % field)
    raw = value.strip().replace('\\', '/')
    if not raw or raw.startswith('/') or ':' in raw.split('/', 1)[0]:
        raise ValueError('%s must not be absolute or contain a drive' % field)
    parts = [part for part in raw.split('/') if part not in ('', '.')]
    if not parts or any(part in ('..', '') for part in parts):
        raise ValueError('%s must stay inside the builtin package' % field)
    return '/'.join(parts)


def _metadata_file(root):
    for relative in METADATA_PATHS:
        candidate = os.path.join(root, *relative.split('/'))
        if os.path.isfile(candidate):
            return relative, candidate
    raise ValueError('builtin package is missing plugin.json')


def _read_json(path, label):
    with open(path, 'r', encoding='utf-8') as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError('%s must contain a JSON object' % label)
    return value


def _write_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write('\n')


def _parse_scalar(raw):
    value = raw.strip()
    if not value:
        raise ValueError('empty frontmatter value')
    if value in ('true', 'false'):
        return value == 'true'
    if value.lstrip('-').isdigit():
        return int(value)
    if value.startswith('"') and value.endswith('"'):
        parsed = json.loads(value)
        if not isinstance(parsed, str):
            raise ValueError('quoted frontmatter value must be a string')
        return parsed
    if value.startswith("'") and value.endswith("'") and len(value) >= 2:
        return value[1:-1].replace("''", "'")
    return value


def _parse_workbuddy_frontmatter(text, label):
    """Parse only the restricted WorkBuddy shapes used by builtin packages."""
    normalized = text.replace('\r\n', '\n')
    if '\r' in normalized:
        raise ValueError('%s contains a bare CR newline' % label)
    lines = normalized.split('\n')
    if not lines or lines[0] != '---':
        raise ValueError('%s must start with frontmatter' % label)
    try:
        end = next(index for index in range(1, len(lines)) if lines[index] == '---')
    except StopIteration:
        raise ValueError('%s has unclosed frontmatter' % label) from None
    front = lines[1:end]
    result = {}
    index = 0
    mode = None
    last_scalar_key = None
    while index < len(front):
        line = front[index]
        if not line.strip() or line.lstrip().startswith('#'):
            index += 1
            continue
        if line.startswith(' '):
            if mode == 'scalar' and last_scalar_key is not None:
                stripped = line.strip()
                if stripped:
                    result[last_scalar_key] = result[last_scalar_key] + ' ' + stripped
                index += 1
                continue
            raise ValueError('%s has invalid frontmatter indentation at line %d'
                             % (label, index + 2))
        if ':' not in line:
            raise ValueError('%s has an invalid frontmatter entry at line %d'
                             % (label, index + 2))
        key, raw = line.split(':', 1)
        key = key.strip()
        if not key or key in result:
            raise ValueError('%s has an invalid or duplicate key: %s' % (label, key))
        raw = raw.strip()
        if raw in ('|', '|-'):
            block = []
            index += 1
            while index < len(front):
                child = front[index]
                if child and not child.startswith('  '):
                    break
                block.append(child[2:] if child.startswith('  ') else '')
                index += 1
            result[key] = '\n'.join(block) + ('\n' if raw == '|' else '')
            mode = 'block'
            last_scalar_key = None
            continue
        if raw == '':
            block = []
            index += 1
            while index < len(front) and front[index].startswith('  '):
                block.append(front[index][2:])
                index += 1
            if block and all(item.startswith('- ') for item in block):
                result[key] = [_parse_scalar(item[2:]) for item in block]
            elif block and all(':' in item and not item.startswith(' ')
                                and item.split(':', 1)[1].strip()
                                for item in block):
                mapping = {}
                for item in block:
                    child_key, child_raw = item.split(':', 1)
                    child_key = child_key.strip()
                    if not child_key or child_key in mapping:
                        raise ValueError('%s has invalid or duplicate map key: %s'
                                         % (label, child_key))
                    mapping[child_key] = _parse_scalar(child_raw)
                result[key] = mapping
            else:
                # WorkBuddy may attach nested metadata or examples to fields that
                # Harbor does not use. Preserve the raw block for diagnostics;
                # serialization later drops unknown fields.
                result[key] = {'__raw__': '\n'.join(block)}
            mode = 'map'
            last_scalar_key = None
            continue
        result[key] = _parse_scalar(raw)
        mode = 'scalar'
        last_scalar_key = key
        index += 1
    body_lines = lines[end + 1:]
    body = '\n'.join(body_lines)
    if normalized.endswith('\n') and body:
        body += '\n'
    return result, body


def _frontmatter_scalar(value):
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, int):
        return str(value)
    if not isinstance(value, str):
        raise ValueError('frontmatter scalar must be string/int/bool')
    return json.dumps(value, ensure_ascii=False)


def _serialize_frontmatter(fields, allowed, label):
    lines = ['---']
    for key, value in fields.items():
        if key not in allowed:
            continue
        if isinstance(value, dict):
            if any(child_key not in ('en', 'zh') for child_key in value):
                raise ValueError('%s %s map supports only en/zh' % (label, key))
            if any(not isinstance(child, str) for child in value.values()):
                raise ValueError('%s %s map values must be strings' % (label, key))
            lines.append(key + ':')
            for child_key, child in value.items():
                lines.append('  ' + child_key + ': ' + _frontmatter_scalar(child))
        else:
            lines.append(key + ': ' + _frontmatter_scalar(value))
    lines.append('---')
    return '\n'.join(lines) + '\n'


def _normalize_markdown(path, allowed, overrides=None):
    label = path.replace('\\', '/')
    with open(path, 'r', encoding='utf-8', newline='') as handle:
        text = handle.read()
    fields, body = _parse_workbuddy_frontmatter(text, label)
    if overrides:
        fields.update(copy.deepcopy(overrides))
    return _serialize_frontmatter(fields, allowed, label) + body


def _copy_file(source, target):
    os.makedirs(os.path.dirname(target), exist_ok=True)
    shutil.copyfile(source, target)


def _is_secret(path):
    name = os.path.basename(path).casefold()
    return name in SECRET_NAMES or name.endswith(SECRET_SUFFIXES)


class WorkBuddyBuiltinImporter:
    """Convert bundled WorkBuddy packages and import them through the strict service."""

    def __init__(self, service, builtin_dir=None):
        self._service = service
        self._builtin_dir = os.path.abspath(builtin_dir or paths.builtin_experts_dir())

    def discover_packages(self):
        if not os.path.isdir(self._builtin_dir):
            return []
        packages = []
        for name in sorted(os.listdir(self._builtin_dir)):
            root = os.path.join(self._builtin_dir, name)
            if not os.path.isdir(root):
                continue
            relative, metadata_path = _metadata_file(root)
            metadata = _read_json(metadata_path, relative)
            packages.append({'name': name, 'root': root, 'metadata': metadata})
        return packages

    def _sanitize_metadata(self, root, metadata):
        sanitized = copy.deepcopy(metadata)
        package_name = sanitized.get('name')
        if not isinstance(package_name, str) or not package_name:
            raise ValueError('builtin metadata is missing name')
        if 'skills' not in sanitized or sanitized['skills'] in (None, []):
            discovered = []
            skills_root = os.path.join(root, 'skills')
            if os.path.isdir(skills_root):
                for entry in sorted(os.listdir(skills_root)):
                    if os.path.isfile(os.path.join(skills_root, entry, 'SKILL.md')):
                        discovered.append('./skills/' + entry)
            sanitized['skills'] = discovered
        elif isinstance(sanitized['skills'], str):
            sanitized['skills'] = [sanitized['skills']]
        if sanitized.get('expertType') == 'team':
            display = sanitized.get('displayName')
            if not isinstance(display, dict) or any(key not in ('en', 'zh') for key in display):
                display = {'en': package_name, 'zh': package_name}
            sanitized['displayName'] = copy.deepcopy(display)
            # Harbor team schema requires displayName and profession to match.
            # Builtin compatibility maps the WorkBuddy display identity to both.
            sanitized['profession'] = copy.deepcopy(display)
        allowed = {}
        for key, value in sanitized.items():
            if key in METADATA_FIELDS or key.startswith('x-harbor-'):
                allowed[key] = value
        if 'agents' not in allowed:
            allowed['agents'] = './agents/'
        return allowed

    def _copy_agents(self, root, destination, metadata):
        declared = metadata.get('agents', './agents/')
        items = [declared] if isinstance(declared, str) else declared
        if not isinstance(items, list):
            raise ValueError('builtin agents declaration must be a string or list')
        for item in items:
            relative = _safe_relative(item, 'agents')
            source = os.path.join(root, *relative.split('/'))
            if os.path.isfile(source):
                if not source.endswith('.md'):
                    raise ValueError('builtin agent must be Markdown: ' + relative)
                target = os.path.join(destination, *relative.split('/'))
                normalized = _normalize_markdown(source, AGENT_FRONTMATTER_FIELDS)
                _copy_file(source, target)
                with open(target, 'w', encoding='utf-8', newline='') as handle:
                    handle.write(normalized)
            elif os.path.isdir(source):
                for entry in sorted(os.listdir(source)):
                    if not entry.endswith('.md'):
                        continue
                    agent_relative = relative.rstrip('/') + '/' + entry
                    agent_source = os.path.join(root, *agent_relative.split('/'))
                    agent_target = os.path.join(destination, *agent_relative.split('/'))
                    normalized = _normalize_markdown(agent_source, AGENT_FRONTMATTER_FIELDS)
                    _copy_file(agent_source, agent_target)
                    with open(agent_target, 'w', encoding='utf-8', newline='') as handle:
                        handle.write(normalized)
            else:
                raise ValueError('builtin agent path is missing: ' + relative)

    def _copy_skill(self, root, destination, declared):
        relative = _safe_relative(declared, 'skills')
        source = os.path.join(root, *relative.split('/'))
        if not os.path.isdir(source):
            raise ValueError('builtin skill directory is missing: ' + relative)
        skill_source = os.path.join(source, 'SKILL.md')
        if not os.path.isfile(skill_source):
            raise ValueError('builtin skill is missing SKILL.md: ' + relative)
        skill_target = os.path.join(destination, *relative.split('/'), 'SKILL.md')
        skill_name = relative.rstrip('/').rsplit('/', 1)[-1]
        normalized = _normalize_markdown(skill_source, SKILL_FRONTMATTER_FIELDS,
                                         {'name': skill_name})
        _copy_file(skill_source, skill_target)
        with open(skill_target, 'w', encoding='utf-8', newline='') as handle:
            handle.write(normalized)
        limit = DEFAULT_LIMITS['maxFileBytes']
        for kind in ('references', 'templates'):
            resource_root = os.path.join(source, kind)
            if not os.path.isdir(resource_root):
                continue
            for base, _, files in os.walk(resource_root):
                for name in sorted(files):
                    resource_source = os.path.join(base, name)
                    if os.path.splitext(name)[1].casefold() not in TEXT_EXTENSIONS:
                        continue
                    if os.path.getsize(resource_source) > limit or _is_secret(resource_source):
                        continue
                    resource_relative = os.path.relpath(resource_source, root).replace(os.sep, '/')
                    _copy_file(resource_source, os.path.join(destination, *resource_relative.split('/')))
        script_root = os.path.join(source, 'scripts')
        if os.path.isdir(script_root):
            for base, _, files in os.walk(script_root):
                for name in sorted(files):
                    script_source = os.path.join(base, name)
                    if os.path.getsize(script_source) > limit or _is_secret(script_source):
                        continue
                    script_relative = os.path.relpath(script_source, root).replace(os.sep, '/')
                    _copy_file(script_source, os.path.join(destination, *script_relative.split('/')))

    def _copy_settings(self, root, destination, metadata):
        for relative in SETTINGS_PATHS:
            source = os.path.join(root, *relative.split('/'))
            if os.path.isfile(source):
                value = _read_json(source, relative)
                _write_json(os.path.join(destination, *relative.split('/')), value)
                return relative
        if metadata.get('expertType') == 'team':
            generated = '.codebuddy-plugin/settings.json'
            _write_json(os.path.join(destination, *generated.split('/')),
                        {'agent': metadata.get('agentName')})
            return generated
        return None

    def convert_package(self, root, output_dir, metadata=None):
        root = os.path.abspath(root)
        output_dir = os.path.abspath(output_dir)
        if metadata is None:
            relative, metadata_path = _metadata_file(root)
            metadata = _read_json(metadata_path, relative)
        sanitized = self._sanitize_metadata(root, metadata)
        os.makedirs(output_dir, exist_ok=True)
        metadata_target = os.path.join(output_dir, '.codebuddy-plugin', 'plugin.json')
        _write_json(metadata_target, sanitized)
        self._copy_settings(root, output_dir, sanitized)
        self._copy_agents(root, output_dir, sanitized)
        skills = sanitized.get('skills', [])
        if isinstance(skills, str):
            skills = [skills]
        for skill in skills:
            self._copy_skill(root, output_dir, skill)
        return output_dir

    def import_all(self):
        results = []
        packages = self.discover_packages()
        for package in packages:
            try:
                with tempfile.TemporaryDirectory(prefix='harbor-builtin-') as temporary:
                    converted = self.convert_package(package['root'], temporary,
                                                     package['metadata'])
                    imported = self._service.import_directory(converted, source_kind='builtin')
                result = copy.deepcopy(imported)
                result['builtin_root'] = package['root']
            except Exception as error:
                result = {'ok': False,
                          'error': {'code': 'BUILTIN_IMPORT_FAILED', 'message': str(error)},
                          'builtin_root': package['root']}
            results.append(result)
        return {'ok': bool(results) and all(item.get('ok') is True for item in results),
                'imported': sum(1 for item in results if item.get('ok') is True),
                'packages': results}


def import_builtin_experts(service):
    """Compatibility helper used by the composition root."""
    return WorkBuddyBuiltinImporter(service).import_all()
