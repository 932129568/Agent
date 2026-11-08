# -*- coding: utf-8 -*-
"""W3C1 manifest tree, ordering and semantic-equivalence guards."""
import json
from pathlib import Path
import re

from helpers.frontend import LEGACY_SCRIPT_PATHS, frontend_node_map, read_frontend_source

ROOT = Path(__file__).resolve().parent.parent
EXPECTED_ORDER = [
    'frontend/src/core/motion.js',
    'frontend/src/core/state.js',
    'frontend/src/core/app-state.js',
    'frontend/src/core/bridge.js',
    'frontend/src/components/select.js',
    'frontend/src/shell/theme.js',
    'frontend/src/shell/panels.js',
    'frontend/src/components/overlays.js',
    'frontend/src/chat/screenshot.js',
    'frontend/src/agent/tool-executor.js',
    'frontend/src/agent/guard.js',
    'frontend/src/settings/update.js',
    'frontend/src/shell/audit.js',
    'frontend/src/generative/schemas.js',
    'frontend/src/generative/settings.js',
    'frontend/src/generative/state.js',
    'frontend/src/generative/registry.js',
    'frontend/src/generative/data-ref.js',
    'frontend/src/generative/fixtures.js',
    'frontend/src/generative/actions.js',
    'frontend/src/generative/projection.js',
    'frontend/src/generative/artifact.js',
    'frontend/src/agent/context.js',
    'frontend/src/sessions/search.js',
    'frontend/src/settings/navigation.js',
    'frontend/src/settings/local-model.js',
    'frontend/src/agent/context-freeze.js',
    'frontend/src/settings/connection-presets.js',
    'frontend/src/settings/connection-base.js',
    'frontend/src/settings/connection.js',
    'frontend/src/agent/budget.js',
    'frontend/src/settings/webdav.js',
    'frontend/src/workspace/quick.js',
    'frontend/src/settings/sandbox.js',
    'frontend/src/agent/compaction.js',
    'frontend/src/shell/navigation.js',
    'frontend/src/providers/request.js',
    'frontend/src/components/markdown.js',
    'frontend/src/agent/router.js',
    'frontend/src/agent/request-builder.js',
    'frontend/src/agent/sse-parser.js',
    'frontend/src/agent/tool-runtime.js',
    'frontend/src/agent/model-executor.js',
    'frontend/src/generative/controller.js',
    'frontend/src/providers/provider.js',
    'frontend/src/generative/chat-auto.js',
    'frontend/src/integrations/mcp-panel.js',
    'frontend/src/agent/run-controller-utils.js',
    'frontend/src/agent/run-controller-base.js',
    'frontend/src/agent/run-controller.js',
    'frontend/src/agent/resume.js',
    'frontend/src/agent/run-registry.js',
    'frontend/src/integrations/mcp-exec.js',
    'frontend/src/search/panel-state.js',
    'frontend/src/search/panel.js',
    'frontend/src/integrations/software.js',
    'frontend/src/providers/hybrid.js',
    'frontend/src/sessions/store.js',
    'frontend/src/sessions/store-api.js',
    'frontend/src/shell/grants.js',
    'frontend/src/planning/card.js',
    'frontend/src/shell/onboarding.js',
    'frontend/src/settings/memory.js',
    'frontend/src/shell/platform.js',
    'frontend/src/settings/store.js',
    'frontend/src/integrations/browser-driver.js',
    'frontend/src/planning/checkpoints.js',
    'frontend/src/shell/shortcuts.js',
    'frontend/src/chat/navigation.js',
    'frontend/src/chat/composer.js',
    'frontend/src/analytics/tokens.js',
    'frontend/src/analytics/cost.js',
    'frontend/src/analytics/panel.js',
    'frontend/src/core/utils.js',
    'frontend/src/sessions/controller-meta.js',
    'frontend/src/sessions/controller-base.js',
    'frontend/src/sessions/controller.js',
    'frontend/src/chat/attachments.js',
    'frontend/src/agent/text-compress.js',
    'frontend/src/agent/compact-command.js',
    'frontend/src/chat/send.js',
    'frontend/src/group/group.js',
    'frontend/src/group/files.js',
    'frontend/src/group/mention.js',
    'frontend/src/group/endpoints.js',
    'frontend/src/components/context-menu.js',
    'frontend/src/expert/schemas.js',
    'frontend/src/expert/package-store.js',
    'frontend/src/expert/context.js',
    'frontend/src/expert/events.js',
    'frontend/src/expert/recovery.js',
    'frontend/src/expert/mailbox.js',
    'frontend/src/expert/orchestrator.js',
    'frontend/src/expert/controller.js',
    'frontend/src/analytics/expert.js',
    'frontend/src/collaboration/endpoint.js',
    'frontend/src/collaboration/schemas.js',
    'frontend/src/collaboration/config.js',
    'frontend/src/collaboration/router.js',
    'frontend/src/collaboration/plan.js',
    'frontend/src/collaboration/budget.js',
    'frontend/src/collaboration/privacy.js',
    'frontend/src/collaboration/recovery.js',
    'frontend/src/collaboration/controller.js',
    'frontend/src/expert/projection.js',
    'frontend/src/expert/timeline.js',
    'frontend/src/collaboration/timeline.js',
    'frontend/src/collaboration/ui.js',
    'frontend/src/expert/center.js',
    'frontend/src/shell/island-host.js',
    'frontend/src/core/bootstrap.js',
]


def manifest():
    return json.loads((ROOT / 'frontend' / 'manifest.json').read_text(encoding='utf-8'))


def test_exactly_58_modules_once_with_frozen_order_and_dependencies():
    entries = manifest()['scripts']
    paths = [entry['path'] for entry in entries]
    assert len(paths) == len(set(paths)) == 111
    assert paths == EXPECTED_ORDER
    disk = {path.relative_to(ROOT).as_posix()
            for path in (ROOT / 'frontend' / 'src').rglob('*.js')}
    assert disk == set(paths)
    provided = set()
    for entry in entries:
        assert set(entry['requires']) <= provided
        assert not (provided & set(entry['provides']))
        provided.update(entry['provides'])
        assert (ROOT / entry['path']).is_file()
    assert not list((ROOT / 'frontend' / 'src').glob('*.js'))
    assert not [path for path in paths if re.match(r'frontend/src/\d{2,3}-', path)]


def test_manifest_helper_resolves_every_new_path_without_duplicate_sources():
    node_map = frontend_node_map(str(ROOT))
    for path in EXPECTED_ORDER:
        assert node_map[path].split(',')[-1] == path
        assert read_frontend_source(str(ROOT), path)
    assert len(EXPECTED_ORDER) == 111
    assert len(LEGACY_SCRIPT_PATHS) == 57
    for old_name, new_path in LEGACY_SCRIPT_PATHS.items():
        assert read_frontend_source(str(ROOT), old_name) == \
            read_frontend_source(str(ROOT), new_path)


def test_semantic_equivalence_report_records_source_build_and_style_identity():
    report_path = ROOT / 'outputs' / 'frontend' / 'w3c1-semantic-equivalence.json'
    report = json.loads(report_path.read_text(encoding='utf-8'))
    assert report['source_files']['count'] == 57
    assert report['source_files']['identical'] is True
    assert report['manifest_contract']['order_provides_requires_identical'] is True
    assert report['build']['normalized_semantic_equal'] is True
    assert report['build']['consecutive_builds_byte_identical'] is True
    assert report['styles']['identical'] is True
