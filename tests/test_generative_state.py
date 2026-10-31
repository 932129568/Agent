# -*- coding: utf-8 -*-
"""G4 AppState-owned transient state and explicit low-risk action tests."""
from test_generative_artifact import FALLBACK
from test_generative_registry import DOM
from test_model_executor_foundation import run_case

MODULES = [
    'libs/ui-schema.bundle.js', 'frontend/src/generative/schemas.js',
    'frontend/src/generative/settings.js', 'frontend/src/generative/state.js',
    'frontend/src/generative/registry.js', 'frontend/src/generative/data-ref.js',
    'frontend/src/generative/fixtures.js', 'frontend/src/generative/actions.js',
    'frontend/src/generative/projection.js',
]
HELPERS = r'''
function entity(id, focusKey, blockId) {
  const attrs = { 'data-entity-id': id, 'data-focus-key': focusKey || id };
  return { attrs, scrollTop: 0,
    getAttribute(name) { return this.attrs[name] === undefined ? null : this.attrs[name]; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    closest(selector) { return selector === '[data-block-id]' ? { getAttribute: () => blockId || 'block' } : null; },
    focus() { document.activeElement = this; },
  };
}
function rootFor(entities) {
  const title = entity('title', 'title');
  const table = { scrollTop: 0, getAttribute: () => 'block' };
  return { entities, title, table, scrollTop: 0,
    querySelectorAll(selector) {
      if (selector === '[data-entity-id]') return this.entities;
      if (selector === '.ui-table-wrap') return [this.table];
      if (selector === '[data-focus-key]') return [...this.entities, this.title];
      return [];
    },
    querySelector(selector) { return selector === '.ui-projection-title' ? this.title : null; },
    contains(element) { return this.entities.includes(element) || element === this.title; },
  };
}
function specFor(runId, revision) {
  return { schemaVersion: 1, specId: 'state-spec', revision, runId, sessionId: 'session', generation: 1,
    layout: 'single-column', title: 'state', blocks: [] };
}
'''


def test_capture_restore_selection_expanded_scroll_focus_and_entity_replacement():
    result = run_case(DOM + HELPERS + r'''
AppState = { uiGenerative: { views: {} } };
const oldEntity = entity('memory-0-old', 'block/memory-0-old');
oldEntity.setAttribute('data-selected', 'true'); oldEntity.setAttribute('data-expanded', 'true');
const oldRoot = rootFor([oldEntity]); oldRoot.scrollTop = 42; oldRoot.table.scrollTop = 18;
document.activeElement = oldEntity;
const before = { current: specFor('run', 1), root: oldRoot, document };
const saved = UiGenerativeState.capture(before);
const nextEntity = entity('memory-0-old', 'block/memory-0-old');
const nextRoot = rootFor([nextEntity]);
const next = { current: specFor('run', 2), root: nextRoot, document };
UiGenerativeState.restore(next, saved);
const restored = { selected: nextEntity.getAttribute('data-selected'),
  expanded: nextEntity.getAttribute('data-expanded'), scroll: nextRoot.scrollTop,
  tableScroll: nextRoot.table.scrollTop, focus: document.activeElement === nextEntity };
const replacement = entity('memory-0-new', 'block/memory-0-new');
const replacementRoot = rootFor([replacement]);
const replacementProjection = { current: specFor('run', 3), root: replacementRoot, document };
UiGenerativeState.restore(replacementProjection, saved);
const replaced = { selected: replacement.getAttribute('data-selected'),
  focusIsTitle: document.activeElement === replacementRoot.title,
  oldEntityRemoved: !AppState.uiGenerative.views['state-spec'].entities['block/memory-0-old'] };
return { restored, replaced };
''', MODULES)
    assert result['restored'] == {'selected': 'true', 'expanded': 'true', 'scroll': 42,
                                   'tableScroll': 18, 'focus': True}
    assert result['replaced']['selected'] is None
    assert result['replaced']['focusIsTitle'] is True
    assert result['replaced']['oldEntityRemoved'] is True


def test_old_owner_does_not_restore_and_deleted_active_entity_falls_back_to_title():
    result = run_case(DOM + HELPERS + r'''
AppState = { uiGenerative: { views: {} } };
const oldEntity = entity('old', 'block/old'); oldEntity.setAttribute('data-selected', 'true');
const oldRoot = rootFor([oldEntity]); document.activeElement = oldEntity;
const saved = UiGenerativeState.capture({ current: specFor('old-run', 1), root: oldRoot, document });
const nextEntity = entity('old', 'block/old');
const nextRoot = rootFor([nextEntity]);
UiGenerativeState.restore({ current: specFor('new-run', 2), root: nextRoot, document }, saved);
const wrongOwner = nextEntity.getAttribute('data-selected');
const deletedRoot = rootFor([]);
UiGenerativeState.restore({ current: specFor('old-run', 2), root: deletedRoot, document }, saved);
return { wrongOwner, focusIsTitle: document.activeElement === deletedRoot.title,
  entities: Object.keys(AppState.uiGenerative.views['state-spec'].entities) };
''', MODULES)
    assert result['wrongOwner'] is None
    assert result['focusIsTitle'] is True
    assert result['entities'] == []


def test_actions_default_off_gesture_permission_handlers_and_independent_settings():
    result = run_case(FALLBACK + r'''
const storage = { values: {}, getItem(key) { return this.values[key] || null; },
  setItem(key, value) { this.values[key] = value; } };
globalThis.localStorage = storage;
UiGenerativeSettings.strictSchema = false; UiGenerativeSettings.actionsEnabled = false;
let calls = [];
const context = { userGesture: true, permission: () => true,
  handlers: { copy: async context => { calls.push(context.text); return 'copied'; },
    refresh: async () => { calls.push('refresh'); }, export: async () => { calls.push('export'); } },
  text: '授权文本', metrics: {} };
const disabled = await executeUiAction('copy', context);
UiGenerativeSettings.set('actionsEnabled', true);
const noGesture = await executeUiAction('copy', Object.assign({}, context, { userGesture: false }));
const forbidden = await executeUiAction('copy', Object.assign({}, context, { permission: () => false }));
const copied = await executeUiAction('copy', context);
await executeUiAction('refresh', context); await executeUiAction('export', context);
const unknown = await executeUiAction('delete', context);
const failed = await executeUiAction('copy', Object.assign({}, context, {
  handlers: { copy: async () => { throw new Error('denied'); } } }));
const spec = { schemaVersion: 1, specId: 'actions', revision: 1, runId: 'r', sessionId: 's', generation: 1,
  layout: 'single-column', blocks: [{ blockId: 'b', component: 'TextBlock',
    props: { text: 'x' }, actions: [{ name: 'copy' }, { name: 'refresh' }, { name: 'delete' }] }] };
const sanitized = UiGenerativeActions.sanitize(spec, {});
UiGenerativeSettings.set('strictSchema', true);
return { disabled, noGesture, forbidden, copied, unknown, failed, calls,
  actions: sanitized.blocks[0].actions.map(action => action.name), settings: UiGenerativeSettings.snapshot(),
  storage: storage.values, metrics: context.metrics };
''', MODULES)
    assert result['disabled'] == {'ok': False, 'code': 'actions_disabled', 'executed': 0}
    assert result['noGesture']['code'] == 'user_gesture_required'
    assert result['forbidden']['code'] == 'forbidden'
    assert result['copied']['executed'] == 1 and result['copied']['value'] == 'copied'
    assert result['unknown']['code'] == 'unknown_action'
    assert result['failed']['code'] == 'handler_failed'
    assert result['calls'] == ['授权文本', 'refresh', 'export']
    assert result['actions'] == ['copy', 'refresh']
    assert result['settings'] == {'strictSchema': True, 'actionsEnabled': True}
    assert result['storage']['harbor.uiGenerative.strictSchema'] == '1'
    assert result['storage']['harbor.uiGenerative.actionsEnabled'] == '1'
    assert result['metrics']['actions_executed'] == 3
    assert result['metrics']['actions_rejected'] == 2
