/* ================= v3.4 I26（后半）· 吞吐率调速星轨 =================
 * 目的：施工总册 I26 的「吞吐率调速星轨」——星轨转速跟随真实出字速度，而不是恒定。
 *
 * 关键：**不拍一个映射**，而是用真实的 chunk 到达间隔算速率：
 *   cps = 字符数 / 秒（滑动窗口 8 次采样）
 * 再把 cps 线性映射到动画时长（快则短、慢则长），并夹在上下界内。
 *
 * 边界（为什么必须有界）：
 *   · 太快 → 时长趋 0 会看起来像抽搐；下限 320ms；
 *   · 太慢 → 时长过长会像卡死；上限 2600ms；
 *   · 首字之前没有任何采样 ⇒ 用默认值，**不假装知道速度**。
 *
 * 全部副作用只有一条：给 documentElement 设 `--dur-stream-orbit`。
 */

const STREAM_RATE_WINDOW = 8;      // 滑动窗口采样数
const STREAM_DUR_MIN = 320;        // ms
const STREAM_DUR_MAX = 2600;       // ms
const STREAM_CPS_FAST = 90;        // 达到这个 cps 就给最短时长
const STREAM_CPS_SLOW = 4;         // 低于这个 cps 就给最长时长

const _samples = [];               // {ms, chars}

/** 记一次 chunk 到达。ms = 距上次 chunk 的毫秒数，chars = 本次新增字符数。 */
function streamRateSample(ms, chars) {
  const gap = Number(ms);
  // 过滤异常采样：非数字/负数/大于 10 秒（切后台、工具等待）都不该拉低速率的判断
  if (!Number.isFinite(gap) || gap < 0 || gap > 10000) return null;
  const n = Math.max(0, Number(chars) || 0);
  if (!n && gap < 1) return null;
  _samples.push({ ms: Math.max(1, gap), chars: n });
  while (_samples.length > STREAM_RATE_WINDOW) _samples.shift();
  return streamRateOf();
}

/** 当前窗口的 cps（无采样 ⇒ null，表示"还不知道"）。 */
function streamRateOf() {
  if (!_samples.length) return null;
  let chars = 0, ms = 0;
  for (const s of _samples) { chars += s.chars; ms += s.ms; }
  if (ms <= 0) return null;
  return Math.round((chars / ms) * 1000 * 10) / 10;
}

/** cps → 动画时长（ms）。单调递减，夹在 [MIN, MAX]。 */
function streamRateDuration(cps) {
  const v = Number(cps);
  if (!Number.isFinite(v) || v <= 0) return STREAM_DUR_MAX;   // 不知道速度 ⇒ 用最保守（最慢）
  const t = (v - STREAM_CPS_SLOW) / (STREAM_CPS_FAST - STREAM_CPS_SLOW);
  const clamped = Math.max(0, Math.min(1, t));
  const dur = STREAM_DUR_MAX - clamped * (STREAM_DUR_MAX - STREAM_DUR_MIN);
  return Math.round(dur);
}

/** 把当前速率写进 CSS 变量。返回 {cps, dur}（cps 为 null 表示还没有采样）。 */
function streamRateApply() {
  if (typeof document === 'undefined') return { cps: null, dur: STREAM_DUR_MAX };
  const cps = streamRateOf();
  const dur = streamRateDuration(cps);
  try {
    document.documentElement.style.setProperty('--dur-stream-orbit', dur + 'ms');
  } catch (e) {}
  return { cps, dur };
}

function streamRateReset() { _samples.length = 0; }
