/* ================= v1.5 本地模型（合并后：并入「连接与模型」单块） =================
 * 覆盖 roadmap 连接层 A（A1-A5）：预设 / 探测 / 模型清单 / 元数据展示 / 本地计费 / 无 Key 测试连接。
 * 适配层 B（B1-B5）判定接口已就绪（后端 local_model_service）：上下文窗口自适应阈值 /
 * 工具能力降级 / 慢推理状态 / Ollama 特情 / 本地 MCP 保守策略。
 *
 * v4「完全单端点」合并后本模块的定位变化：
 * - 本地服务器不再是独立模式，而是 PRESETS 里的本地系预设（ollama/lmstudio/vllm/
 *   llamacpp/localai）——端点开关由 36-connect.js 的预设状态机统一决定；
 * - 本模块只保留「本地专属」能力：并行端口探测 / 模型清单（带 ctx 元数据）/ 免 Key
 *   测试连接 / ctx 徽标 / 本地压缩阈值；控件已并入合并块（探测按钮 = 识别按钮同一颗，
 *   模型下拉 = modelSelect，ctx 徽标 = cmCtxBadge）；
 * - 运行态仍由 localState 承载（36-connect 的 connectSyncState 从预设 + local_* 键派生），
 *   60-agent-loop 的本地模型分支因此继续有效。
 *
 * 契约红线：
 * - js_api：local_probe / local_models / test_provider_endpoint(local=true)（均已登记 _V12_EXTRA）；
 * - 配置：local_* 键经 collectLocalConfig → save_config 合并（运行期合法、测试期不触发）；
 * - DOM：合并块沿用 v1.5 id 语义的子集（localProbeResult/localToolCapable/localCtxWindow
 *   原样保留）；已并入合并块的控件经 localEl() 双 id 解析（老 id 优先，回落合并块 id），
 *   单元/联调沙箱（只加载本模块 + 老 id）与真实合并块（新 id）都能工作。
 */
let localState = { mode: false, base_url: '', model: '', ctx_window: 0, tool_capable: 'auto' };

/* 预设表（与后端 LOCAL_PRESETS 同源；UI 一键填充 + 本地零费语义）。
 * 合并后 UI 的预设下拉由 36-connect.js 的 PRESETS 提供，本表保留为数据源/兼容引用。 */
const LOCAL_UI_PRESETS = {
  ollama:  { name: 'Ollama',          base_url: 'http://localhost:11434/v1' },
  lmstudio:{ name: 'LM Studio',       base_url: 'http://localhost:1234/v1' },
  vllm:    { name: 'vLLM',            base_url: 'http://localhost:8000/v1' },
  llamacpp:{ name: 'llama.cpp server',base_url: 'http://localhost:8080/v1' },
  localai: { name: 'LocalAI',         base_url: 'http://localhost:8080/v1' },
  custom:  { name: '自定义',           base_url: '' }
};

/** 合并块 id 解析：老 id（v1.5 独立区块 / 单模块沙箱）优先，回落合并块 id。 */
function localEl(legacyId, mergedId) {
  const legacy = legacyId ? document.getElementById(legacyId) : null;
  if (legacy) return legacy;
  return mergedId ? document.getElementById(mergedId) : null;
}

/** 识别/探测按钮复位：单模块沙箱（老 id 存在）→ v1.5 原文案；
 *  真实合并块（老 id 都不存在）→ 当前预设的按钮文案。 */
function localRestoreIdentifyBtn(btn, legacyText) {
  if (!btn) return;
  btn.disabled = false;
  const merged = !document.getElementById('localProbeBtn') && !document.getElementById('localModelsBtn');
  btn.textContent = (merged && typeof connectIdentifyLabel === 'function')
    ? connectIdentifyLabel() : legacyText;
}

function loadLocalUI(cfg) {
  cfg = cfg || {};
  /* 合并后端点信息（base_url/model/mode）由 connectLoadFromConfig 统一回填，
     本函数只负责「本地专属项」：ctx 覆盖 / 工具调用偏好（local_* 键）。 */
  const ctx = parseInt(cfg.local_ctx_window, 10) || 0;
  const tool = cfg.local_tool_capable || 'auto';
  const ctxEl = localEl('localCtxWindow', 'localCtxWindow');
  if (ctxEl) ctxEl.value = ctx;
  const toolEl = localEl('localToolCapable', 'localToolCapable');
  if (toolEl) toolEl.value = tool;
  localState.ctx_window = ctx;
  localState.tool_capable = tool;
  applyLocalMetaBadge();
}

function collectLocalConfig() {
  const g = id => (document.getElementById(id) || {}).value || '';
  const isLocal = (typeof connectIsLocalPreset === 'function')
    ? connectIsLocalPreset()
    : !!(localState && localState.mode);
  const preset = (typeof connectCurrentPreset === 'function') ? connectCurrentPreset() : '';
  const base = (typeof connectBaseUrl === 'function') ? connectBaseUrl() : (localState.base_url || '');
  const model = (typeof connectModelValue === 'function') ? connectModelValue() : (localState.model || '');
  return {
    /* 本地专属项（设计书 D5：ctx/工具继续写 local_*，与 provider_* 并列不互斥） */
    local_ctx_window: parseInt(g('localCtxWindow'), 10) || 0,
    local_tool_capable: g('localToolCapable') || 'auto',
    /* 兼容键（v1.5 老配置可被老版本回读；仅在本地系预设时携带实际端点） */
    local_mode: !!isLocal,
    local_preset: isLocal ? preset : 'custom',
    local_base_url: isLocal ? base : '',
    local_model: isLocal ? model : ''
  };
}

function applyLocalConfig() {
  localState.ctx_window = connectCtxWindowSafe();
  localState.tool_capable = (document.getElementById('localToolCapable') || {}).value || 'auto';
  applyLocalMetaBadge();
}

/** ctx 覆盖读取（无 36-connect 时直接读元素）。 */
function connectCtxWindowSafe() {
  const el = localEl('localCtxWindow', 'localCtxWindow');
  return el ? (parseInt(el.value, 10) || 0) : 0;
}

/** 合并后无独立「启用本地模式」勾选：本地系预设即生效（保留函数供旧调用点）。 */
function syncLocalUiState() {
  const wrap = document.getElementById('localFields');
  if (wrap && wrap.style) wrap.style.display = '';
}

/** 旧签名兼容：本地预设切换统一走合并块预设状态机。 */
function onLocalPresetChange(v) {
  if (typeof connectApplyPreset === 'function') { connectApplyPreset(v, { animate: true }); return; }
  const p = LOCAL_UI_PRESETS[v] || LOCAL_UI_PRESETS.custom;
  const base = localEl('localBaseUrl', 'providerBase');
  if (base && p.base_url) base.value = p.base_url;   // custom 不覆盖手输
  applyLocalMetaBadge();
}

/* ---- 元数据徽标（后端 model_meta 三级来源：精确表 → 前缀启发式 → 保守默认） ---- */
function applyLocalMetaBadge() {
  const badge = localEl('localMetaBadge', 'cmCtxBadge');
  if (!badge) return;
  /* 合并后徽标只在本地系预设下有意义（GLM/云端预设由计费与价格表接管） */
  const isLocal = (typeof connectIsLocalPreset === 'function') ? connectIsLocalPreset() : true;
  if (badge.style) badge.style.display = isLocal ? '' : 'none';
  if (!isLocal) return;
  const sel = localEl('localModelSelect', 'modelSelect');
  const model = localState.model || (sel || {}).value || '';
  if (!model) { badge.textContent = '元数据待获取'; badge.className = 'local-badge'; return; }
  const ctx = localState.ctx_window > 0 ? localState.ctx_window : null;
  const meta = localMetaCache[model];
  if (meta) {
    const w = ctx || meta.ctx_window;
    const toolTxt = localState.tool_capable === 'off' ? '工具关'
      : localState.tool_capable === 'on' ? '工具开'
      : (meta.tool_capable ? '工具可用' : '工具存疑');
    // 修复 ㊾（三轮）：ctx 徽标取整——原 20000/1024=19.53k 直接拼小数，与
    // 36-connect 侧 Math.round 口径不一（两套舍入）。统一走 formatCtx() 一处
    // （80-utils 定义；typeof 守卫保 vm 单模块沙箱只加载本文件时可测）
    const _ctxTxt = (typeof formatCtx === 'function') ? formatCtx(w)
      : (w >= 1024 ? Math.round(w / 1024) + 'k' : String(w));
    badge.textContent = '窗口 ' + _ctxTxt + (meta.estimated ? '（估）' : '') + ' · ' + toolTxt;
    badge.className = 'local-badge ' + (meta.tool_capable ? 'on' : 'warn');
  } else {
    const _ctxTxt2 = (typeof formatCtx === 'function') ? formatCtx(ctx)
      : (ctx >= 1024 ? Math.round(ctx / 1024) + 'k' : String(ctx));   // 修复 ㊾（三轮）：同上统一入口
    badge.textContent = ctx > 0 ? ('窗口 ' + _ctxTxt2 + '（手设）') : '元数据待获取';
    badge.className = 'local-badge';
  }
}
let localMetaCache = Object.create(null);   // model -> {ctx_window, tool_capable, estimated}（null 原型：防 __proto__/constructor 等键踩原型链）

/* ---- A2：并行探测（4 端口并行，各 2s 超时，总墙钟 ≤1s 目标） ---- */
// 修复 54（三轮）：busy 守卫——防抖自动识别（connectScheduleIdentify 800ms）可能在
// 手动探测在途时触发第二轮 localProbeNow（并发探测 → 重复 toast + 按钮标签竞态
// 「探测本机」vs「拉取模型清单」+ 双重 localLoadModels）
let _localProbeBusy = false;
async function localProbeNow() {
  if (_localProbeBusy) { toast('本地探测正在进行中，请稍候…', 'warn'); return; }
  _localProbeBusy = true;
  try {
  const btn = localEl('localProbeBtn', 'cmIdentifyBtn');
  const box = localEl('localProbeResult', 'localProbeResult');
  if (btn) { btn.disabled = true; btn.textContent = '探测中…'; }
  try {
    const r = JSON.parse(await callApi('local_probe', []));
    if (box) box.innerHTML = '';
    if (!r.ok) { toast('探测失败：' + (r.error || ''), 'err'); return; }
    localMetaCache = Object.create(null);    // 新探测结果 → 元数据缓存失效（null 原型同上）
    // 修复 54（三轮）：reachable 改 for...of + await——原 forEach 内 localLoadModels
    // 火跑不 await（无 .catch 兜底虽不会 unhandled rejection——其内部全捕获，但结果
    // 顺序/按钮标签恢复时序与探测竞态；await 后串行确定）
    for (const it of (r.reachable || [])) {
      const row = document.createElement('div');
      row.className = 'local-probe-item ok';
      row.innerHTML = '<span class="dot"></span><span></span><span class="models"></span>';
      row.children[1].textContent = it.base_url + '（' + it.kind + ' · ' + it.latency_ms + 'ms）';
      row.children[2].textContent = (it.models || []).length + ' 个模型';
      if (box) box.appendChild(row);
      /* 命中预设 → 一键填充 base_url 并拉清单 */
      if (it.kind !== 'custom') {
        const base = localEl('localBaseUrl', 'providerBase');
        if (base) base.value = it.base_url;
        /* 合并块：探测到的服务器类型即当前预设（label/条件显隐随之对齐） */
        if (typeof connectApplyPreset === 'function' && typeof PRESETS === 'object'
            && PRESETS[it.kind] && PRESETS[it.kind].local
            && typeof connectCurrentPreset === 'function' && connectCurrentPreset() !== it.kind) {
          await connectApplyPreset(it.kind, { animate: false, base: it.base_url, quiet: true });
          // quiet 预设不落盘（36-connect connectApplyPresetNow 对 quiet 跳过
          // queueSaveConfig）——探测命中后补存 + 同步，让 Base URL 真正写盘
          if (typeof connectSyncState === 'function') connectSyncState();
          if (typeof queueSaveConfig === 'function') queueSaveConfig();
        }
        await localLoadModels(it.base_url);
      }
    }
    (r.unreachable || []).forEach(it => {
      const row = document.createElement('div');
      row.className = 'local-probe-item';
      row.innerHTML = '<span class="dot"></span><span></span>';
      row.children[1].textContent = it.base_url + ' — ' + (it.error || '不可达');
      if (box) box.appendChild(row);
    });
    const hit = (r.reachable || []).length;
    toast(hit ? '探测到 ' + hit + ' 个本地服务器' : '未探测到本地服务器（' + r.elapsed_ms + 'ms）', hit ? 'ok' : 'warn');
    if (typeof connectSyncState === 'function') connectSyncState();
    applyLocalMetaBadge();
  } catch (e) {
    toast('探测失败：' + e.message, 'err');
  } finally {
    localRestoreIdentifyBtn(btn, '探测本机');
  }
  } finally {
    _localProbeBusy = false;
  }
}

/* ---- A3：补拉模型清单（探测过期时用；返回 {id, ctx_window, tool_capable, estimated}） ---- */
// 实现 v1.6 W33：last-wins 序号——多服务器探测/探测途中改 Base URL 时，旧 base 的
// 清单回来不得覆盖新 base 的清单/缓存/下拉（原无序号：并发或乱序返回即错配）
let _localLoadSeq = 0;
async function localLoadModels(baseUrl) {
  const baseInp = localEl('localBaseUrl', 'providerBase');
  const base = (baseUrl || (baseInp || {}).value || '').trim();
  if (!base) { toast('请先填写 Base URL', 'warn'); return; }
  const seq = ++_localLoadSeq;
  const btn = localEl('localModelsBtn', 'cmIdentifyBtn');
  if (btn) { btn.disabled = true; btn.textContent = '拉取中…'; }
  try {
    /* 本地端点免 Key（云端清单鉴权走 36-connect 的识别通道带 Key） */
    const r = JSON.parse(await callApi('local_models', [base]));
    // 实现 v1.6 W33：序号陈旧（已发起更新的加载）或 Base URL 已被切走 → 丢弃结果，
    // 不清空缓存/不改下拉（防错配：旧服务器清单覆盖新服务器状态）
    if (seq !== _localLoadSeq) return;
    const curBase = ((localEl('localBaseUrl', 'providerBase') || {}).value || '').trim();
    if (curBase && curBase !== base) return;
    if (!r.ok) { toast('获取模型清单失败：' + (r.error || ''), 'err'); return; }
    const models = r.models || [];
    localMetaCache = Object.create(null);
    models.forEach(m => { localMetaCache[m.id] = m; });
    refreshLocalModelOptions(models.map(m => m.id), localState.model);
    applyLocalMetaBadge();
    if (document.getElementById('localModelSelect') && typeof CS !== 'undefined' && CS.syncAll) CS.syncAll();
    toast('已获取 ' + models.length + ' 个模型', 'ok');
  } catch (e) {
    toast('获取模型清单失败：' + e.message, 'err');
  } finally {
    // 修复（round4 遗留·对抗复审）：原 finally 无条件复位按钮——陈旧请求
    // （seq 已被更新的加载超过）返回时，会把在途新请求的「拉取中…」禁用态
    // 按钮复位成空闲态（新请求还在跑，按钮却可再点 → 并发第三轮加载）。
    // 加 seq 判定：只有「我仍是当前加载」才复位；按钮所有权归最新请求。
    if (seq === _localLoadSeq) localRestoreIdentifyBtn(btn, '拉取模型清单');
  }
}

/** 清单 → 模型下拉。
 *  真实合并块（无 localModelSelect 元素）：走 connectFillModels（智能档/分组/ctx 徽标/
 *  末项手动态）；单模块沙箱（有 localModelSelect）：保持 v1.5 的纯 option 列表语义。 */
function refreshLocalModelOptions(ids, keep) {
  const legacySel = document.getElementById('localModelSelect');
  const sel = legacySel || document.getElementById('modelSelect');
  if (!sel) return;
  const list = (ids || []).slice();
  if (!legacySel && typeof connectFillModels === 'function') {
    /* 合并块：识别/探测成功即以下拉结果为准（旧预设猜测值只在新清单里仍存在时保留） */
    const cur = String(sel.value || '');
    connectFillModels(list.map(id => ({
      id: id, text: id,
      badge: localMetaCache[id] ? connectCtxBadgeSafe(localMetaCache[id]) : ''
    })), { auto: false, group: list.length ? '识别结果' : '',
          keep: (cur && list.indexOf(cur) !== -1) ? cur : '' });
    applyLocalMetaBadge();
    return;
  }
  const prev = keep || sel.value;
  sel.innerHTML = '';
  list.forEach(id => {
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = id;
    sel.appendChild(opt);
  });
  if (prev && list.includes(prev)) sel.value = prev;
  else if (list.length) sel.value = list[0];
  applyLocalMetaBadge();
}

/** ctx 徽标文本（36-connect 未加载时的本地实现，语义同 connectCtxBadge）。 */
function connectCtxBadgeSafe(meta) {
  if (typeof connectCtxBadge === 'function') return connectCtxBadge(meta);
  const ctx = parseInt((meta || {}).ctx_window, 10) || 0;
  if (ctx <= 0) return '';
  return ctx >= 1024 ? Math.round(ctx / 1024) + 'k' : String(ctx);
}

/* ---- A5：本地测试连接（免 Key；503 冷启动返回 loading 态而非失败） ---- */
async function localTestNow() {
  const baseEl = localEl('localBaseUrl', 'providerBase');
  const modelEl = localEl('localModelSelect', 'modelSelect');
  const base = ((baseEl || {}).value || '').trim();
  const model = ((modelEl || {}).value || '').trim();
  const btn = localEl('localTestBtn', 'providerTestBtn');
  const st = localEl('localTestStatus', 'providerTestStatus');
  if (!base || !model) { toast('请先填写 Base URL 并选择模型', 'warn'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '测试中…'; }
  try {
    /* 复用 provider 测试通道 + local 标志（roadmap A5：不新建测试通道）；
       前端桥接 timeoutMs 放宽到 90s（冷启动加载可见） */
    const r = JSON.parse(await callApi('test_provider_endpoint', [base, '', model, 30, true], 90000));
    if (st) {
      if (r.ok && r.state === 'loading') {
        st.textContent = '⏳ ' + (r.message || '模型加载中'); st.style.color = 'var(--warn)';
      } else {
        st.textContent = r.ok ? '✓ 连接成功' + (r.reply ? '：' + r.reply : '') : '✗ ' + (r.error || '失败');
        st.style.color = r.ok ? 'var(--ok)' : 'var(--err)';
      }
    }
    toast(r.ok ? (r.state === 'loading' ? '模型加载中（等待即可）' : '本地端点连接成功') : '测试失败：' + (r.error || ''),
          r.ok ? 'ok' : 'err', { stay: !r.ok, detail: r.error || '' });
  } catch (e) {
    if (st) { st.textContent = '✗ ' + e.message; st.style.color = 'var(--err)'; }
    toast('本地端点测试失败：' + e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '测试连接'; }
  }
}

/* ---- A4：本地模式计费标签（会话头部零费语义；UI 侧辅助函数） ---- */
function localBillingLabel() {
  return localState.mode ? '本地 · 0 费用' : null;
}

/* ---- B1：压缩阈值前端同口径（与后端 compact_threshold 一字不差）----
 * 窗口 × 档位系数：aggressive .4 / std .6 / relaxed .8；窗口三级来源
 * （元数据表 → 用户手设 → 默认 8k 保守）。GLM 128k×.6≈76.8k 与现标准档衔接；
 * 本地 8k 模型 → 4.8k 提前压缩（小窗口模型不爆窗）。 */
const COMPACT_LEVEL_RATIO = { aggressive: 0.4, std: 0.6, relaxed: 0.8 };
function compactThresholdLocal(ctxWindow, level) {
  let ctx = parseInt(ctxWindow) || 0;
  if (ctx <= 0) ctx = 8192;   // DEFAULT_LOCAL_META 保守值（与后端一致）
  const ratio = COMPACT_LEVEL_RATIO[level] || COMPACT_LEVEL_RATIO.std;
  return Math.round(ctx * ratio);
}
/** 当前 local 模式的压缩阈值（窗口取 localState 手设值 → 元数据缓存 → 默认）。 */
function localCompactThreshold() {
  const level = (document.getElementById('saverLevel') || {}).value || 'std';
  let ctx = localState.ctx_window > 0 ? localState.ctx_window : 0;
  if (ctx <= 0 && localState.model && localMetaCache[localState.model]) {
    ctx = localMetaCache[localState.model].ctx_window || 0;
  }
  return compactThresholdLocal(ctx, level);
}

/* ---- v1.9.0 M2.1（reader-status）：dual-LLM-lite 读取器状态灯 ----
 * 三态：未配置（灰，reader.json base_url 空）/ raw 降级（黄，本地不可用或
 * schema 失败）/ reader 正常（绿）+ degrade/schema_fail 计数（title 明细）。
 * 计数器进程内（重启归零，与 hybrid cost_split 同口径）。挂 header-right
 * （grantIndicator 同区）；搜索链路读取后可调 refreshReaderBadge 刷新。 */
async function refreshReaderBadge() {
  if (typeof document === 'undefined') return;
  const host = document.querySelector('.header-right');
  if (!host) return;
  let b = document.getElementById('readerStatusBadge');
  if (!b) {
    b = document.createElement('span');
    b.id = 'readerStatusBadge';
    b.className = 'reader-badge';
    host.appendChild(b);
  }
  let s = null;
  try { s = JSON.parse(await callApi('search_reader_stats', [], 20000)); }
  catch (e) { b.style.display = 'none'; return; }
  if (!s || s.error) { b.style.display = 'none'; return; }
  let cls = 'off', txt = '读取器未配置';
  if (s.configured) {
    const degrade = (s.degrade_count | 0) + (s.schema_fail | 0);
    if (degrade > 0) { cls = 'warn'; txt = '读取器降级 ×' + degrade; }
    else { cls = 'ok'; txt = (s.reader_calls | 0) > 0 ? '读取器正常' : '读取器就绪'; }
  }
  b.className = 'reader-badge ' + cls;
  b.textContent = txt;
  b.title = 'dual-LLM-lite 本地读取器\n调用 ' + (s.reader_calls | 0) + ' · schema 失败 ' +
    (s.schema_fail | 0) + ' · 降级 ' + (s.degrade_count | 0) +
    '\n本地端点：' + (s.local_available ? '可用' : '不可用') +
    (s.last_error ? '\n最近错误：' + s.last_error : '') +
    '\n配置：设置 → 本地模型（reader.json）';
  b.style.display = '';
}
