/* G4 low-risk actions: explicit user gesture + current permission + original handler. */
const UI_ACTION_NAMES = Object.freeze(['copy', 'export', 'refresh']);
const UiActionRegistry = Object.create(null);
function registerUiAction(name, descriptor) {
  if (!UI_ACTION_NAMES.includes(name) || !descriptor || typeof descriptor.label !== 'string') {
    throw new Error('unknown_action');
  }
  if (UiActionRegistry[name]) throw new Error('duplicate_action');
  UiActionRegistry[name] = Object.freeze(descriptor);
}
function uiActionsEnabled() {
  return typeof UiGenerativeSettings !== 'undefined' && UiGenerativeSettings.actionsEnabled === true;
}
function uiActionResult(ok, code, executed) {
  return { ok, code, executed: executed || 0 };
}
async function executeUiAction(name, context) {
  const metrics = context && context.metrics;
  if (!uiActionsEnabled()) return uiActionResult(false, 'actions_disabled', 0);
  if (!context || context.userGesture !== true) return uiActionResult(false, 'user_gesture_required', 0);
  if (!UiActionRegistry[name]) return uiActionResult(false, 'unknown_action', 0);
  if (typeof context.permission !== 'function' || context.permission(name) !== true) {
    if (metrics) metrics.actions_rejected = (metrics.actions_rejected || 0) + 1;
    return uiActionResult(false, 'forbidden', 0);
  }
  const handlers = context.handlers || {};
  if (typeof handlers[name] !== 'function') return uiActionResult(false, 'handler_missing', 0);
  try {
    const value = await handlers[name](context);
    if (metrics) metrics.actions_executed = (metrics.actions_executed || 0) + 1;
    return { ok: true, code: 'completed', executed: 1, value };
  } catch (error) {
    if (metrics) metrics.actions_rejected = (metrics.actions_rejected || 0) + 1;
    return uiActionResult(false, 'handler_failed', 0);
  }
}
function uiActionSanitizeBlock(block, metrics) {
  const original = Array.isArray(block.actions) ? block.actions : [];
  const actions = original.filter(action => uiActionsEnabled() && UiActionRegistry[action.name]);
  if (metrics) metrics.actions_removed = (metrics.actions_removed || 0) + original.length - actions.length;
  const next = Object.assign({}, block, { actions: actions.slice(0, 2) });
  if (block.children) next.children = block.children.map(child => uiActionSanitizeBlock(child, metrics));
  return next;
}
function uiActionPermission(projection, block, name) {
  if (typeof projection.options.actionPermission === 'function') {
    return projection.options.actionPermission(name, block) === true;
  }
  if (block.bind && projection.options.dataRefHost &&
      typeof projection.options.dataRefHost.permission === 'function') {
    return projection.options.dataRefHost.permission(block.bind) === true;
  }
  return false;
}
function uiActionAfterRender(projection) {
  const root = projection.root;
  if (!root || !root.querySelectorAll || !projection.current) return;
  const blocks = [];
  const collect = items => items.forEach(block => {
    blocks.push(block);
    if (block.children) collect(block.children);
  });
  collect(projection.current.blocks);
  const byId = Object.create(null);
  blocks.forEach(block => { byId[block.blockId] = block; });
  root.querySelectorAll('[data-block-id]').forEach(wrapper => {
    const block = byId[wrapper.getAttribute('data-block-id')];
    if (!block || !block.actions || !block.actions.length) return;
    const row = projection.createElement('div', 'ui-action-row');
    block.actions.slice(0, 2).forEach(action => {
      const descriptor = UiActionRegistry[action.name];
      const button = projection.createElement('button', 'icon-btn ui-action-btn', descriptor.label);
      button.type = 'button';
      button.setAttribute('data-ui-action', action.name);
      button.setAttribute('aria-label', descriptor.label);
      button.addEventListener('click', async event => {
        const result = await executeUiAction(action.name, {
          projection, block, userGesture: !!(event && event.isTrusted === true),
          permission: name => uiActionPermission(projection, block, name),
          handlers: projection.options.actionHandlers || {},
          metrics: projection.metrics,
          text: wrapper.textContent,
        });
        if (typeof toast === 'function') {
          toast(result.ok ? descriptor.label + '完成' : '动作未执行：' + result.code,
            result.ok ? 'ok' : 'warn');
        }
      });
      row.appendChild(button);
    });
    wrapper.appendChild(row);
  });
}
registerUiAction('copy', { label: '复制' });
registerUiAction('export', { label: '导出' });
registerUiAction('refresh', { label: '刷新' });
const UiGenerativeActions = Object.freeze({
  sanitize(spec, metrics) {
    return Object.assign({}, spec, { blocks: spec.blocks.map(block => uiActionSanitizeBlock(block, metrics)) });
  },
  execute: executeUiAction,
  afterRender: uiActionAfterRender,
  enabled: uiActionsEnabled,
});
