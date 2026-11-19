/* ================= R59 M6：token 估算/校准簇（早位叶模块） =================
 * 纯 token 估算（TOK-2 stride 采样 + W10 中文 3.2 校准）与 EMA 动态回校
 * （W10：usage.prompt_tokens 对账）——被 compaction/compact-command/tokens/
 * cost/run-controller 多方消费，估算是叶层能力：所有依赖单向指向本模块。
 * 原散落 agent/compaction.js（估算+阈值混居）与 analytics/tokens.js（本轮
 * 中转）——compact↔compaction 互绕环的最终拆解位。 */
/* ================= R59 M6：token 估算簇（自 agent/compaction.js 下沉） =================
 * TOK-2 stride 采样 + W10 中文 3.2 字符/token 校准——估算=计费域，纯函数零外部依赖。
 * 消息级缓存（historyTokens 每轮重算，WeakMap + 内容指纹防陈旧）。 */
const CJK_PER_TOK = 3.2;
function estTokens(s) {
  if (!s) return 0;
  s = String(s);
  const n = s.length;
  if (n <= 3000) {   // 短串全量，成本可忽略
    let ascii = 0;
    for (let i = 0; i < n; i++) if (s.charCodeAt(i) < 128) ascii++;
    return Math.ceil(ascii / 3.5 + (n - ascii) / CJK_PER_TOK);
  }
  const STRIDE = 3000, SEG = 1000;
  let tok = 0, sampled = 0;
  for (let start = 0; start < n; start += STRIDE) {
    const len = Math.min(SEG, n - start);
    let ascii = 0;
    for (let i = start; i < start + len; i++) if (s.charCodeAt(i) < 128) ascii++;
    tok += ascii / 3.5 + (len - ascii) / CJK_PER_TOK;
    sampled += len;
  }
  return Math.ceil(tok * (n / sampled));
}
const _estMsgCache = new WeakMap();
function _contentFp(s) {
  return (typeof s === 'string') ? (s.length + ':' + s.slice(0, 32) + '~' + s.slice(-32)) : '-';
}
function estTokensMsg(m) {
  if (!m || typeof m !== 'object') return estTokens(typeof m === 'string' ? m : '');
  const fp = _contentFp(m.content) + '|' + (m.tool_calls ? (m.tool_calls.length + ':' + _contentFp(JSON.stringify(m.tool_calls))) : '0');
  const hit = _estMsgCache.get(m);
  if (hit && hit.fp === fp) return hit.val;
  const v = estTokens(typeof m.content === 'string' ? m.content : '')
    + (m.tool_calls ? estTokens(JSON.stringify(m.tool_calls)) : 0);
  _estMsgCache.set(m, { fp: fp, val: v });
  return v;
}
const EST_CALIB_KEY = 'harbor_est_calib';
const _estCalib = { ratio: 1, n: 0 };
(function _estCalibLoad() {
  try {
    const saved = JSON.parse(localStorage.getItem(EST_CALIB_KEY) || '{}');
    if (saved && typeof saved.ratio === 'number' && typeof saved.n === 'number'
        && saved.n >= 3) {
      _estCalib.ratio = Math.min(1.8, Math.max(0.6, saved.ratio));
      _estCalib.n = saved.n;
    }
  } catch (e) { /* 无存储/损坏：保持默认 1 */ }
})();
function estTokensCalibrate(real, est) {
  try {
    const r = Number(real), e = Number(est);
    if (!(r > 0) || !(e > 0)) return _estCalib;   // 无效样本忽略（防 0/NaN 污染）
    const raw = Math.min(1.8, Math.max(0.6, r / e));   // 单样本先钳制再入 EMA
    _estCalib.n += 1;
    _estCalib.ratio = (_estCalib.n === 1)
      ? raw
      : _estCalib.ratio * 0.7 + raw * 0.3;
    _estCalib.ratio = Math.min(1.8, Math.max(0.6, _estCalib.ratio));
    // W10 对账告警（deep-research #6）：本地估算与服务端 usage 偏差 >5% 且样本
    // 足够时告警——系数可能又漂了（模型换版/语言构成变化），提醒复查
    if (_estCalib.n >= 3 && Math.abs(raw - 1) > 0.05) {
      _estCalib.last_deviation = raw;
      _estCalib.warned = true;
      try {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[estTokens] 估算偏差 %.0f%%（服务端 %d vs 本地 %d）——系数可能需复查',
                       (raw - 1) * 100, r, e);
        }
      } catch (e4) { /* 日志不阻塞 */ }
    }
    if (_estCalib.n >= 3) {
      try {
        localStorage.setItem(EST_CALIB_KEY,
          JSON.stringify({ ratio: _estCalib.ratio, n: _estCalib.n }));
      } catch (e2) { /* 存储不可用：内存校准仍生效 */ }
    }
  } catch (e3) { /* 任何异常不阻塞主流程 */ }
  return _estCalib;
}
function estTokensCalibrated(s) {
  return Math.ceil(estTokens(s) * _estCalib.ratio);
}
function historyTokens(msgs) {
  let t = 0;
  for (const m of (msgs || [])) t += estTokensMsg(m);
  return t;
}
