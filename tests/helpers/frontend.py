# -*- coding: utf-8 -*-
"""Shared manifest-backed frontend source lookup for tests."""
import json
import os
from functools import lru_cache


# Mechanical migration aliases for legacy test basenames; never used by the builder.
LEGACY_SCRIPT_PATHS = {
    '00-motion.js': 'frontend/src/core/motion.js',
    '00-state.js': 'frontend/src/core/state.js',
    '05-bridge.js': 'frontend/src/core/bridge.js',
    '80-utils.js': 'frontend/src/core/utils.js',
    '110-boot.js': 'frontend/src/core/bootstrap.js',
    '10-custom-select.js': 'frontend/src/components/select.js',
    '18-toast.js': 'frontend/src/components/overlays.js',
    '50-markdown.js': 'frontend/src/components/markdown.js',
    '105-context-menu.js': 'frontend/src/components/context-menu.js',
    '20-screenshot-dedup.js': 'frontend/src/chat/screenshot.js',
    '73-chat-nav.js': 'frontend/src/chat/navigation.js',
    '74-input-plus.js': 'frontend/src/chat/composer.js',
    '90-attachments.js': 'frontend/src/chat/attachments.js',
    '100-send.js': 'frontend/src/chat/send.js',
    '25-tool-exec.js': 'frontend/src/agent/tool-executor.js',
    '26-guard.js': 'frontend/src/agent/guard.js',
    '30-history-shrink.js': 'frontend/src/agent/context.js',
    '35-frozen-compact.js': 'frontend/src/agent/context-freeze.js',
    '36-cost-defense.js': 'frontend/src/agent/budget.js',
    '40-auto-compact.js': 'frontend/src/agent/compaction.js',
    '55-tool-route.js': 'frontend/src/agent/router.js',
    '95-compress.js': 'frontend/src/agent/text-compress.js',
    '97-compact.js': 'frontend/src/agent/compact-command.js',
    '60-agent-loop.js': 'frontend/src/agent/run-controller.js',
    '32-session-search.js': 'frontend/src/sessions/search.js',
    '65-session-store.js': 'frontend/src/sessions/store.js',
    '85-session-mgmt.js': 'frontend/src/sessions/controller.js',
    '38-ws-quick.js': 'frontend/src/workspace/quick.js',
    '67-plan-card.js': 'frontend/src/planning/card.js',
    '71-checkpoint-mgr.js': 'frontend/src/planning/checkpoints.js',
    '27-update.js': 'frontend/src/settings/update.js',
    '33-set-nav.js': 'frontend/src/settings/navigation.js',
    '34-local-model.js': 'frontend/src/settings/local-model.js',
    '36-connect.js': 'frontend/src/settings/connection.js',
    '37-webdav.js': 'frontend/src/settings/webdav.js',
    '39-sandbox.js': 'frontend/src/settings/sandbox.js',
    '69-memory-panel.js': 'frontend/src/settings/memory.js',
    '70-config.js': 'frontend/src/settings/store.js',
    '45-request-debounce.js': 'frontend/src/providers/request.js',
    '65-hybrid.js': 'frontend/src/providers/hybrid.js',
    '71-provider.js': 'frontend/src/providers/provider.js',
    '29-mcp.js': 'frontend/src/integrations/mcp-panel.js',
    '62-mcp-exec.js': 'frontend/src/integrations/mcp-exec.js',
    '64-software-panel.js': 'frontend/src/integrations/software.js',
    '71-browser-driver.js': 'frontend/src/integrations/browser-driver.js',
    '63-search-panel.js': 'frontend/src/search/panel.js',
    '75-token-stat.js': 'frontend/src/analytics/tokens.js',
    '76-cost-estimate.js': 'frontend/src/analytics/cost.js',
    '78-analytics.js': 'frontend/src/analytics/panel.js',
    '15-theme.js': 'frontend/src/shell/theme.js',
    '16-panel-fx.js': 'frontend/src/shell/panels.js',
    '41-nav.js': 'frontend/src/shell/navigation.js',
    '66-guard-grant.js': 'frontend/src/shell/grants.js',
    '68-onboarding.js': 'frontend/src/shell/onboarding.js',
    '69-platform.js': 'frontend/src/shell/platform.js',
    '72-shortcuts.js': 'frontend/src/shell/shortcuts.js',
    '28-audit-viewer.js': 'frontend/src/shell/audit.js',
}


# R28/R29 模块级重构：大模块拆出「前置子模块」后，vm 沙箱仍按单文件/旧名加载，
# 需要按 manifest 顺序把「前置依赖 + 原模块」一起提供，还原拆分前的完整符号面。
# R29 结构升级：从 manifest **自动推导**，消除 R28 手工清单的维护成本与顺序隐患。
# 规则：同目录、文件名为 `<原模块 stem>-*`、且在原模块之前加载的模块即前置族成员。
# 实测与 R28 手工清单完全一致（4 族），且顺序严格等于构建顺序。


@lru_cache(maxsize=8)
def _cached_script_paths(root):
    return tuple(script_paths(root))


def family_paths(root, relative):
    """模块族按 manifest 加载顺序的路径列表（前置依赖在前，原模块在后）。"""
    stem = os.path.basename(relative).rsplit('.', 1)[0]
    parent = os.path.dirname(relative)
    prefix = []
    for path in _cached_script_paths(root):
        if path == relative:
            break
        if (os.path.dirname(path) == parent
                and os.path.basename(path).startswith(stem + '-')):
            prefix.append(path)
    return prefix + [relative]


def load_manifest(root):
    """Load and minimally validate the frontend manifest from *root*."""
    filename = os.path.join(root, 'frontend', 'manifest.json')
    with open(filename, 'r', encoding='utf-8') as source:
        manifest = json.load(source)
    if manifest.get('schemaVersion') != 1:
        raise ValueError('unsupported frontend manifest schema')
    return manifest


def script_paths(root):
    """Return frontend script paths in their explicit build order."""
    return [entry['path'] for entry in load_manifest(root)['scripts']]


def resolve_script(root, name):
    """Resolve a manifest path or an unambiguous basename to a relative path."""
    normalized = name.replace('\\', '/')
    normalized = LEGACY_SCRIPT_PATHS.get(normalized, normalized)
    paths = script_paths(root)
    if normalized in paths:
        return normalized
    matches = [path for path in paths if path.rsplit('/', 1)[-1] == normalized]
    if len(matches) != 1:
        raise ValueError('frontend script is missing or ambiguous: %s' % name)
    return matches[0]


def read_frontend_source(root, name):
    """读取一个前端模块；若属于拆分后的模块族，按加载顺序拼接前置依赖 + 原模块。

    这样按旧名/基名/完整路径做的「单模块 vm 沙箱」断言，看到的符号面与拆分前一致。
    """
    relative = resolve_script(root, name)
    parts = []
    for rel in family_paths(root, relative):
        with open(os.path.join(root, *rel.split('/')), 'r', encoding='utf-8') as source:
            parts.append(source.read())
    return '\n'.join(parts)


def read_frontend_styles(root):
    """Read and merge manifest styles in their deterministic build order."""
    manifest = load_manifest(root)
    parts = []
    for relative in manifest['styles']:
        with open(os.path.join(root, *relative.split('/')), 'r', encoding='utf-8') as source:
            parts.append(source.read())
    return '\n'.join(parts)


def read_frontend_template_with_styles(root):
    """Return the DOM template followed by merged CSS for legacy combined checks."""
    manifest = load_manifest(root)
    with open(os.path.join(root, *manifest['template'].split('/')),
              'r', encoding='utf-8') as source:
        template = source.read()
    return template + '\n' + read_frontend_styles(root)


def frontend_node_map(root):
    """Return exact paths and unambiguous basename aliases for Node harnesses.

    R28：模块族的值改为以逗号分隔的多路径串（前置依赖在前）；Node harness 的
    ``__fe`` 负责按逗号拆分后顺序拼接，从而还原拆分前的完整模块源码。
    """
    result = {}
    for relative in script_paths(root):
        bundle = ','.join(family_paths(root, relative))
        result[relative] = bundle
        basename = relative.rsplit('/', 1)[-1]
        if basename in result and result[basename] != bundle:
            result[basename] = None
        else:
            result[basename] = bundle
    for legacy, relative in LEGACY_SCRIPT_PATHS.items():
        bundle = ','.join(family_paths(root, relative))
        if legacy in result and result[legacy] != bundle:
            result[legacy] = None
        else:
            result[legacy] = bundle
    return {key: value for key, value in result.items() if value is not None}
