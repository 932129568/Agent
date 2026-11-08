
/* ================= 预设元信息 ================= */

/** 取预设元信息（未知 id → custom，永不返回 undefined）。 */
function connectPresetMeta(id) {
  return PRESETS[id] || PRESETS.custom;
}

/** 当前预设 id（未初始化时回落 glm）。 */
function connectCurrentPreset() {
  return PRESETS[connectPreset] ? connectPreset : 'glm';
}

/** 预设 id 列表（下拉顺序 = 设计书 §3 的 10 项）。 */
function connectPresetIds() {
  return CONNECT_PRESET_ORDER.slice();
}

/** 是否本地系预设（免 Key / 零费 / 探测本机）。 */
function connectIsLocalPreset(id) {
  const key = id || connectCurrentPreset();
  return !!connectPresetMeta(key).local;
}

/** 是否具备 GLM 专属能力（智能档 / 推理力度 / 思考 / 联网 / 内置价格表）。 */
function connectGlmCapable(id) {
  const key = id || connectCurrentPreset();
  return !!connectPresetMeta(key).glm_capable;
}

/** 预设默认模型清单（浅拷贝，防调用方改动表）。 */
function connectPresetModels(id) {
  const list = connectPresetMeta(id).models || [];
  return list.map(m => ({ id: m.id, text: m.text || m.id, badge: m.badge || '' }));
}

/* ================= URL / host 工具 ================= */

/** 取 URL 的 host（无协议头时整段视为 host；空 URL → ''）。 */
function connectHostOf(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^\/?#]+)/i.exec(s);
  return (m ? m[1] : s).toLowerCase();
}

/** 反向匹配预设：URL host 与预设默认地址 host 相同 → 该预设 id；否则 ''。 */
function connectPresetByUrl(url) {
  const host = connectHostOf(url);
  if (!host) return '';
  const ids = CONNECT_PRESET_ORDER;
  for (let i = 0; i < ids.length; i++) {
    const p = PRESETS[ids[i]];
    if (!p || !p.base_url) continue;
    if (connectHostOf(p.base_url) === host) return ids[i];
  }
  return '';
}

/** 反向匹配本地系预设：优先 local 家族的已知端口（11434/1234/8000/8080）。 */
function connectPresetByLocalUrl(url) {
  const host = connectHostOf(url);
  if (!host) return '';
  const portMatch = /:(\d{2,5})/.exec(String(url || ''));
  const port = portMatch ? portMatch[1] : '';
  const order = CONNECT_LOCAL_IDS;
  for (let i = 0; i < order.length; i++) {
    const p = PRESETS[order[i]];
    if (port && p.base_url.indexOf(':' + port) !== -1) return order[i];
  }
  return connectPresetByUrl(url);
}

/** 内置热门模型（host 关键词匹配，设计书 §4.2）；未命中 → []。 */
function connectHotModels(url) {
  const host = connectHostOf(url);
  if (!host) return [];
  for (let i = 0; i < PROVIDER_HOT_MODELS.length; i++) {
    const row = PROVIDER_HOT_MODELS[i];
    if (host.indexOf(row.host) !== -1) {
      return row.models.map(m => ({ id: m.id, text: m.text || m.id, badge: m.badge || '' }));
    }
  }
  return [];
}

/** ctx 徽标文本（'32k' / '200k'）；无窗口信息 → ''。 */
function connectBaseUrl() {
  const el = document.getElementById('providerBase');
  return el ? String(el.value || '').trim() : '';
}

/** Key 输入值（合并后唯一的 Key 字段，id/apiKey 为钉住契约）。 */
function connectApiKeyInput() {
  const el = document.getElementById('apiKey');
  return el ? String(el.value || '').trim() : '';
}

/** 当前生效模型名（手动态取文本框；占位/分组项 → ''）。 */
function connectModelValue() {
  const pick = document.getElementById('cmPick');
  const manual = !!(pick && pick.classList && pick.classList.contains('manual'));
  if (manual) {
    const inp = document.getElementById('cmManualInput');
    return inp ? String(inp.value || '').trim() : '';
  }
  const sel = document.getElementById('modelSelect');
  const v = sel ? String(sel.value || '').trim() : '';
  if (!v || v === CONNECT_MANUAL_VALUE || v === CONNECT_GROUP_VALUE) return '';
  return v;
}

/** 计费三价（输入/输出/缓存，¥/M tokens）。 */
function connectPrices() {
  const num = id => {
    const el = document.getElementById(id);
    return el ? (parseFloat(el.value) || 0) : 0;
  };
  return { in: num('providerPriceIn'), out: num('providerPriceOut'), cache: num('providerPriceCache') };
}

/** 工具调用偏好（local_* 语义：auto/on/off）。 */
function connectToolCapable() {
  const el = document.getElementById('localToolCapable');
  return (el && el.value) || 'auto';
}

/** 上下文窗口覆盖（0 = 按模型元数据自动）。 */
function connectCtxWindow() {
  const el = document.getElementById('localCtxWindow');
  return el ? (parseInt(el.value, 10) || 0) : 0;
}

/* ================= 运行态派生（单一事实源 → providerState / localState）================= */

/** 把 UI 的预设 + 字段派生为全 App 运行态。
 *  60-agent-loop 的本地分支依赖 localState.model，故本地系预设必须同步派生
 *  localState.mode/base_url/model（local_* 键仍只写 ctx/tool）。 */
function connectSyncState() {
  const meta = connectPresetMeta(connectCurrentPreset());
  const base = connectBaseUrl();
  const model = connectModelValue();
  providerState = {
    enabled: !meta.glm_capable,          // 兼容 v1.2 语义：非 GLM 端点即「自定义端点」
    name: connectCurrentPreset(),
    base_url: base || meta.base_url || '',
    model: model,
    key: connectApiKeyInput(),
    prices: connectPrices()
  };
  localState = {
    mode: !!meta.local && !!base,
    base_url: meta.local ? base : '',
    model: meta.local ? model : '',
    ctx_window: connectCtxWindow(),
    tool_capable: connectToolCapable()
  };
  if (typeof applyLocalMetaBadge === 'function') applyLocalMetaBadge();
}

/* ================= 模型下拉（下拉 ⇄ 手动输入 双态）================= */

/** 按钮 loading 态（spinner + 文案，dataset 暂存原文案）。
 * 修复（round4 遗留·对抗复审）：识别按钮（#cmIdentifyBtn）的文案随预设而变
 * （connectIdentifyLabel：获取模型/探测本机/探测目录/识别模型）——加载期间用户
 * 切预设时 connectApplyPresetNow 已把 innerHTML 改成新预设文案，但 dataset.html
 * 快照仍是旧预设的；原 off 分支盲目还原 dataset.html → 按钮显示陈旧预设文案
 * （如 ollama 预设下显示「↻ 获取模型」）。改为按当前预设重刷（其余按钮文案
 * 静态，dataset.html 还原仍正确）。 */
function connectSetButtonLoading(btn, on, text) {
  if (!btn) return;
  if (on) {
    if (!btn.dataset.html) btn.dataset.html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="tool-spinner"></span><span>' + (text || '处理中') + '</span>';
  } else {
    if (btn.id === 'cmIdentifyBtn' && typeof connectIdentifyLabel === 'function') {
      btn.innerHTML = connectIdentifyLabel(connectCurrentPreset());
    } else {
      btn.innerHTML = btn.dataset.html || btn.innerHTML;
    }
    delete btn.dataset.html;
    btn.disabled = false;
  }
}

/** 刷新模型下拉：可选「智能档」首项 + 分组标题 + 模型项（可带 ctx 徽标）+
 *  末项固定「✎ 手动输入模型名…」。
 *  opts: {auto:boolean, group:string, keep:string} */
function connectSetPickManual(on) {
  const pick = document.getElementById('cmPick');
  if (!pick || !pick.classList) return;
  pick.classList.toggle('manual', !!on);
}

/** 进入手动输入态（识别失败兜底 / 用户选「✎ 手动输入模型名…」）。 */
function connectIdentifyLabel(id) {
  const meta = connectPresetMeta(id || connectCurrentPreset());
  if (meta.local) return '↻ 探测本机';
  if (meta.glm_capable) return '↻ 获取模型';
  if (meta.catalog) return '↻ 探测目录';   // 实现 v1.6 T2：GitHub Models 目录探测
  return '↻ 识别模型';
}

/** 同步应用预设（唯一的「端点开关」入口；无动画路径，配置回填可直接调用）。
 *  opts: {base, key, models, keepModel, prices, quiet} */
function connectCancelIdentify() {
  clearTimeout(connectIdentifyTimer);
  connectIdentifySeq++;
}

/* ================= 测试连接（云端 Key / 本地免 Key 统一入口）================= */

async function connectTestNow() {
  const btn = document.getElementById('providerTestBtn');
  const st = document.getElementById('providerTestStatus');
  if (btn && btn.disabled) return;
  const meta = connectPresetMeta(connectCurrentPreset());
  const base = connectBaseUrl();
  const key = connectApiKeyInput();
  const model = connectModelValue();
  const done = (ok, msg) => {
    if (st) {
      st.textContent = (ok ? '✓ ' : '✗ ') + msg;
      st.className = 'cm-status ' + (ok ? 'ok' : 'err');
      st.style.color = ok ? 'var(--ok)' : 'var(--err)';
    }
    toast((ok ? '连接成功：' : '连接失败：') + msg, ok ? 'ok' : 'err', { stay: !ok });
  };
  connectSetButtonLoading(btn, true, '测试中');
  if (st) { st.textContent = '正在测试连接…'; st.className = 'cm-status'; st.style.color = ''; }
  try {
    if (!base) { done(false, '请先填写 Base URL'); return; }
    if (!/^https?:\/\//i.test(base)) { done(false, 'Base URL 需以 http:// 或 https:// 开头'); return; }
    if (meta.key_required && !key) { done(false, '请先填写 API Key'); return; }   // 修复（四轮）：统一 key_required 判据
    if (!model) { done(false, '请先选择或手动输入模型名'); return; }
    const local = !!meta.local;
    const raw = await callApi('test_provider_endpoint',
      [base, local ? '' : key, model, local ? 30 : 15, local], local ? 90000 : 20000);
    const r = JSON.parse(raw || '{}');
    if (r && r.ok && r.state === 'loading') done(true, r.message || '模型加载中');
    else if (r && r.ok) done(true, (r.reply ? '回复：' + r.reply : '端点可达' + (local ? ' · 本地 · 0 费用' : '')));
    else {
      // 修复（2026-10-21 P0）：1211 等模型不可用时后端顺带拉了可用清单
      // （available_models）——展示出来，用户点一次就知道能换什么
      let msg = (r && r.error) || '端点不可达';
      if (r && Array.isArray(r.available_models) && r.available_models.length) {
        msg += '\n可用模型（' + r.available_models.length + '）：'
          + r.available_models.slice(0, 8).join('、')
          + (r.available_models.length > 8 ? ' 等' : '');
      }
      done(false, msg);
      if (r && Array.isArray(r.available_models) && r.available_models.length) {
        // 一键填入第一个可用模型（用户可改）——降低「知道能换什么但懒得找」的摩擦
        const inp = document.getElementById('cmManualInput');
        if (inp && !inp.value) inp.value = r.available_models[0];
      }
    }
  } catch (e) {
    done(false, (e && e.message) || '请求失败');
  } finally {
    connectSetButtonLoading(btn, false);
  }
}

/** 旧签名兼容（v1.2 服务商测试通道）：统一走合并块的测试连接。 */
async function testProviderNow() {
  return connectTestNow();
}

/* ================= 配置读写（单一事实源 provider_*）================= */

/** 采集 provider_* 键组（provider_name = 预设 id）。 */
function connectCollectConfig() {
  return {
    provider_name: connectCurrentPreset(),
    provider_base_url: connectBaseUrl(),
    provider_key: connectApiKeyInput(),
    provider_model: connectModelValue(),
    provider_prices: connectPrices()
  };
}

/** 从 config.json 回填合并块（含 v1.5 本地 config 与 v1.2 仅有 api_key 的旧配置迁移）。
 *  seed 一次性且严格幂等：迁移落盘后 config 自带「本地系预设 + provider_base_url」，
 *  再次 boot 时 alreadyLocal=true → 不再进入迁移分支、不再落盘（QA 修正 1）。 */
function syncProviderUiState() {
  const wrap = document.getElementById('providerFields');
  if (wrap && wrap.style) wrap.style.display = '';
}

/** 旧签名兼容：保存后刷新运行态。 */
function collectProviderConfig() {
  return connectCollectConfig();
}

/* ================= 初始化（boot 调用）================= */

