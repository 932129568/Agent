function connectCtxBadge(meta) {
  const ctx = parseInt((meta || {}).ctx_window, 10) || 0;
  if (ctx <= 0) return '';
  // 修复 ㊾（三轮）：改走统一 formatCtx()（80-utils 定义；typeof 守卫保 vm 单模块
  // 沙箱只加载本文件时可测，兜底与 formatCtx 同口径）
  return (typeof formatCtx === 'function') ? formatCtx(ctx)
    : (ctx >= 1024 ? Math.round(ctx / 1024) + 'k' : String(ctx));
}

/* ================= DOM 取值 ================= */

/** Base URL 输入值（去空白）。 */
function connectFillModels(list, opts) {
  opts = opts || {};
  const sel = document.getElementById('modelSelect');
  if (!sel) return;
  const rawKeep = String(opts.keep || '').trim();
  /* 'auto'（智能档）只在本预设提供智能档首项时才可作为回填值 */
  const keep = (rawKeep === 'auto' && !opts.auto) ? '' : rawKeep;
  const items = (list || []).map(m => ({ id: String(m.id), text: m.text || String(m.id),
                                         badge: m.badge || '' }));
  sel.innerHTML = '';
  if (opts.auto) {
    const a = document.createElement('option');
    a.value = 'auto';
    a.textContent = '智能档（按任务自动调节，最省）';
    sel.appendChild(a);
  }
  const ids = items.map(m => m.id);
  if (keep && keep !== 'auto' && ids.indexOf(keep) === -1) {
    items.push({ id: keep, text: keep, badge: '' });      // 配置里的模型名不在预设表 → 补一项保住回填
    ids.push(keep);
  }
  if (items.length) {
    if (opts.group) {
      const g = document.createElement('option');
      g.value = CONNECT_GROUP_VALUE;
      g.disabled = true;
      g.dataset.group = opts.group;
      g.textContent = opts.group;
      sel.appendChild(g);
    }
    items.forEach(it => {
      const o = document.createElement('option');
      o.value = it.id;
      o.textContent = it.text;
      if (it.badge) o.dataset.badge = it.badge;
      sel.appendChild(o);
    });
  } else if (!opts.auto) {
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '尚未识别 — 填写 Base URL 与 Key 后自动识别';
    sel.appendChild(ph);
  }
  const mm = document.createElement('option');
  mm.value = CONNECT_MANUAL_VALUE;
  mm.textContent = '✎ 手动输入模型名…';
  sel.appendChild(mm);
  if (keep && (ids.indexOf(keep) !== -1 || keep === 'auto')) sel.value = keep;
  else if (opts.auto) sel.value = 'auto';
  else if (ids.length) sel.value = ids[0];
  else sel.value = '';
  connectSetPickManual(sel.value === CONNECT_MANUAL_VALUE);
  connectSyncAfterModelFill(sel);
}

/** 下拉内容重构后同步：自定义下拉组件刷新 + 品牌位 + 运行态。 */
function connectSyncAfterModelFill(sel) {
  try {
    if (typeof CS !== 'undefined' && CS && typeof CS.sync === 'function' && sel) CS.sync(sel);
  } catch (e) { /* 下拉组件不可用时直接用原生 select */ }
  if (typeof updateBrandModel === 'function') updateBrandModel();
  connectSyncState();
}

/** 手动态切换（.cm-pick.manual 显隐由 CSS 决定）。 */
function connectEnterManual(prefill) {
  const sel = document.getElementById('modelSelect');
  if (sel) sel.value = CONNECT_MANUAL_VALUE;
  connectSetPickManual(true);
  const inp = document.getElementById('cmManualInput');
  const val = String(prefill || '').trim();   // 修复 53（三轮）：随死变量 connectManualPrefill 一并简化
  if (inp) {
    if (val) inp.value = val;
    try { inp.focus(); } catch (e) { /* 无焦点能力的环境忽略 */ }
  }
  connectSyncAfterModelFill(sel);
}

/** 退出手动输入态：下拉复位到首个实义项。 */
function connectExitManual() {
  const sel = document.getElementById('modelSelect');
  if (sel) {
    const opts = sel.children || [];
    let picked = '';
    for (let i = 0; i < opts.length; i++) {
      const v = String(opts[i].value || '');
      if (v && v !== CONNECT_MANUAL_VALUE && v !== CONNECT_GROUP_VALUE) { picked = v; break; }
    }
    sel.value = picked;
  }
  connectSetPickManual(false);
  connectSyncAfterModelFill(sel);
}

/** 下拉 change：选手动项 → 进手动态；选实义项 → 退手动态。 */
function connectOnModelChange() {
  const sel = document.getElementById('modelSelect');
  const v = sel ? String(sel.value || '') : '';
  connectSetPickManual(v === CONNECT_MANUAL_VALUE);
  if (typeof updateBrandModel === 'function') updateBrandModel();
  connectSyncState();
}

/* ================= 预设切换 ================= */

/** 高级折叠三条条件显隐（设计书 §5 矩阵）。 */
function connectUpdateAdvanced() {
  const meta = connectPresetMeta(connectCurrentPreset());
  // 修复 W34（三轮）：GLM 判据双轨制——发送层 isGlmEndpoint() 认「name==='glm'
  // 或 base_url 含 bigmodel.cn」，UI 显隐原只认 meta.glm_capable（仅 glm 预设）。
  // 用户填官方域名的自定义预设：发送层走 GLM 语义（thinking/智能档/内置价表），
  // UI 却按非 GLM 显隐 → 用户填的三价实际不生效。显隐加同口径判据
  // （isGlmBaseUrl 在 71-provider 定义，同脚本作用域；typeof 守卫保模块沙箱可测）
  const _pid = connectCurrentPreset();
  const _glmUi = !!meta.glm_capable
    || (_pid === 'custom' && typeof isGlmBaseUrl === 'function' && isGlmBaseUrl(connectBaseUrl()));
  const showReasoning = _glmUi;
  const showBilling = !_glmUi && !meta.local;
  const showLocal = !!meta.local;
  const show = (id, on) => {
    const el = document.getElementById(id);
    if (el && el.style) el.style.display = on ? '' : 'none';
  };
  show('advReasoning', showReasoning);
  show('advReasoningOff', !showReasoning);
  show('advBilling', showBilling);
  show('advBillingOff', !showBilling);
  show('advLocal', showLocal);
  show('advLocalOff', !showLocal);
}

/** 识别 / 探测按钮文案（本地系 = 探测本机；GLM = 获取模型；目录型 = 探测目录）。 */
function connectApplyPresetNow(key, opts) {
  opts = opts || {};
  const presetId = PRESETS[key] ? key : 'custom';
  const meta = PRESETS[presetId];
  const prevId = connectCurrentPreset();          // 切出前的预设（切出即记忆手改值）
  const baseEl = document.getElementById('providerBase');
  const prevBase = baseEl ? String(baseEl.value || '').trim() : '';
  if (prevId && prevId !== presetId && prevBase &&
      prevBase !== String((PRESETS[prevId] || {}).base_url || '')) {
    PRESET_BASE_MEMO[prevId] = prevBase;
  }
  connectPreset = presetId;          // 预设状态机唯一入口：同步写入当前预设
  const psel = document.getElementById('providerPreset');
  if (psel) psel.value = presetId;
  try {
    if (typeof CS !== 'undefined' && CS && typeof CS.sync === 'function' && psel) CS.sync(psel);
  } catch (e) { /* 原生 select 兜底 */ }
  if (baseEl) {
    /* 取值优先级：配置回填显式值 > 本预设记忆的手改值 > 预设默认值
       （custom 默认 ''；记忆命中即恢复用户上次填的 URL，不再被清空） */
    if (opts.base !== undefined) baseEl.value = opts.base;
    else if (PRESET_BASE_MEMO[presetId]) baseEl.value = PRESET_BASE_MEMO[presetId];
    else baseEl.value = meta.base_url || '';
    baseEl.placeholder = meta.base_url || 'https://api.example.com/v1';
  }
  const keyEl = document.getElementById('apiKey');
  if (keyEl) {
    if (opts.key !== undefined) keyEl.value = opts.key;
    // 实现 v1.6 T1：GitHub Models 的 Key 文案明示 PAT 与 scope（预设 key_hint 优先）
    keyEl.placeholder = meta.key_hint
      || (meta.glm_capable ? '粘贴你的智谱 API Key'
      : meta.local ? '本地服务器通常无需 Key'
      : '该服务商的 API Key（仅保存在本机）');
  }
  // 实现 v1.6 T1：Key 标签文案 / PAT 获取指引 / 免费层常驻声明按预设显隐
  // （新 id 全部唯一，UI 契约只增不改）
  const keyLabel = document.getElementById('cmKeyLabel');
  if (keyLabel) keyLabel.textContent = meta.key_hint || 'API Key（仅保存在本机）';
  const keyHelp = document.getElementById('cmKeyHelp');
  if (keyHelp && keyHelp.style) keyHelp.style.display = meta.free_tier ? '' : 'none';
  const freeTier = document.getElementById('cmFreeTier');
  if (freeTier && freeTier.style) freeTier.style.display = meta.free_tier ? '' : 'none';
  const keyRow = document.getElementById('cmKeyRow');
  if (keyRow && keyRow.style) keyRow.style.display = meta.key_required ? '' : 'none';
  const noKey = document.getElementById('cmNoKey');
  if (noKey && noKey.style) noKey.style.display = meta.key_required ? 'none' : '';
  const idBtn = document.getElementById('cmIdentifyBtn');
  if (idBtn) idBtn.innerHTML = connectIdentifyLabel(presetId);
  const prices = opts.prices || meta.prices;
  if (prices) {
    const setNum = (fid, v) => { const el = document.getElementById(fid); if (el) el.value = v; };
    setNum('providerPriceIn', Number(prices.in) || 0);
    setNum('providerPriceOut', Number(prices.out) || 0);
    setNum('providerPriceCache', Number(prices.cache) || 0);
  }
  const list = opts.models || connectPresetModels(presetId);
  connectFillModels(list, { auto: !!meta.glm_capable,
                            group: list.length ? '预设推荐' : '',
                            keep: opts.keepModel || '' });
  const box = document.getElementById('localProbeResult');
  if (box) { box.innerHTML = ''; }
  const st = document.getElementById('providerTestStatus');
  if (st) { st.textContent = ''; st.className = 'cm-status'; st.style.color = ''; }
  connectUpdateAdvanced();
  connectSyncState();
  if (typeof updateBrandModel === 'function') updateBrandModel();
  if (!opts.quiet && typeof queueSaveConfig === 'function') queueSaveConfig();
}

/** 应用预设（带内容区 200ms 交叉淡入的异步包装；模板/用户切换走这里）。
 *  opts: {animate, base, key, models, keepModel, prices, quiet} */
async function connectApplyPreset(id, opts) {
  opts = opts || {};
  const presetId = PRESETS[id] ? id : 'custom';
  clearTimeout(connectIdentifyTimer);
  if (typeof connectIdentifySeq === 'number') connectIdentifySeq++;   // 修复 S9（三轮）：切预设使在途识别请求失效（旧端点清单不污染新预设下拉）
  if (opts.animate && typeof MOTION !== 'undefined' && !MOTION.instant()) {
    const flow = document.getElementById('cmFlow');
    if (flow && flow.classList) flow.classList.add('swapping');
    await MOTION.sleep(MOTION.compOut());
    connectApplyPresetNow(presetId, opts);
    if (flow && flow.classList) flow.classList.remove('swapping');
  } else {
    connectApplyPresetNow(presetId, opts);
  }
}

/** 旧签名兼容（模板 onchange / 旧调用点）：切预设并保存。 */
function onProviderPresetChange(v) {
  connectApplyPreset(v, { animate: true });
}

/* ================= 识别模型（防抖 800ms 自动 + 手动按钮兜底）================= */

/** 字段变化后的防抖自动识别（云端需 URL + Key；本地系只需 URL；GLM 不自动枚举）。 */
function connectScheduleIdentify() {
  if (!CONNECT_AUTO_IDENTIFY) return;
  clearTimeout(connectIdentifyTimer);
  connectIdentifyTimer = setTimeout(() => {
    const meta = connectPresetMeta(connectCurrentPreset());
    if (meta.glm_capable) return;                 // GLM：手动「获取模型」才拉清单
    const base = connectBaseUrl();
    if (!base) return;
    if (!meta.local && !connectApiKeyInput()) return;
    connectIdentifyNow(false);
  }, CONNECT_DEBOUNCE_MS);
}

/** 识别 / 探测入口（按钮手动点击 fromClick=true）。
 *  last-wins：每次调用递增 connectIdentifySeq，旧请求返回后自行失效；
 *  失败 → 人话 toast + 切手动输入态，永不阻塞保存与发送。 */
async function connectIdentifyNow(fromClick) {
  const meta = connectPresetMeta(connectCurrentPreset());
  const base = connectBaseUrl();
  if (!base) {
    if (fromClick) {
      toast('请先填写 Base URL，再识别模型', 'err');
      connectEnterManual();
    }
    return;
  }
  const seq = ++connectIdentifySeq;
  if (meta.local) {
    /* 本地系：复用 v1.5 并行端口探测（local_probe），命中后自动带出清单 */
    if (typeof localProbeNow === 'function') {
      await localProbeNow();
    } else if (fromClick) {
      toast('本地探测不可用（模块未加载）', 'err');
    }
    return;
  }
  const key = connectApiKeyInput();
  // 修复（四轮）：前置门统一按 key_required 判据——原只认 glm_capable，DeepSeek/
  // Moonshot/Qwen/GitHub Models/自定义端点空 Key 会直发真实请求 401 才报错
  if (!key && meta.key_required && fromClick) {
    toast('请先填写 API Key，再获取模型清单', 'warn');
    connectEnterManual();
    return;
  }
  const btn = document.getElementById('cmIdentifyBtn');
  connectSetButtonLoading(btn, true, meta.glm_capable ? '获取中' : '识别中');
  let models = [];
  let reason = '';
  try {
    const raw = await callApi('local_models', [base, key]);
    if (seq !== connectIdentifySeq) { return; }   // last-wins：旧请求失效（按钮归最新请求，禁提前复位）
    const r = JSON.parse(raw || '{}');
    if (r && r.ok && Array.isArray(r.models) && r.models.length) {
      // 实现 v1.6 T2：目录模型带 modalities 时进选项文案（GitHub catalog 富元数据；
      // 其他端点无该字段 → 文案不变，零行为差异）
      models = r.models.map(m => ({
        id: String(m.id || ''),
        text: String(m.id || '') + (Array.isArray(m.modalities) && m.modalities.length
          ? '（' + m.modalities.join('/') + '）' : ''),
        badge: connectCtxBadge(m)
      })).filter(m => m.id);
    } else {
      reason = (r && r.error) || '端点未返回模型清单';
    }
  } catch (e) {
    reason = (e && e.message) ? e.message : String(e);
  }
  // 复核修正：复位前先判 last-wins——原旧返回把在途新请求的「识别中」
  // 禁用态提前解锁，放行并发第三轮请求
  if (seq !== connectIdentifySeq) return;
  connectSetButtonLoading(btn, false);
  let hot = false;
  if (!models.length) {
    models = connectHotModels(base);                // 内置热门表兜底（设计书 §4.2）
    hot = models.length > 0;
  }
  if (models.length) {
    connectFillModels(models, { auto: !!meta.glm_capable,
                                group: hot ? '内置热门模型' : '识别结果' });
    if (hot && reason) {
      // 实现 v1.6 T2：识别失败但热门表兜底 → 失败原因人话透传（不阻塞面板），
      // 兜底加载提示照旧（旧行为只 toast「已加载 N 个模型」，401 等原因被吞）
      const failMsg = (meta.glm_capable ? '获取模型失败：' : '识别失败：') + reason;
      toast(failMsg + '（已用内置热门模型兜底，可手动输入模型名）', 'warn',
            { detail: 'GET ' + base + '/models\n' + (reason || '空响应') });
    }
    toast((hot ? '已加载 ' : '已识别 ') + models.length + ' 个模型', 'ok');
    return;
  }
  const msg = (meta.glm_capable ? '获取模型失败：' : '识别失败：') + (reason || '端点未返回模型清单');
  if (fromClick) {
    /* 手动点击失败 → 直接落到手动输入态（兜底路径，永不阻塞保存与发送） */
    toast(msg + '，已切换为手动输入', 'err', { detail: 'GET ' + base + '/models\n' + (reason || '空响应') });
    connectEnterManual();
  } else {
    /* 自动识别失败 → 只提示不打断（用户可能还在补 Key，不抢走已选模型） */
    toast(msg + '（可点「识别模型」或手动输入模型名）', 'warn');
  }
}

/** 取消进行中的识别（切预设 / 弃用时调用）：序号递增使旧请求全部失效。 */
function connectLoadFromConfig(cfg) {
  cfg = cfg || {};
  const legacyKey = String(cfg.api_key || '').trim();
  const legacyModel = String(cfg.model || '').trim();
  const legacyLocalBase = String(cfg.local_base_url || '').trim();
  let presetId = String(cfg.provider_name || '').trim().toLowerCase();
  let base = String(cfg.provider_base_url || '').trim();
  let key = String(cfg.provider_key || '').trim();
  let model = String(cfg.provider_model || '').trim();
  let needSeed = false;
  /* 已迁移的本地配置：provider_name 已是本地系预设且 provider_base_url 非空
     （collectLocalConfig 会持续写 local_mode/local_base_url，不能据此重判迁移） */
  const alreadyLocal = !!(PRESETS[presetId] && PRESETS[presetId].local) && !!base;
  if (cfg.local_mode && legacyLocalBase && !alreadyLocal) {
    /* v1.5 老配置：本地模式生效（旧运行期本地优先于服务商）→ 一次性迁移为本地系预设 */
    const localId = String(cfg.local_preset || '').trim().toLowerCase();
    presetId = (PRESETS[localId] && PRESETS[localId].local) ? localId
      : (connectPresetByLocalUrl(legacyLocalBase) || 'custom');
    base = legacyLocalBase;
    /* 本地系迁移：模型名以 local_model 优先——双开老配置（provider_model 是云端名）迁到
       本地预设后若保留云端名，请求会打到 localhost 却带云端模型名（等同 404 model not found）。
       无 local_model 时才回落到原 provider_model/model。 */
    model = String(cfg.local_model || '').trim() || model;
    needSeed = true;
  } else if (!base && !presetId && (legacyKey || legacyModel)) {
    /* v1.2/更早：只有 api_key（完全没有端点信息）→ 一次性 seed 为 GLM 预设。
       修复 W37（三轮）：原条件 `(legacyKey || legacyModel || !presetId)` 把
       「provider_name 有效但 base 为空」的配置也强并为 GLM 并落盘——用户选过
       预设的配置被静默改写。现只有无预设名才 seed GLM；有预设名走下方预设默认 base。 */
    presetId = 'glm';
    base = PRESETS.glm.base_url;
    key = key || legacyKey;
    model = model || legacyModel;
    needSeed = !!legacyKey;
  }
  if (!PRESETS[presetId]) presetId = connectPresetByUrl(base) || 'custom';
  if (!base) base = PRESETS[presetId].base_url;
  if (!key) key = legacyKey;
  if (!model) model = legacyModel;
  const cfgPrices = cfg.provider_prices || null;
  const prices = (cfgPrices && (cfgPrices.in != null || cfgPrices.out != null || cfgPrices.cache != null))
    ? { in: Number(cfgPrices.in) || 0, out: Number(cfgPrices.out) || 0, cache: Number(cfgPrices.cache) || 0 }
    : null;
  /* 非同步应用（boot 阶段无动画；connectApplyPresetNow 为纯同步 DOM 更新，
     内部同步写入 connectPreset，故此处直接传 presetId） */
  clearTimeout(connectIdentifyTimer);
  connectApplyPresetNow(presetId, {
    base: base, key: key, keepModel: model,
    prices: prices || undefined, quiet: !needSeed
  });
  const ctxEl = document.getElementById('localCtxWindow');
  if (ctxEl) ctxEl.value = parseInt(cfg.local_ctx_window, 10) || 0;
  const toolEl = document.getElementById('localToolCapable');
  if (toolEl) toolEl.value = cfg.local_tool_capable || 'auto';
  connectUpdateAdvanced();
  connectSyncState();
  if (typeof applyLocalMetaBadge === 'function') applyLocalMetaBadge();
  /* 迁移落盘由 connectApplyPresetNow 的 !quiet 分支统一触发（一次），此处不再重复排队 */
}

/** 旧签名兼容（boot 调用点）：回填合并块。 */
function loadProviderUI(cfg) {
  connectLoadFromConfig(cfg);
}

/** 旧签名兼容：合并后无「启用端点」勾选，字段常显（保留函数供旧调用点调用）。 */
function applyProviderConfig() {
  connectSyncState();
  if (typeof updateBrandModel === 'function') updateBrandModel();
}

/** 旧签名兼容：采集 provider_* 键组。 */
function connectInit() {
  const on = (id, ev, fn) => {
    const el = document.getElementById(id);
    if (el && el.addEventListener) el.addEventListener(ev, fn);
  };
  on('providerBase', 'input', () => { connectScheduleIdentify(); });
  on('providerBase', 'change', () => { connectScheduleIdentify(); connectSyncState(); if (typeof queueSaveConfig === 'function') queueSaveConfig(); });
  on('apiKey', 'input', () => { connectScheduleIdentify(); });
  /* 修复 53（三轮）：删除此处 modelSelect change 重复绑定——110-boot.js:25 已绑
   * 同一处理器（connectOnModelChange + queueSaveConfig + updateBrandModel），
   * 双绑定导致一次下拉切换触发两轮识别/同步 */
  on('cmManualInput', 'input', () => { connectSyncState(); if (typeof updateBrandModel === 'function') updateBrandModel(); });
  on('cmManualInput', 'change', () => { if (typeof queueSaveConfig === 'function') queueSaveConfig(); });
  on('cmManualBack', 'click', () => { connectExitManual(); if (typeof queueSaveConfig === 'function') queueSaveConfig(); });
  /* 识别 / 测试按钮走模板 onclick（模板已绑定 connectIdentifyNow / connectTestNow），
     此处不重复绑定，避免一次点击触发两次识别 */
  ['reasoningEffort', 'providerPriceIn', 'providerPriceOut', 'providerPriceCache',
   'localToolCapable', 'localCtxWindow'].forEach(id => {
    on(id, 'change', () => { connectSyncState(); if (typeof queueSaveConfig === 'function') queueSaveConfig(); });
  });
  connectUpdateAdvanced();
  /* v1.8.0：预设卡网格已撤（输入区模型 chip 为主选择器；卡网格与其功能重复） */
}


/* ---------- v1.8.0 预设可视化卡网格（2026-10-21 用户实测：设置区以预设为主） ----------
 * select#providerPreset 契约保留（CSS 隐藏），卡网格驱动其 value +
 * onProviderPresetChange；卡从 options 动态生成（防 DOM 漂移）。 */
function connectPresetGridInit() {
  const slot = document.querySelector('.cm-preset-slot');
  const sel = document.getElementById('providerPreset');
  if (!slot || !sel || document.getElementById('cmPresetGrid')) return;
  const grid = document.createElement('div');
  grid.id = 'cmPresetGrid';
  grid.className = 'cm-preset-grid';
  const esc = (t) => (typeof escapeHtml === 'function' ? escapeHtml(String(t)) : String(t));
  grid.innerHTML = [...sel.options].map(o =>
    '<button type="button" class="cm-preset-card' + (o.value === sel.value ? ' on' : '') +
      '" data-val="' + esc(o.value) + '">' +
    '<span class="cpc-ic">' + esc((o.textContent || '?').trim().charAt(0)) + '</span>' +
    '<span class="cpc-name">' + esc(o.textContent) + '</span>' +
    (o.value === sel.value ? '<span class="cpc-check">✓</span>' : '') +
    '</button>').join('');
  slot.appendChild(grid);
  const sync = () => {
    grid.querySelectorAll('.cm-preset-card').forEach(c => {
      const on = c.getAttribute('data-val') === sel.value;
      c.classList.toggle('on', on);
      const chk = c.querySelector('.cpc-check');
      if (on && !chk) { const s2 = document.createElement('span'); s2.className = 'cpc-check'; s2.textContent = '✓'; c.appendChild(s2); }
      else if (!on && chk) chk.remove();
    });
  };
  grid.querySelectorAll('.cm-preset-card').forEach(card => {
    card.addEventListener('click', () => {
      const v = card.getAttribute('data-val');
      if (v === sel.value) return;
      sel.value = v;
      if (typeof onProviderPresetChange === 'function') onProviderPresetChange(v);
      sync();
    });
  });
  // select 被其他路径修改（恢复默认/载入配置）时同步卡态
  sel.addEventListener('change', sync);
}


/* v1.8.0：保存并测试——保存（queueSaveConfig 写 config.json）+ 跑测试连接，
 * 成功 toast 明示「对话正在使用」。保存与测试解耦：保存必达，测试结果异步回报。 */
async function connectSaveAndTest() {
  const btn = document.getElementById('cmSaveBtn');
  try {
    if (typeof connectSyncState === 'function') connectSyncState();
    if (typeof queueSaveConfig === 'function') queueSaveConfig();
    if (typeof toast === 'function') toast('已保存，对话正在使用该端点', 'ok');
  } catch (e) {
    if (typeof toast === 'function') toast('保存失败：' + (e.message || e), 'err');
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = '保存成功，测试中…'; }
  try {
    if (typeof connectTestNow === 'function') await connectTestNow();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '保存并测试连接'; }
  }
}
