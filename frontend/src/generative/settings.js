/* G4 independent local settings; both switches default off and never touch config.json. */
const UI_GENERATIVE_SETTING_KEYS = Object.freeze({
  strictSchema: 'harbor.uiGenerative.strictSchema',
  actionsEnabled: 'harbor.uiGenerative.actionsEnabled',
});
function uiGenerativeSettingRead(key) {
  try { return localStorage.getItem(key) === '1'; } catch (error) { return false; }
}
const UiGenerativeSettings = {
  strictSchema: uiGenerativeSettingRead(UI_GENERATIVE_SETTING_KEYS.strictSchema),
  actionsEnabled: uiGenerativeSettingRead(UI_GENERATIVE_SETTING_KEYS.actionsEnabled),
  set(name, value) {
    if (!Object.prototype.hasOwnProperty.call(UI_GENERATIVE_SETTING_KEYS, name)) return false;
    this[name] = value === true;
    try { localStorage.setItem(UI_GENERATIVE_SETTING_KEYS[name], this[name] ? '1' : '0'); } catch (error) {}
    return this[name];
  },
  snapshot() {
    return { strictSchema: this.strictSchema === true, actionsEnabled: this.actionsEnabled === true };
  },
};
function uiGenerativeSettingsInit() {
  if (typeof document === 'undefined') return false;
  const grid = document.querySelector('.set-grid');
  if (!grid) return false;
  let block = document.getElementById('uiGenerativeBlock');
  if (!block) {
    block = document.createElement('div');
    block.id = 'uiGenerativeBlock'; block.className = 'set-block';
    block.setAttribute('data-group', '生成式UI');
    const title = document.createElement('div'); title.className = 'set-title'; title.textContent = '生成式 UI';
    const hint = document.createElement('div'); hint.className = 'set-hint';
    hint.textContent = '默认关闭。strictSchema 仅在端点明确支持时尝试；能力未探测，失败会回退普通 JSON。低危动作只允许用户点击后的 copy/export/refresh。';
    block.appendChild(title); block.appendChild(hint);
    const makeToggle = (id, label, description) => {
      const row = document.createElement('label'); row.className = 'ui-setting-toggle';
      row.setAttribute('for', id);
      const input = document.createElement('input'); input.type = 'checkbox'; input.id = id;
      const text = document.createElement('span'); text.textContent = label;
      const detail = document.createElement('small'); detail.textContent = description;
      row.appendChild(input); row.appendChild(text); row.appendChild(detail);
      block.appendChild(row);
      return input;
    };
    const strict = makeToggle('uiStrictSchemaToggle', '尝试 strictSchema', '仅用户显式启用；真实端点能力 UNCOVERED');
    const actions = makeToggle('uiActionsToggle', '允许低危动作', '仅 copy/export/refresh，仍需当前权限与原 handler');
    strict.checked = UiGenerativeSettings.strictSchema;
    actions.checked = UiGenerativeSettings.actionsEnabled;
    strict.addEventListener('change', () => {
      UiGenerativeSettings.set('strictSchema', strict.checked);
      if (typeof toast === 'function') toast(strict.checked ? '已启用 strictSchema 尝试（端点能力未探测）' : '已关闭 strictSchema', 'info');
    });
    actions.addEventListener('change', () => {
      UiGenerativeSettings.set('actionsEnabled', actions.checked);
      if (typeof toast === 'function') toast(actions.checked ? '已允许低危动作，仍需用户点击与权限' : '已关闭低危动作', 'info');
    });
    grid.appendChild(block);
  }
  return true;
}
