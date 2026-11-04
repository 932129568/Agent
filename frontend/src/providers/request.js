/* ================= A7 请求防抖与显式 transport ================= */
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => {
    clearTimeout(t);
    reject(new DOMException('Aborted', 'AbortError'));
  }, { once: true });
});

/* 单一流式实现。endpoint 是非秘密 EndpointRef 快照/显式解析器；
 * apiKey 仅由调用方注入并放入 Authorization，不写日志、不读全局覆盖显式值。 */
async function modelTransportStream(request, signal) {
  const body = request.body || {};
  if (body && Array.isArray(body.messages)) {
    body.messages = normalizeSystemMessages(body.messages);
  }
  const isLocal = !!request.local;
  const sleepAbortable = ms => sleep(ms, signal);
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
