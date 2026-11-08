/* ================= 混合路由（v1.8.0 H 域，实现 v1.8.0 H2） =================
 * #hybridBlock + .hy-*（设置区）+ #costSplit（会话头部分账 chip）：
 * 策略三选 UI + 预算/置信门设置 + 分账 chip + saver 首次切换一次性提示。
 * 契约口径（联调规范 §2/§3.3 + §7 R3/R10 裁决 + ux-flows 流程 5/6）：
 * - 三态状态机 + 请求序号 last-wins（hybridReqSeq，同 36-connect 先例）；
 * - 配置读写：hybrid_get_config / hybrid_save_config（hybrid.json 独立文件，
 *   config.json 零污染）；source=default 时设置区显示「首次使用，已载入
 *   默认配置」轻提示（不弹模态）；
 * - 策略切换即时生效于下一回合（当回合不中断——ux-flows 流程 5⑤）；
 * - saver 首次切换一次性轻提示（R3 裁决：localStorage 标记，不设常驻
 *   「质量可能下降」chip、不做每次降级打扰）；#costSplit 分账 chip 常驻
 *   可见（本地/云端 token 与费用占比，用户自查）；
 * - 分账数据源：60-agent-loop 的 usage 到达时调 hybridOnUsage（既有 usage
 *   事件延长，架构 §4.2）；usage 缺失时 chip 隐藏（不显示 0/0 假象）；
 * - 数字格式（§4.3）：`本地 X tok · 云端 Y tok · 省 ≈¥Z`；X/Y 千分位整数；
 *   Z 两位小数；≥¥10000 显示 ≈¥9.9k（一位小数）；
 * - typeof 守卫（§2.5 vm 沙箱可测）：模块顶层不直接引用 window/document/
 *   localStorage；callApi 统一经 hyCallApi 四步。
 * 挂载：110-boot.js loadAll 内 try{ hybridInit(); }catch。
 */
const HY_CFG_TIMEOUT_MS = 15000;      // hybrid_get/save_config（§2.1 表）
const HY_FEATURE_KEY = 'glm_feat_hybrid_v18';
const HY_SAVER_HINT_KEY = 'glm_hybrid_saver_hinted_v18';   // R3：一次性提示标记
// 云端单价（¥/1k tokens）——与后端 hybrid_router.CLOUD_PRICE_PER_1K 逐字一致
const HY_CLOUD_PRICE_PER_1K = 0.002;
const HY_STRATEGY_TEXT = {
  auto: '自动（按任务分类路由：理解/校验走本地，规划/创作走云端）',
  saver: '省 token（优先本地，不可用自动回退云端）',
  quality: '质量优先（全云端）'
};

let hybridReqSeq = 0;          // last-wins 请求序号
let hybridState = 'idle';      // idle|pending|success|error
let hybridCfg = null;          // 最近一次配置载荷
// 分账累加（进程内；#costSplit 数据源。本地计费 ¥0 但计入统计）
let hybridSplit = { local_tokens: 0, cloud_tokens: 0 };

/* ---------- typeof 守卫取值（§2.5） ---------- */
function hyEl(id) {
  return (typeof document !== 'undefined') ? document.getElementById(id) : null;
}
function hyFeatureEnabled() {
  try {
    if (typeof localStorage === 'undefined') return true;
    const v = localStorage.getItem(HY_FEATURE_KEY);
    return v === null || v === '1';
  } catch (e) { return true; }
}
function hyCallApi(name, args, timeoutMs) {
  if (typeof callApi !== 'function') {
    throw new Error('pywebview bridge 未就绪: ' + name);
  }
  return callApi(name, args, timeoutMs);
}
function hyToast(msg, kind) {
  if (typeof toast === 'function') toast(msg, kind || 'info');
}
function hyEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------- 挂载（设置区 #hybridBlock + 会话头部 #costSplit） ---------- */
function hybridInit() {
  if (!hyFeatureEnabled()) return false;
  if (hyEl('hybridBlock')) {
    // 幂等重入：接线（同 63-search-panel searchPanelWire 先例——vm 沙箱
    // getElementById 自动注册时也保证 change 处理器就位）
    hybridWire();
  } else if (typeof document !== 'undefined') {
    const grid = document.querySelector('.set-grid');
    if (grid) {
      const block = document.createElement('div');
      block.id = 'hybridBlock';
      block.className = 'set-block';
      block.innerHTML =
        '<div class="set-title">混合路由（v1.8.0）</div>' +
        '<div class="set-hint hy-first-hint" id="hyFirstHint" style="display:none;"></div>' +
        '<div class="set-hint" style="margin:2px 0 8px;">' +
          '本地模型（Ollama/LM Studio 等）与云端协同：理解/校验类步骤优先本地，' +
          '规划/创作类走云端；本地超时或不可用自动回退云端（当回合不中断）。' +
          '配置存于 <code>~/.glm-chat/hybrid.json</code>（独立文件，不碰 config.json）。' +
        '</div>' +
        '<label>路由策略</label>' +
        '<div class="provider-row">' +
          '<select id="hyStrategy" style="flex:1;">' +
            '<option value="auto">auto（自动分类路由）</option>' +
            '<option value="saver">saver（省 token）</option>' +
            '<option value="quality">quality（质量优先）</option>' +
          '</select>' +
        '</div>' +
        '<div class="hy-strategy-desc" id="hyStrategyDesc"></div>' +
        '<label>本地硬预算（超即降级云端，秒）</label>' +
        '<div class="provider-row">' +
          '<span style="width:150px;font-size:12px;color:var(--text-2);flex-shrink:0;">理解 understand</span>' +
          '<input class="hy-input" id="hyBudgetUnderstand" type="number" min="1" max="30" step="1" style="width:90px;">' +
          '<span style="width:150px;font-size:12px;color:var(--text-2);flex-shrink:0;">校验 validate</span>' +
          '<input class="hy-input" id="hyBudgetValidate" type="number" min="1" max="30" step="1" style="width:90px;">' +
        '</div>' +
        '<label>置信门（分类置信低于门限 → 升级云端）</label>' +
        '<div class="provider-row">' +
          '<input class="hy-input" id="hyConfGate" type="number" min="0.5" max="0.95" step="0.05" style="width:90px;">' +
          '<label class="check-row" style="margin-left:12px;">' +
            '<input type="checkbox" id="hyCostSplitDisplay"> 显示会话分账 chip' +
          '</label>' +
        '</div>' +
        '<div class="provider-row" style="margin-top:8px;">' +
          '<span class="hy-light" id="hyStatusLight"></span>' +
          '<span id="hyStatusText" style="font-size:12px;color:var(--text-2);"><span class="load-dot"></span>读取中…</span>' +
        '</div>' +
        '<div class="provider-row" style="margin-top:8px;align-items:center;gap:8px;">' +
          '<button type="button" class="modal-btn" id="hyReadinessBtn">检测本地模型就绪度</button>' +
          '<span class="hy-light" id="hyRdLight" style="display:none;"></span>' +
          '<span id="hyRdVerdict" style="font-size:12px;color:var(--text-2);"></span>' +
        '</div>' +
        '<div class="rd-list" id="hyRdList" style="display:none;"></div>';
      grid.appendChild(block);
      hybridWire();
    }
  }
  // 会话头部分账 chip（纯新增；usage 到达时刷新，缺失时隐藏）
  if (!hyEl('costSplit') && typeof document !== 'undefined') {
    const right = document.querySelector('.header-right');
    if (right) {
      const chip = document.createElement('span');
      chip.id = 'costSplit';
      chip.className = 'hy-cost';
      chip.style.display = 'none';
      chip.textContent = '';
      right.appendChild(chip);
    }
  }
  if (typeof collaborationUiInit === 'function') collaborationUiInit();
  hybridRefresh();
  return true;
}
function hybridWire() {
  const rdBtn = hyEl('hyReadinessBtn');
  if (rdBtn) rdBtn.addEventListener('click', () => hybridReadinessRun());
  const strategy = hyEl('hyStrategy');
  if (strategy) strategy.addEventListener('change', () => {
    hybridSave({ strategy: strategy.value });
    // R3 裁决：saver 首次切换一次性轻提示（localStorage 标记，不每次打扰）
    if (strategy.value === 'saver') {
      try {
        if (typeof localStorage !== 'undefined' &&
            !localStorage.getItem(HY_SAVER_HINT_KEY)) {
          localStorage.setItem(HY_SAVER_HINT_KEY, '1');
          hyToast('已切省 token 模式：本地不可用时自动回退云端；' +
                  '分账可在会话头部查看。', 'info');
        }
      } catch (e) { /* 沙箱无 localStorage：跳过提示 */ }
    }
    hybridRenderStrategyDesc(strategy.value);
  });
  ['hyBudgetUnderstand', 'hyBudgetValidate', 'hyConfGate'].forEach(id => {
    const el = hyEl(id);
    if (el) el.addEventListener('change', () => {
      const patch = {};
      // 字段级校验（防 NaN 直传后端：number input 清空/手输非法值时不静默坏数据）
      if (id === 'hyBudgetUnderstand') {
        const v = parseInt(el.value, 10);
        if (!Number.isInteger(v) || v < 1 || v > 30) {
          hyToast('本地硬预算需为 1-30 的整数（秒）', 'warn');
          hyRevertField(el, 'local_budget_understand_s'); return;
        }
        patch.local_budget_understand_s = v;
      }
      if (id === 'hyBudgetValidate') {
        const v = parseInt(el.value, 10);
        if (!Number.isInteger(v) || v < 1 || v > 30) {
          hyToast('本地硬预算需为 1-30 的整数（秒）', 'warn');
          hyRevertField(el, 'local_budget_validate_s'); return;
        }
        patch.local_budget_validate_s = v;
      }
      if (id === 'hyConfGate') {
        const v = parseFloat(el.value);
        if (!(v >= 0.5 && v <= 0.95)) {
          hyToast('置信门需为 0.5-0.95 之间的小数', 'warn');
          hyRevertField(el, 'confidence_gate'); return;
        }
        patch.confidence_gate = v;
      }
      hybridSave(patch);
    });
  });
  const splitDisp = hyEl('hyCostSplitDisplay');
  if (splitDisp) splitDisp.addEventListener('change', () => {
    hybridSave({ cost_split_display: splitDisp.checked });
    hybridRenderSplit();
  });
}

/* ---------- 三态 + last-wins：配置读取 ---------- */
/* 字段级校验失败的回弹：仅复位犯规字段（配置已加载时）——原实现整表
   hybridRefresh()，异步返回时会把用户正在其它字段输入的内容一并清掉
   （刷新重渲染所有输入框）；无已加载配置才回落全量刷新。 */
function hyRevertField(el, key) {
  if (el && hybridCfg && hybridCfg[key] != null) { el.value = hybridCfg[key]; return; }
  hybridRefresh();
}
async function hybridRefresh() {
  const seq = ++hybridReqSeq;
  try {
    const raw = await hyCallApi('hybrid_get_config', [], HY_CFG_TIMEOUT_MS);
    if (seq !== hybridReqSeq) return;               // ④last-wins
    const d = JSON.parse(raw || '{}');
    if (d && d.ok) {
      hybridCfg = d.config || {};
      hybridRenderConfig(d.config, d.source);
      hybridState = 'success';
    } else {
      hybridRenderError((d && d.error) || { code: 'INTERNAL', message: '读取配置失败' });
      hybridState = 'error';
    }
  } catch (e) {
    if (seq !== hybridReqSeq) return;
    hybridRenderError({ code: 'BRIDGE_TIMEOUT', message: (e && e.message) || String(e) });
    hybridState = 'error';
  }
}

/* ---------- 保存（部分更新语义；失败回弹 UI 到当前配置） ---------- */
async function hybridSave(patch) {
  const seq = ++hybridReqSeq;
  try {
    const raw = await hyCallApi('hybrid_save_config', [patch || {}], HY_CFG_TIMEOUT_MS);
    if (seq !== hybridReqSeq) return;
    const d = JSON.parse(raw || '{}');
    if (d && d.ok && d.config) {
      hybridCfg = d.config;
      hybridRenderConfig(d.config, 'file');
      hybridState = 'success';
    } else {
      const e = (d && d.error) || { code: 'INTERNAL', message: '保存失败' };
      hyToast('混合路由配置保存失败: ' + (e.message || ''), 'err');
      if (hybridCfg) hybridRenderConfig(hybridCfg, 'file');   // 回弹
      hybridState = 'error';
    }
  } catch (e) {
    if (seq !== hybridReqSeq) return;
    hyToast('混合路由配置保存失败: ' + ((e && e.message) || String(e)), 'err');
    // 桥接层异常同属失败：回弹 UI 到当前配置（防表单停留在未保存的脏值）
    if (typeof hybridCfg !== 'undefined' && hybridCfg) hybridRenderConfig(hybridCfg, 'file');
    hybridState = 'error';
  }
}

/* W5E4 collaboration configuration uses the existing hybrid_save_config API. */
async function collaborationHybridSave(patch) {
  const raw = await hyCallApi('hybrid_save_config', [patch || {}], HY_CFG_TIMEOUT_MS);
  const data = JSON.parse(raw || '{}');
  if (!data || !data.ok || !data.config) {
    const error = new Error((data && data.error && data.error.message) || '协同配置保存失败');
    error.code = data && data.error && data.error.code || 'COLLABORATION_SAVE_FAILED';
    throw error;
  }
  hybridCfg = data.config;
  hybridRenderConfig(data.config, 'file');
  return data.config;
}

/* ---------- 渲染 ---------- */
function hybridRenderConfig(cfg, source) {
  const strategy = hyEl('hyStrategy');
  if (strategy) strategy.value = cfg.strategy || 'auto';
  hybridRenderStrategyDesc(cfg.strategy || 'auto');
  const bu = hyEl('hyBudgetUnderstand');
  if (bu) bu.value = cfg.local_budget_understand_s;
  const bv = hyEl('hyBudgetValidate');
  if (bv) bv.value = cfg.local_budget_validate_s;
  const cg = hyEl('hyConfGate');
  if (cg) cg.value = cfg.confidence_gate;
  const sd = hyEl('hyCostSplitDisplay');
  if (sd) sd.checked = cfg.cost_split_display !== false;
  const hint = hyEl('hyFirstHint');
  if (hint) {
    if (source === 'default') {
      hint.style.display = '';
      hint.textContent = '首次使用，已载入默认配置（strategy=auto · 理解 5s / 校验 3s · 置信门 0.7）。';
    } else {
      hint.style.display = 'none';
    }
  }
  const light = hyEl('hyStatusLight');
  if (light) light.className = 'hy-light ' + (source === 'default' ? 'warn' : 'ok');
  const txt = hyEl('hyStatusText');
  if (txt) txt.textContent = source === 'default' ? '默认配置（未落盘过）' : '已保存';
  hybridRenderSplit();
  if (typeof collaborationUiRenderConfig === 'function' && hyEl('collaborationBlock')) {
    collaborationUiRenderConfig(cfg.collaboration || null);
  }
}
function hybridRenderStrategyDesc(strategy) {
  const el = hyEl('hyStrategyDesc');
  if (el) el.textContent = HY_STRATEGY_TEXT[strategy] || '';
}
function hybridRenderError(e) {
  const txt = hyEl('hyStatusText');
  if (txt) txt.textContent = (e && e.message) || '配置读取失败';
  const light = hyEl('hyStatusLight');
  if (light) light.className = 'hy-light miss';
}

/* ---------- 分账 chip（#costSplit；usage 到达时刷新，缺失时隐藏） ---------- */
function hybridOnUsage(usage, model) {
  // 60-agent-loop usage 收口时调用（架构 §4.2「usage 事件延长」）。
  // 本地/云端按当前模式判定（localModeActive → 本地）；无 usage 或
  // token 为 0 时不累计（不显示 0/0 假象）。数字滚动由 CSS 过渡承担。
  const tok = usage ? (usage.completion_tokens || usage.total_tokens || 0) : 0;
  if (!tok) return;
  const isLocal = (typeof localModeActive === 'function') && localModeActive();
  if (isLocal) hybridSplit.local_tokens += tok;
  else hybridSplit.cloud_tokens += tok;
  hybridRenderSplit();
}
function hyFmtInt(n) {
  // 千分位整数（12,345）
  return String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function hyFmtMoney(y) {
  // ≥¥10000 → ≈¥9.9k（一位小数）；否则两位小数
  const v = Number(y || 0);
  if (v >= 10000) return '≈¥' + (v / 1000).toFixed(1) + 'k';
  return '≈¥' + v.toFixed(2);
}
function hybridRenderSplit() {
  const chip = hyEl('costSplit');
  if (!chip) return;
  const enabled = !hybridCfg || hybridCfg.cost_split_display !== false;
  if (!enabled) { chip.style.display = 'none'; return; }
  const lt = hybridSplit.local_tokens || 0;
  const ct = hybridSplit.cloud_tokens || 0;
  if (lt + ct <= 0) { chip.style.display = 'none'; return; }   // usage 缺失 → 隐藏
  const saved = lt / 1000 * HY_CLOUD_PRICE_PER_1K;
  chip.style.display = '';
  hyCountUpChip(chip, lt, ct, saved);
  chip.title = '本地 tok 计费 ¥0（计入统计）；节省 = 本地 tok × 云端单价';
}

/* 分账数字滚动（motion-spec §1-6：count-up 600ms MOTION.count()；
   fx-off/reduced-motion 早退终值——JS prefersReduced 分支同 78-analytics 先例）。
   CSS transition 对 textContent 无效，必须 rAF。 */
let _hyChipAnim = null;
function hyCountUpChip(chip, lt, ct, saved) {
  const toL = Math.round(lt || 0), toC = Math.round(ct || 0);
  const money = '省 ' + hyFmtMoney(saved);
  if (typeof MOTION === 'undefined' || MOTION.instant() || MOTION.prefersReduced()) {
    chip.textContent = '本地 ' + hyFmtInt(toL) + ' tok · 云端 ' + hyFmtInt(toC) + ' tok · ' + money;
    return;
  }
  const from = (typeof _hyChipAnim === 'object' && _hyChipAnim) || { l: 0, c: 0 };
  if (_hyChipAnim && _hyChipAnim.raf) cancelAnimationFrame(_hyChipAnim.raf);
  const t0 = performance.now(), dur = MOTION.count();
  _hyChipAnim = { l: toL, c: toC, raf: 0 };
  const tick = () => {
    const p = Math.min(1, (performance.now() - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    const cl = Math.round(from.l + (toL - from.l) * e);
    const cc = Math.round(from.c + (toC - from.c) * e);
    chip.textContent = '本地 ' + hyFmtInt(cl) + ' tok · 云端 ' + hyFmtInt(cc) + ' tok · ' + money;
    if (p < 1) _hyChipAnim.raf = requestAnimationFrame(tick);
  };
  _hyChipAnim.raf = requestAnimationFrame(tick);
}
function hybridResetSplit() {
  hybridSplit = { local_tokens: 0, cloud_tokens: 0 };
  hybridRenderSplit();
}


/* ---------- W2 就绪度检测（2026-10-21 补前端面板；后端 local_readiness 现成） ----------
 * 8 项评分 + verdict（full 本地可跑/partial 部分阶段交云端/cloud 全云端）+ 低分建议。 */
let hyRdSeq = 0;          // 就绪度检测 last-wins（同 hybridReqSeq 先例）
function hyRdEl(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
async function hybridReadinessRun() {
  const btn = hyRdEl('hyReadinessBtn');
  const list = hyRdEl('hyRdList');
  const vd = hyRdEl('hyRdVerdict');
  const light = hyRdEl('hyRdLight');
  if (!btn || !list) return;
  // 仅本地系预设可检测（云端预设端点不是本机模型服务，检测无意义）
  if (typeof connectIsLocalPreset === 'function' && !connectIsLocalPreset()) {
    if (typeof toast === 'function') toast('请先在「连接」中切换到本地模型预设（Ollama/LM Studio 等）', 'warn');
    return;
  }
  const baseInp = document.getElementById('localBaseUrl') || document.getElementById('providerBase');
  const modelInp = document.getElementById('localModelSelect') || document.getElementById('modelSelect');
  const base = ((baseInp && baseInp.value) || '').trim();
  const model = ((modelInp && modelInp.value) || '').trim();
  if (!base) { if (typeof toast === 'function') toast('请先在「连接」中填写端点地址', 'warn'); return; }
  const seq = ++hyRdSeq;
  btn.disabled = true; btn.textContent = '检测中…';
  list.style.display = 'none'; vd.textContent = '';
  if (light) light.style.display = 'none';
  try {
    const raw = await callApi('local_readiness', [base, model], 45000);
    if (seq !== hyRdSeq) return;               // last-wins：旧检测静默丢弃
    const r = JSON.parse(raw || '{}');
    if (!r || !r.ok) { if (typeof toast === 'function') toast('检测失败', 'err'); return; }
    const VD = { full: ['ok', '可全本地'], partial: ['warn', '部分阶段交云端'], cloud: ['err', '建议全云端'] };
    const v = VD[r.verdict] || VD.cloud;
    vd.textContent = '就绪度 ' + r.score + '/' + r.max + ' · ' + v[1] +
      (r.model ? ' · ' + r.model : '');
    if (light) { light.className = 'hy-light ' + v[0]; light.style.display = ''; }
    const esc = (t) => (typeof escapeHtml === 'function' ? escapeHtml(String(t)) : String(t));
    list.innerHTML = (r.items || []).map(it =>
      '<div class="rd-row"><span class="rd-dot ' + (it.ok ? 'ok' : 'miss') + '"></span>' +
      '<span class="rd-name">' + esc(it.name || '') + '</span>' +
      '<span class="rd-score">' + esc(it.score) + '/' + esc(it.max) + '</span>' +
      '<span class="rd-detail">' + esc(it.detail || '') + '</span></div>'
    ).join('') + ((r.suggestions || []).length
      ? '<div class="rd-sug">建议：' + esc(r.suggestions.join('；')) + '</div>' : '');
    list.style.display = '';
  } catch (e) {
    if (seq !== hyRdSeq) return;
    if (typeof toast === 'function') toast('检测失败：' + ((e && e.message) || e), 'err');
  } finally {
    if (seq === hyRdSeq) { btn.disabled = false; btn.textContent = '检测本地模型就绪度'; }
  }
}
