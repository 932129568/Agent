/* ================= A7 请求防抖与显式 transport ================= */
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => {
    clearTimeout(t);
    reject(new DOMException('Aborted', 'AbortError'));
  }, { once: true });
});

/* 免费档模型识别（2026-11-04 真机报障：同 Key 付费模型可用、免费模型 429）。
 * 智谱免费档（glm-4-flash / glm-4.5-flash 等 *-flash）的 RPM/RPD 与并发显著
 * 低于付费档：单轮 Agent 任务里连续工具轮次可在 1 分钟内打出十几条请求，
 * 付费档无感、免费档立刻 429。识别后由下面的 pacer 做节流。 */
const FREE_TIER_MODEL_RE = /(^|[-_/])flash([-_/]|$)|free/i;
function isFreeTierModel(name) {
  return FREE_TIER_MODEL_RE.test(String(name || ''));
}

/* 免费档请求节流：全局串行 + 最小间隔。付费/本地不走此队列（并发能力保留）。
 * 目的是把「1 分钟内 15 条」摊平到免费档 RPM 之内，而不是靠 429 后再退避。 */
const FREE_TIER_MIN_INTERVAL_MS = 3200;
let _freeTierChain = Promise.resolve();
let _freeTierLastStart = 0;
function paceFreeTier(signal, sleepAbortable) {
  const run = _freeTierChain.then(async () => {
    const wait = Math.max(0, _freeTierLastStart + FREE_TIER_MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await sleepAbortable(wait);
    _freeTierLastStart = Date.now();
  });
  _freeTierChain = run.then(() => undefined, () => undefined);
  return run;
}

/* 单一流式实现。endpoint 是非秘密 EndpointRef 快照/显式解析器；
 * apiKey 仅由调用方注入并放入 Authorization，不写日志、不读全局覆盖显式值。 */
async function modelTransportStream(request, signal) {
  const body = request.body || {};
  if (body && Array.isArray(body.messages) && typeof normalizeSystemMessages === 'function') {
    body.messages = normalizeSystemMessages(body.messages);
  }
  const isLocal = !!request.local;
  const sleepAbortable = ms => sleep(ms, signal);
  // 免费模型：剔除思考档参数（flash 系不支持 reasoning_effort/thinking，
  // 部分网关会因此返回参数错误或被误判为异常请求）+ 全局节流
  if (!isLocal && isFreeTierModel(body.model)) {
    if (body.thinking) delete body.thinking;
    if (body.reasoning_effort) delete body.reasoning_effort;
    try { await paceFreeTier(signal, sleepAbortable); } catch (e) { if (e && e.name === 'AbortError') throw e; }
  }
  let attempt = 0;
  let rateLimitAttempt = 0;
  const LOADING_BACKOFF = [2000, 4000, 8000];
  // 429 退避（2026-11-04 真机报障：换机装完即 429、原机正常）：智谱免费档为
  // **分钟级**配额/并发限制，原逻辑只重试 1 次且仅等 2 秒——秒级重试必然再次
  // 撞墙，用户观感就是「一装就废」。改为 3 次指数退避（4s/12s/30s 跨越配额
  // 窗口），并优先遵循服务端 Retry-After。
  const RATE_LIMIT_BACKOFF = [4000, 12000, 30000];
  while (true) {
    try {
      const endpoint = (typeof request.endpoint === 'function')
        ? request.endpoint() : request.endpoint;
      const extraHeaders = (typeof request.proxyHeaders === 'function')
        ? request.proxyHeaders() : (request.proxyHeaders || {});
      const resp = await fetch(endpoint, {
        method: 'POST', signal,
        headers: Object.assign({ 'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + request.apiKey }, extraHeaders),
        body: JSON.stringify(body),
      });
      if (isLocal && resp.status === 503 && attempt < LOADING_BACKOFF.length) {
        await sleepAbortable(LOADING_BACKOFF[attempt]);
        attempt++;
        continue;
      }
      if (resp.status === 429) {
        let body429 = '';
        try { body429 = await resp.clone().text().catch(() => ''); } catch (e) { body429 = ''; }
        // 余额/欠费类不是限流，重试无意义，立刻交回上层给准确提示
        if (/余额|欠费|arrears|insufficient|quota|exhaust|billing|账户|充值/i.test(body429)) return resp;
        if (rateLimitAttempt < RATE_LIMIT_BACKOFF.length) {
          let ra = NaN;
          try { ra = Number(resp.headers && resp.headers.get && resp.headers.get('retry-after')); } catch (e) {}
          const waitMs = Number.isFinite(ra) && ra > 0
            ? Math.min(60000, ra * 1000)
            : RATE_LIMIT_BACKOFF[rateLimitAttempt];
          rateLimitAttempt++;
          await sleepAbortable(waitMs);
          continue;
        }
        return resp;
      }
      if (resp.status >= 500 && attempt < 1) {
        attempt++;
        await sleepAbortable(1200);
        continue;
      }
      return resp;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (attempt < 1) {
        attempt++;
        await sleepAbortable(1000);
        continue;
      }
      throw e;
    }
  }
}

const ModelTransport = Object.freeze({ stream: modelTransportStream });

/* 旧调用方薄封装：全局配置只在这里解析一次入口，随后复用同一 transport。 */
async function fetchGLMStream(payload, signal) {
  return ModelTransport.stream({
    endpoint: () => resolveApiEndpoint(),
    apiKey: payload.apiKey,
    body: payload.body || payload,
    local: typeof localState !== 'undefined' && localState.mode,
    proxyHeaders: (typeof localProxyHeaders === 'function') ? localProxyHeaders() : {},
  }, signal);
}
