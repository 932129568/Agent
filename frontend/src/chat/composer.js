/* ================= v1.8.0 · 输入区重构（74-input-plus.js） =================
 * 用户实测（WorkBuddy 同款）：附件 4 钮平铺占位 → 「+」弹出菜单；
 * 省出位置加模型选择 chip（图标+模型名+caret）→ 弹出模型列表
 * （数据源 = 设置区 modelSelect 的 options，双向同步不改契约 id）；
 * 列表底部「配置自定义模型」→ 跳设置「连接与模型」块并闪光定位。
 */

const PLUS_ITEMS = [
  { key: 'img', label: '图片', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>' },
  { key: 'vid', label: '视频', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="14" height="14" rx="2"/><path d="M16 10l6-3v10l-6-3z"/></svg>' },
  { key: 'file', label: '文本文件', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>' },
  { key: 'zip', label: '压缩包 (zip)', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l2 3h5a2 2 0 0 1 2 2z"/><path d="M10 12h4M12 12v3"/></svg>' }
];

function ipEl(id) {
  return (typeof document !== 'undefined') ? document.getElementById(id) : null;
}

/* ---- 自定义模型库（localStorage：harbor_custom_models；config.json 零污染） ---- */
const CN_MODELS_KEY = 'harbor_custom_models';
function ipCustomModels() {
  try { return JSON.parse(localStorage.getItem(CN_MODELS_KEY) || '[]').filter(x => typeof x === 'string'); }
  catch (e) { return []; }
}
function ipCustomSave(list) {
  try { localStorage.setItem(CN_MODELS_KEY, JSON.stringify(list)); } catch (e) {}
}

/* ---- 推理偏好（复核批新增：思考强度 + 上下文窗口；model_prefs.json 独立文件） ----
 * 弹层内嵌两行偏好（用户点选即保存）；60-agent-loop 消费：thinking 非 auto
 * 手动锁定覆盖智能档，ctx_k 调自动压缩阈值。boot 时 modelPrefsRefresh 预载。 */
const IP_THINKING_LABELS = { auto: '自动（智能档）', off: '关闭', low: '低', medium: '中', high: '高' };
const IP_THINKING_ORDER = ['auto', 'off', 'low', 'medium', 'high'];
const IP_CTX_LABELS = { 0: '默认（200K）', 32: '32K', 128: '128K', 256: '256K', 300: '300K', 1024: '1M' };
const IP_CTX_ORDER = [0, 32, 128, 256, 300, 1024];
let __modelPrefs = { thinking: 'auto', ctx_k: 0 };

async function modelPrefsRefresh() {
  try {
    const d = JSON.parse(await callApi('model_prefs_get') || '{}');
    if (d && d.ok) {
      __modelPrefs = { thinking: d.thinking || 'auto', ctx_k: parseInt(d.ctx_k, 10) || 0 };
    }
  } catch (e) { /* 旧 exe 无此方法：保持默认 */ }
  return __modelPrefs;
}
function getModelPrefs() { return __modelPrefs; }
async function modelPrefsSave(patch) {
  const previous = __modelPrefs;
  __modelPrefs = Object.assign({}, previous, patch);
  try {
    const d = JSON.parse(await callApi('model_prefs_save', [JSON.stringify(__modelPrefs)]) || '{}');
    if (d && d.ok) return true;
    __modelPrefs = previous;
    const detail = d && d.error ? (d.error.message || d.error) : '后端未确认保存';
    toast('推理偏好保存失败: ' + detail, 'warn');
  } catch (e) {
    __modelPrefs = previous;
    toast('推理偏好保存失败: ' + (e && e.message || e), 'warn');
  }
  return false;
}
function ipCustomAdd(name) {
  const list = ipCustomModels();
  if (list.indexOf(name) === -1) { list.unshift(name); ipCustomSave(list); }
}
function ipCustomRemove(name) {
  ipCustomSave(ipCustomModels().filter(x => x !== name));
}

/* ---------- 「+」附件菜单 ---------- */
function ipPlusToggle() {
  const pop = ipEl('atPop');
  const mc = ipEl('mcPop');
  if (mc) mc.classList.remove('on');
  if (!pop) return;
  if (pop.classList.contains('on')) { pop.classList.remove('on'); return; }
  ipPlusRender();
  pop.classList.add('on');
}
function ipPlusRender() {
  const pop = ipEl('atPop');
  if (!pop) return;
  pop.innerHTML = PLUS_ITEMS.map(it =>
    '<button type="button" class="at-item" data-key="' + it.key + '">' +
    '<span class="at-ic">' + it.icon + '</span><span>' + it.label + '</span></button>').join('');
  pop.querySelectorAll('.at-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-key');
      const input = ipEl(key + 'Input');
      if (input) input.click();
      pop.classList.remove('on');
    });
  });
}

/* ---------- 模型选择 chip ---------- */
function ipModelCurrentName() {
  const sel = ipEl('modelSelect');
  if (sel && sel.selectedOptions && sel.selectedOptions[0]) {
    return sel.selectedOptions[0].textContent.trim() || '选择模型';
  }
  return '选择模型';
}
function ipModelRefresh() {
  const nameEl = ipEl('modelChipName');
  if (nameEl) nameEl.textContent = ipModelCurrentName();
}
function ipModelToggle() {
  const pop = ipEl('mcPop');
  const at = ipEl('atPop');
  if (at) at.classList.remove('on');
  if (!pop) return;
  if (pop.classList.contains('on')) { pop.classList.remove('on'); return; }
  ipModelRender();
  pop.classList.add('on');
}
function ipModelRender() {
  const pop = ipEl('mcPop');
  if (!pop) return;
  const sel = ipEl('modelSelect');
  const cur = sel ? sel.value : '';
  const esc = (t) => (typeof escapeHtml === 'function' ? escapeHtml(String(t)) : String(t));
  // 预设/识别模型（来自设置区模型流；__group__ → 分组头；__manual__ 手动输入项与
  // 空占位项跳过——2026-10-21 用户实测：未配 API 的手动输入选了也用不了，去掉）
  let rows = '';
  if (sel) {
    for (const opt of sel.options) {
      const v = opt.value || '';
      if (v === '__group__') {   // 分组头（connectFillModels 的 CONNECT_GROUP_VALUE）
        if (rows) rows += '<div class="mc-sec">' + esc(opt.textContent) + '</div>';
        continue;
      }
      if (v === '__manual__' || v === '') continue;   // 手动输入项 / 占位项
      if (ipCustomModels().indexOf(v) !== -1) continue;   // 自定义项不重复列
      rows += '<button type="button" class="mc-item' + (v === cur ? ' on' : '') +
        '" data-val="' + v.replace(/"/g, '&quot;') + '">' +
        '<span class="mc-name">' + esc(opt.textContent) + '</span>' +
        (v === cur ? '<span class="mc-check">✓</span>' : '') + '</button>';
    }
  }
  if (!rows) rows = '<div class="mc-empty">暂无预设模型，请先在设置中识别</div>';
  // 自定义模型区（可删）
  const customs = ipCustomModels();
  const customRows = customs.map(m =>
    '<div class="mc-item' + (m === cur ? ' on' : '') + '" data-val="' + esc(m) + '">' +
      '<span class="mc-name">' + esc(m) + '</span>' +
      (m === cur ? '<span class="mc-check">✓</span>' : '') +
      '<button type="button" class="mc-del" data-del="' + esc(m) + '" title="删除该自定义模型"><svg class="ui-icon ui-icon-16" aria-hidden="true"><use href="#i-close"/></svg></button>' +
    '</div>').join('');
  const thinkingOptions = IP_THINKING_ORDER.map(v =>
    '<option value="' + v + '"' + (__modelPrefs.thinking === v ? ' selected' : '') + '>' +
    esc(IP_THINKING_LABELS[v]) + '</option>').join('');
  const ctxOptions = IP_CTX_ORDER.map(v =>
    '<option value="' + v + '"' + (__modelPrefs.ctx_k === v ? ' selected' : '') + '>' +
    esc(IP_CTX_LABELS[v] || (v + 'K')) + '</option>').join('');
  pop.innerHTML = '<div class="mc-pop-head">选择模型</div>' +
    '<div class="mc-list">' + rows + '</div>' +
    (customs.length ? '<div class="mc-sec">自定义模型</div><div class="mc-list mc-custom-list">' + customRows + '</div>' : '') +
    // 推理偏好：显式下拉值，避免整行点击循环造成误选；保存失败回滚旧值。
    '<div class="mc-sec">推理偏好</div>' +
    '<label class="mc-item mc-pref"><span class="mc-name">思考强度</span>' +
      '<select class="mc-pref-select" data-pref="thinking" aria-label="思考强度">' + thinkingOptions + '</select></label>' +
    '<label class="mc-item mc-pref"><span class="mc-name">上下文窗口</span>' +
      '<select class="mc-pref-select" data-pref="ctx_k" aria-label="上下文窗口">' + ctxOptions + '</select></label>' +
    '<button type="button" class="mc-config">配置自定义模型 →</button>';

  // 明确选项 + 即改即存；失败时 modelPrefsSave 已回滚缓存，这里同步回滚控件。
  pop.querySelectorAll('.mc-pref-select').forEach(select => {
    select.addEventListener('change', async () => {
      const key = select.dataset.pref;
      const next = key === 'thinking' ? select.value : (parseInt(select.value, 10) || 0);
      select.disabled = true;
      try { await modelPrefsSave({ [key]: next }); }
      finally {
        select.disabled = false;
        select.value = String(__modelPrefs[key]);
      }
    });
  });

  // 选择（预设区 + 自定义区共用）
  pop.querySelectorAll('.mc-item[data-val]').forEach(btn => {
    if (btn.classList.contains('mc-add')) return;
    btn.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('.mc-del')) return;
      const val = btn.getAttribute('data-val');
      if (sel) {
        // Round 7 修复[5]：自定义模型值不在 modelSelect options 里（该区仅存
        // localStorage，select 无对应 option）——直接 sel.value=val 会把下拉置
        // 空，change 链路落盘 model:'auto' 静默覆盖原选择。无匹配则注入 option。
        if (![...sel.options].some(o => o.value === val)) {
          const opt = document.createElement('option');
          opt.value = val;
          opt.textContent = val;
          sel.appendChild(opt);
        }
        sel.value = val;
        // P1 复核修正：onModelChange 全项目不存在（typeof 守卫静默吞掉）——
        // 原选模型不派发 change 事件 → 设置区下拉标签/header 品牌位失步且
        // 选择不落盘；改派发 change 事件走 110-boot 绑定的正确链路
        sel.dispatchEvent(new Event('change'));
      }
      ipModelRefresh();
      pop.classList.remove('on');
    });
  });
  // 删除自定义模型
  pop.querySelectorAll('.mc-del').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      ipCustomRemove(btn.getAttribute('data-del'));
      ipModelRender();   // 重渲染（删除后若当前模型被删不切状态——仅从库移除）
    });
  });
  const cfg = pop.querySelector('.mc-config');
  if (cfg) cfg.addEventListener('click', () => {
    pop.classList.remove('on');
    ipGotoModelSettings();
  });
}

/** 跳设置「连接与模型」块：切面板 → 滚动入视 → 一次性闪光定位。 */
function ipGotoModelSettings() {
  // Harbor 无 settings 面板——设置是 chat 面板内的独立窗口（toggleSettings 打开）
  // Round 7 修复[7]：toggleSettings 是切换语义——设置窗已开时调用反而把它关掉，
  // 260ms 后的定位落在隐藏面板上（用户只看到设置关了）。仅在未开时打开。
  const panel = ipEl('settingsPanel');
  if (panel && !panel.classList.contains('show')) {
    if (typeof toggleSettings === 'function') toggleSettings();
  }
  setTimeout(() => {
    const block = ipEl('cmBlock');
    if (!block) return;
    if (typeof _showSetBlock === 'function') _showSetBlock('cmBlock');
    block.scrollIntoView({ behavior: (typeof MOTION !== 'undefined' && MOTION.instant()) ? 'auto' : 'smooth', block: 'start' });
    block.classList.remove('cn-flash');
    void block.offsetWidth;
    block.classList.add('cn-flash');
    setTimeout(() => block.classList.remove('cn-flash'), 1600);
  }, 260);   // 等面板切换淡入落位
}

/* ---------- 初始化 ---------- */
function inputPlusInit() {
  if (typeof document === 'undefined') return false;
  if (ipEl('atPop')) return true;
  const row = document.querySelector('.input-row');
  if (!row) return false;
  row.style.position = 'relative';
  // 「+」钮替换原 4 个附件钮的可见性（DOM 保留旧钮防 onclick 契约回归——
  //  改用 CSS 隐藏旧钮，新 + 钮复用同一批隐藏 file input）
  const plus = document.createElement('button');
  plus.type = 'button';
  plus.id = 'plusBtn';
  plus.className = 'tool-btn';
  plus.title = '添加附件';
  plus.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>';
  plus.addEventListener('click', (e) => { e.stopPropagation(); ipPlusToggle(); });
  const modeEl = ipEl('toolMode');
  const syncAttachmentEntry = () => {
    const allowed = !modeEl || !modeEl.value || modeEl.value === 'full';
    plus.disabled = !allowed;
    plus.title = allowed ? '添加附件'
      : (modeEl.value === 'off' ? '纯聊天模式不读取本地附件（切完整权限可用）'
        : '只读模式不新增本地附件（切完整权限可用）');
    if (!allowed) {
      const pop = ipEl('atPop');
      if (pop) pop.classList.remove('on');
    }
  };
  syncAttachmentEntry();
  if (modeEl) modeEl.addEventListener('change', syncAttachmentEntry);
  row.insertBefore(plus, row.firstChild);
  // 模型 chip（send 钮前）
  const send = ipEl('sendBtn');
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.id = 'modelChip';
  chip.className = 'model-chip';
  chip.title = '选择模型';
  chip.innerHTML = '<svg class="mc-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a4 4 0 0 1 4 4v1a4 4 0 0 1-1 2.6V14a4 4 0 0 1-8 0v-3.4A4 4 0 0 1 6 8V7a4 4 0 0 1 4-4z"/><path d="M8 21h8M12 18v3"/></svg>' +
    '<span id="modelChipName">选择模型</span>' +
    '<svg class="mc-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  chip.addEventListener('click', (e) => { e.stopPropagation(); ipModelToggle(); });
  if (send) row.insertBefore(chip, send); else row.appendChild(chip);
  // 两个浮层
  const atPop = document.createElement('div');
  atPop.id = 'atPop';
  atPop.className = 'at-pop';
  row.appendChild(atPop);
  const mcPop = document.createElement('div');
  mcPop.id = 'mcPop';
  mcPop.className = 'mc-pop';
  row.appendChild(mcPop);
  // 空白关闭
  document.addEventListener('click', (e) => {
    const at = ipEl('atPop'), mc = ipEl('mcPop');
    if (e.target.closest && (e.target.closest('#atPop') || e.target.closest('#plusBtn'))) return;
    if (at) at.classList.remove('on');
    if (e.target.closest && (e.target.closest('#mcPop') || e.target.closest('#modelChip'))) return;
    if (mc) mc.classList.remove('on');
  });
  ipModelRefresh();
  // 设置区模型流变化时同步 chip（connectFillModels 已存在——挂个轮询兜底太糙，
  //  改用 MutationObserver 监听 modelSelect 子列表与选中项）
  const sel = ipEl('modelSelect');
  if (sel && typeof MutationObserver !== 'undefined') {
    new MutationObserver(() => ipModelRefresh()).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    sel.addEventListener('change', () => ipModelRefresh());
  }
  return true;
}
