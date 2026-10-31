# -*- coding: utf-8 -*-
"""QA 独立对抗测试：内置专家包转换不得复制正文。

背景：backend/domains/expert/builtin_importer.py::_normalize_markdown 曾返回
`frontmatter + body + body`，导致全部内置 agent/skill Markdown 正文逐字翻倍
（30/40 个资源实测 conv_len ≈ 2×orig_len）。工程师既有测试只做子串断言，
重复正文仍能通过，故补此回归。
"""
from pathlib import Path

from backend.domains.expert.builtin_importer import WorkBuddyBuiltinImporter, _normalize_markdown
from backend.domains.expert.service import ExpertPackageService

ROOT = Path(__file__).resolve().parent.parent
BUILTIN_DIR = ROOT / 'backend' / 'experts_builtin'


def test_normalize_markdown_body_appears_exactly_once(tmp_path):
    source = tmp_path / 'agent.md'
    source.write_text(
        '---\nname: "demo"\ndescription: "demo agent"\n---\n\n'
        '# Demo Agent\n\n唯一正文第一行。\n唯一正文第二行。\n',
        encoding='utf-8', newline='')
    normalized = _normalize_markdown(str(source), frozenset({'name', 'description'}))
    assert normalized.count('唯一正文第一行。') == 1, normalized[normalized.index('---', 4):][:200]
    assert normalized.count('唯一正文第二行。') == 1


def test_builtin_imported_agent_body_matches_source_exactly(tmp_path):
    service = ExpertPackageService(registry_path=str(tmp_path / 'experts.json'),
                                    root=str(tmp_path / 'managed'))
    assert WorkBuddyBuiltinImporter(service, str(BUILTIN_DIR)).import_all()['ok'] is True
    package = service.get('qa-testing')['package']
    agent = package['agents'][0]
    imported = service.read_resource(package['snapshot_id'], agent['path'])['text']
    source = (BUILTIN_DIR / 'qa-testing' / 'agents' / Path(agent['path']).name)\
        .read_text(encoding='utf-8', newline='')
    source_body = '---'.join(source.split('---')[2:]).strip()
    imported_body = '---'.join(imported.split('---')[2:]).strip()
    assert imported_body == source_body, (
        '内置 agent 正文被改写：导入体 %d 字符 vs 源 %d 字符' % (len(imported_body), len(source_body)))
