/* ================= 成本透明化（v1.2 R5） =================
 * 1) 会话头部实时「本会话约花费 ¥X」（标准输入/缓存命中/输出三价细分 → 75-token-stat 展示）
 * 2) 发送前预估费用区间（输入框聚焦/输入时刷新 #costEstimate）
 * 3) 1113 等错误码人话映射（humanizeApiError，60-agent-loop 错误路径使用）
 */

const ERROR_HUMANIZE = [
  [/1113|余额不足.*coding|coding plan/i,
    'GLM Coding Plan 仅限官方指定工具使用，API 直连会报 1113。\n可行操作：① 在 bigmodel.cn 充值按量付费并使用平台 API Key；② 或切换到自定义 OpenAI 兼容端点（设置 → 模型服务商）。'],
  // 修复（2026-10-21 用户实测 P0）：GLM 1211 = 模型不存在/已下线/Key 无权限。
  // 实测链路：glm-5.3-flash → GLM 400 1211；该 4xx 响应无 CORS 头 → 前端 fetch
  // 被 EdgeWebView 拦成「Failed to fetch」（真因被吞），后端测试连接才看得到
  // 1211 原文。人话必须给「换模型」的明确出路。
  [/\b1211\b|模型[^\n]{0,16}(不存在|未上线|已下线|已下架|无权限|未授权|不可用)|无权访问[^\n]{0,6}模型/i,
    '模型不可用（GLM 1211）：该模型不存在、已下线，或当前 API Key 无访问权限。\n可行操作：① 设置 →「获取模型」拉取当前 Key 可用的模型清单，换一个（如 glm-4.5）；② 或手动输入其他模型名；③ 或切到「FreeToken Desktop / Ollama」本地预设用本地模型。'],
  // 404 也要先按模型特征分流（GLM 等对下线模型返回 404 model not found）
  [/model[^\n]{0,24}(not\s+(found|exist)|不存在|已下线|下线|deprecat)|不存在[^\n]{0,4}模型/i,
    '模型不存在或已下线：请更换模型（点「获取模型」刷新清单，或手动输入其他模型名）。'],
  [/\b401\b|invalid.*key|unauthorized/i, 'API Key 无效或未授权：请检查设置中的 Key 是否正确、是否属于所选服务商。'],
  [/\b403\b/i, '无权访问该端点（Key 权限不足或 IP 受限）。'],
  [/\b404\b/i, '端点地址不存在：请检查 Base URL（OpenAI 兼容端点通常需要 /v1 后缀）。'],
  [/\b429\b|rate.?limit/i, '请求过于频繁或额度耗尽：\n① 智谱 GLM：请到 open.bigmodel.cn 检查账户余额与调用配额（免费层有 RPM/RPD 限制）；\n② 稍等 30-60 秒重试；③ 或切换其他服务商预设（设置 → 连接与模型）。'],
  // 修复（2026-10-21）：Failed to fetch 在 GLM 云端场景常是「服务端 4xx 响应无
  // CORS 头被浏览器吞」——先导用户去「测试连接」看真实返回，而不是一句「检查网络」
  [/failed to fetch|networkerror|ENOTFOUND|timeout/i,
    '请求被网络层拦截。\n① 先在设置里点「测试连接」——服务端的真实错误（如模型不可用 1211）可能被浏览器安全策略吞掉，测试连接走后端通道能看到原文；\n② 若测试连接正常，再检查网络/代理；GLM 端点在国内直连通常无需代理。'],
];

/* 修复 B4（v1.5）：local 模式错误分类口径（与后端 classify_local_error 同文案）——
 * Ollama 特情（503 loading / 404 模型引导 / 401 免 Key / 400 超窗）。 */
const ERROR_HUMANIZE_LOCAL = [
  [/\b503\b|loading|is loading/i,
    '模型正在加载（本地服务器首次提问需 10-60s），已自动等待重试；反复出现请确认模型名或到「设置 → 本地模型」重新测试连接。'],
  [/\b404\b/i,
    '本地端点返回 404：① 模型名不存在（区分大小写）——请回模型清单重选；② 地址不对——Base URL 通常需要 /v1 后缀（如 http://localhost:11434/v1）。'],
  [/\b401\b/i, '未授权（401）：本地服务器通常无需 Key，请在设置中清空 API Key 重试。'],
  [/\b429\b/i, '本地服务器限流：稍等重试；持续出现请检查并发设置。'],
];

/* 实现 v1.6 T3：GitHub Models 免费层 429 人话映射（外部核实 2026-10，方案 §9：
 * GitHub 用响应头区分「请求频率(RPM)」与「每日配额(RPD)」）。从响应头解析
 * （x-ratelimit-remaining / retry-after 等，键名容忍大小写与别名）；
 * 解析失败返回 null → 调用方回落通用 429 文案（T14 验收两分支 100% 覆盖）。 */
const GITHUB_429_RPM_TEXT =
  '请求频率超限（GitHub 免费层约 15 RPM）：已到每分钟请求上限。\n可行操作：① 等待约 1 分钟窗口重置后重试；' +
  '② 合并工具调用轮次、读类并行发起，减少请求数；③ 高频使用请切换 DeepSeek/GLM 付费层。';
const GITHUB_429_RPD_TEXT =
  '每日配额耗尽（GitHub 免费层约 150 RPD）：今日免费额度已用完。\n可行操作：① 等待次日（UTC 0 点）额度重置；' +
  '② 切换 DeepSeek/GLM 付费层继续。';

/** 429 响应头 → RPM/RPD 人话（无法区分时返回 null，走通用文案）。 */
function humanizeGithub429(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const flat = {};
  try {
    Object.keys(headers).forEach(k => { flat[String(k).toLowerCase()] = String(headers[k]); });
  } catch (e) { return null; }
  let rpmHit = false, rpdHit = false, retryAfter = 0;
  Object.keys(flat).forEach(k => {
    const v = parseInt(flat[k], 10);
    if (/retry-after/.test(k) && v > 0) { retryAfter = v; return; }
    if (!/remaining/.test(k)) return;
    // 语义判据（按外部源描述实现 + 容错）：键名含 day/daily/rpd → 日额度；
    // 含 min/request/rpm 或裸 remaining → 每分钟频率；仅 remaining==0 判超限。
    if (!(v === 0)) return;
    if (/day|daily|rpd/.test(k)) rpdHit = true;
    else if (/min|request|rpm/.test(k) || k === 'x-ratelimit-remaining') rpmHit = true;
  });
  const wait = retryAfter > 0 ? '\n（服务端 retry-after: ' + retryAfter + ' 秒）' : '';
  if (rpdHit) return GITHUB_429_RPD_TEXT + wait;
  if (rpmHit) return GITHUB_429_RPM_TEXT + wait;
  return null;
}

/* 实现 v1.6 遗留 L1：真实端点错误体校准（2026-10-19 主理人真机探测取证）——
 * DeepSeek 真 401 体：{"error":{"message":"Authentication Fails, Your api key:
 * ****e000 is invalid (request_id: 37dfc259-...)","type":"authentication_error"}}
 * GLM 真 401 体：{"error":{"code":"1000","message":"身份验证失败。"}}
 * 通用 401 文案太泛，这两个分支给出「哪家错 + request_id 可定位」。
 * 注意：DeepSeek 错误体里 "invalid" 在 "key" 之后，通用表 invalid.*key 匹配不到，
 * 必须靠本分支的 Authentication Fails 特征命中。 */
function humanizeAuthError(raw) {
  const rid = /request_id[":\s]+([0-9a-zA-Z-]{8,})/i.exec(raw);
  const idTail = rid ? '\n（request_id: ' + rid[1] + '，排查时一并向官方提供可快速定位）' : '';
  if (/Authentication Fails/i.test(raw)) {
    return 'API Key 无效（DeepSeek 鉴权失败）：请检查设置中的 Key 是否正确、是否已启用。' + idTail;
  }
  if (/身份验证失败/.test(raw) || /"code"\s*:\s*"?1000"?/.test(raw)) {
    return 'API Key 无效（GLM 平台错误码 1000 = 鉴权失败）：请检查设置中的 Key 是否正确、是否属于所选服务商。' + idTail;
  }
  return null;
}

function humanizeApiError(msg, isLocal, headers) {
  const raw = String(msg || '');
  // 实现 v1.6 遗留 L1：DeepSeek/GLM 真错误体特征优先于通用 401 表（仅云端路径；
  // local 模式让位本地表——Ollama 前的代理错误体罕见，免 Key 提示更贴切）
  const auth = isLocal ? null : humanizeAuthError(raw);
  if (auth) return auth + '\n\n（原始错误：' + raw.slice(0, 300) + '）';
  // 实现 v1.6 T3：429 且带响应头 → 先试 GitHub 频率/日额分支（云端路径；local 表优先）
  if (!isLocal && (/\b429\b/.test(raw) || /rate.?limit/i.test(raw))) {
    const gh = humanizeGithub429(headers);
    if (gh) return gh + '\n\n（原始错误：' + raw.slice(0, 300) + '）';
  }
  const table = isLocal ? ERROR_HUMANIZE_LOCAL : ERROR_HUMANIZE;
  for (const [pat, text] of table) {
    if (pat.test(raw)) return text + '\n\n（原始错误：' + raw.slice(0, 300) + '）';
  }
  // 修复 B4：local 模式未命中本地表时回落通用表（不丢 1113 等既有映射）
  if (isLocal) {
    for (const [pat, text] of ERROR_HUMANIZE) {
      if (pat.test(raw)) return text + '\n\n（原始错误：' + raw.slice(0, 300) + '）';
    }
  }
  return raw;
}

/** 预估下一次请求费用（v1.8.0 W10：上下文估算改 estTokens 分层采样 + usage
 * 回校校准系数；无该函数时回落 chars/1.7 粗估）。 */
function estimateNextCost(s) {
  let chars = 0;
  let text = '';
  (s && s.messages ? s.messages : []).forEach(m => {
    const c = typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.map(p => p.text || '').join('') : '';
    text += c;
    if (m.tool_calls) text += JSON.stringify(m.tool_calls);
    chars += c.length;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  });
  const inputTokens = (typeof estTokensCalibrated === 'function')
    ? estTokensCalibrated(text)
    : Math.ceil(chars / 1.7);
  const outputTokens = 1024;   // 假定一轮输出
  const model = providerState.enabled ? (providerState.model || '') : (document.getElementById('modelSelect')?.value || 'glm-5.3-flash');
  const p = providerPriceFor(model);
  const costIn = inputTokens * p.in / 1e6;
  const costOut = outputTokens * p.out / 1e6;
  return { inputTokens, low: costIn * 0.3 + costOut, high: costIn + costOut };
}

// 修复 ㉚（三轮）：每按键全量估算改防抖——原每次 input 事件都全量遍历消息序列
// （含 JSON.stringify(tool_calls)）重算费用。200ms 合并窗口内多次调用只算一次，
// 末态必达（纯展示标签，无落盘依赖）。
let _costEstTimer = 0;
function updateCostEstimate() {
  clearTimeout(_costEstTimer);
  _costEstTimer = setTimeout(_updateCostEstimateNow, 200);
}
function _updateCostEstimateNow() {
  const el = document.getElementById('costEstimate');
  if (!el) return;
  const s = getCurrentSession();
  if (!s || s.messages.length === 0) { el.textContent = ''; return; }
  const est = estimateNextCost(s);
  el.textContent = '下次发送预估 ¥' + est.low.toFixed(3) + '–' + est.high.toFixed(3) +
    '（含上下文 ' + est.inputTokens.toLocaleString() + ' tok，缓存命中取低值）';
}
