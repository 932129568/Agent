/* ================= 群成员跨端点选模型（Round 15，2026-11-04 主理人需求） =================
 * 报障原文：「能使用的模型并不能自由选择，如果在设置里面保存了智谱的就只能用
 * 智谱的，用 deepseek 就只有 deepseek 的模型，改一下可以自由选择模型」。
 *
 * 原实现：成员模型下拉直接抄设置页 modelSelect 的选项——只有一个端点的模型，
 * 换成员就得先改全局设置。现在：
 * - 下拉按端点分组成「当前端点(默认) / 智谱 / DeepSeek / …」，任一已配置端点的
 *   模型都能选；
 * - 成员保存的是完整目标 `端点id::模型名`；只在本端点内选择时仍存裸模型名
 *   （向后兼容旧群聊数据：裸名 = 用当前端点）；
 * - 保存时把用到的端点快照进 group.endpoints（含 key），轮到该成员发言时按其
 *   端点发送——这样「群聊里同时用智谱和 DeepSeek」才真正跑得通。
 * 密钥不再明文落 localStorage 的既有纪律不变（会话保存走后端）。 */

const GROUP_EP_SEP = '::';

/** 解析成员模型选择：'epId::modelName' → {endpointId, model}；裸模型名 → null（走当前端点）。 */
function groupModelTarget(grouped) {
  const raw = String(grouped || '');
  if (!raw) return null;                                   // 空 = 用当前端点当前模型
  const i = raw.indexOf(GROUP_EP_SEP);
  if (i < 0) return null;                                  // 旧数据：裸模型名
  const epId = raw.slice(0, i);
  const model = raw.slice(i + GROUP_EP_SEP.length);
  if (!epId || !model) return null;
  return { endpointId: epId, model: model };
}

/** 已配置端点清单：预设列表（有 base_url 或已填 key 的预设）+ 当前端点。
 *  返回 [{id, name, base_url, models:[{id,text}]}]。 */
function groupEndpointCatalog() {
  const out = [];
  const seen = {};
  const push = (id, name, base, models) => {
    if (!id || seen[id] || !base) return;
    seen[id] = true;
    out.push({ id: id, name: name || id, base_url: base, models: models || [] });
  };
  // 1) 当前端点（一定是可用的）
  try {
    const st = (typeof providerState !== 'undefined' && providerState) ? providerState : {};
    const curName = (typeof currentEndpointName === 'function') ? currentEndpointName() : (st.name || '当前');
    const sel = document.getElementById('modelSelect');
    const curModels = [];
    if (sel) {
      for (const o of sel.options) {
        const v = o.value || '';
        if (!v || v === '__group__' || v === '__manual__' || v === 'auto') continue;
        curModels.push({ id: v, text: o.textContent || v });
      }
    }
    push('current', '当前端点 · ' + curName, (st && st.base_url) || 'current', curModels);
  } catch (e) {}
  // 2) 其它已配置预设（按 基准URL + 模型表）
  try {
    if (typeof connectHotModels === 'function' && typeof PRESETS === 'object' && PRESETS) {
      Object.keys(PRESETS).forEach(id => {
        const p = PRESETS[id];
        if (!p || p.local) return;
        const base = p.base_url || '';
        const models = [];
        (p.models || []).forEach(m => {
          if (m && m.id) models.push({ id: m.id, text: m.text || m.id });
        });
        if (!models.length && base) {
          (connectHotModels(base) || []).forEach(m => models.push({ id: m.id, text: m.text || m.id }));
        }
        push(id, p.name || id, base, models);
      });
    }
  } catch (e) {}
  // 3) 群聊里已自定义过的端点（group.endpoints）
  try {
    const g = (typeof groupSessionOf === 'function')
      ? groupSessionOf((typeof AppState !== 'undefined') ? AppState.currentSessionId : currentSessionId) : null;
    Object.keys((g && g.group && g.group.endpoints) || {}).forEach(id => {
      const ep = g.group.endpoints[id];
      if (ep && ep.base_url) push(id, groupEndpointLabel(id), ep.base_url, ep.models || []);
    });
  } catch (e) {}
  return out;
}

/** 端点 id → 下拉友好名（'current' / 'glm' / 'deepseek' / 'custom:myhost'）。 */
function groupEndpointLabel(id) {
  if (!id || id === 'current') return '当前端点';
  try {
    const p = (typeof PRESETS === 'object' && PRESETS) ? PRESETS[id] : null;
    if (p && p.name) return p.name;
  } catch (e) {}
  if (String(id).indexOf('custom:') === 0) return '自定义 · ' + String(id).slice(7);
  return String(id);
}

/** 成员选用某端点时：确保 group.endpoints 里有它（base_url + key）。
 *  未知/缺 key 返回 false，UI 据此提示成员补填端点与 Key。 */
function groupEnsureEndpoint(group, endpointId, baseUrl, apiKey) {
  if (!group || !endpointId || endpointId === 'current') return true;
  group.endpoints = group.endpoints || {};
  const prev = group.endpoints[endpointId] || {};
  const base = String(baseUrl || prev.base_url || '').trim();
  if (!base) return false;
  group.endpoints[endpointId] = {
    name: groupEndpointLabel(endpointId),
    base_url: base,
    api_key: String(apiKey == null ? (prev.api_key || '') : apiKey).trim(),
  };
  return !!group.endpoints[endpointId].api_key;
}

/** 解析某成员本次发言要打的端点和 key：
 *  - 裸模型名/空 → 当前端点（null 表示沿用主链路）
 *  - 'ep::model' → group.endpoints[ep]；缺端点或 key → {missing:'key'} */
function groupMemberEndpoint(group, member) {
  const t = groupModelTarget(member && member.model);
  if (!t) return null;
  const ep = (group && group.endpoints && group.endpoints[t.endpointId]) || null;
  return { endpointId: t.endpointId, model: t.model, ep: ep,
           missing: (!ep || !ep.base_url) ? 'endpoint' : (!ep.api_key ? 'key' : '') };
}

/** 生成下拉 <option>：optgroup 分组；选中值兼容旧裸模型名。 */
function groupModelSelectOptions(group, currentValue) {
  const cur = String(currentValue || '');
  let html = '<option value=""' + (cur === '' ? ' selected' : '') + '>（用当前端点 + 当前模型）</option>';
  let catalog = [];
  try { catalog = groupEndpointCatalog(); } catch (e) { catalog = []; }
  const known = {};
  catalog.forEach(ep => {
    ep.models.forEach(m => { known[ep.id + GROUP_EP_SEP + m.id] = true; });
    if (!ep.models.length) return;
    const label = ep.id === 'current' ? ep.name : ep.name;
    html += '<optgroup label="' + label.replace(/</g, '&lt;') + '">';
    ep.models.forEach(m => {
      const val = (ep.id === 'current' ? m.id : ep.id + GROUP_EP_SEP + m.id);
      const text = (ep.id === 'current' ? m.text : m.text + ' · ' + ep.name);
      html += '<option value="' + val.replace(/"/g, '&quot;') + '"' +
        (val === cur ? ' selected' : '') + '>' + String(text).replace(/</g, '&lt;') + '</option>';
    });
    html += '</optgroup>';
  });
  // 旧数据里的裸模型名（不在当前端点清单里也要能选回）：保留为一条
  if (cur && !known[cur] && cur.indexOf(GROUP_EP_SEP) < 0) {
    html += '<optgroup label="历史选择"><option value="' + cur.replace(/"/g, '&quot;') +
      '" selected>' + cur.replace(/</g, '&lt;') + '</option></optgroup>';
  }
  return html;
}

/** 把某一成员要用的端点（含 key）快照进 session.group.endpoints。 */
function groupCaptureEndpoint(group, endpointId) {
  if (!group || !endpointId || endpointId === 'current') return;
  group.endpoints = group.endpoints || {};
  if (group.endpoints[endpointId]) return;
  try {
    const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem('glm_provider_presets') : null;
    const map = raw ? JSON.parse(raw) : null;
    const saved = (map && map[endpointId]) || null;
    const p = (typeof PRESETS === 'object' && PRESETS) ? PRESETS[endpointId] : null;
    const base = (saved && saved.base_url) || (p && p.base_url) || '';
    if (!base) return;
    group.endpoints[endpointId] = { name: (p && p.name) || endpointId, base_url: base,
                                    api_key: (saved && saved.api_key) || '' };
  } catch (e) { /* 取不到就回落当前端点（成员仍能发言，只是可能 1211） */ }
}

/** 确保 group.endpoints 里所有被成员引用的端点都已快照。 */
function groupHydrateEndpoints(group) {
  if (!group) return;
  group.endpoints = group.endpoints || {};
  (group.members || []).forEach(m => {
    const t = groupModelTarget(m.model);
    if (t) groupCaptureEndpoint(group, t.endpointId);
  });
}
