/* ================= 桥接 ================= */
/**
 * 双后端桥：pywebview（桌面壳）优先，fastify（Node 后端）回落。
 *
 * 形状保持不变：`callApi(name, argsArray, timeoutMs)` 的返回值仍是
 * 「legacy 各方法返回的 JSON 字符串」，因此上层 43 个契约方法与全部业务
 * 调用点零改动。HTTP 侧对应 `POST <HARBOR_API_BASE>/jsapi/<name>`，
 * 响应体直接取 text——与 pywebview 的返回类型一致。
 */

/** Node 后端地址；未配置（纯桌面运行）时返回空串，走 pywebview。 */
function harborApiBase() {
  if (typeof window === 'undefined') return '';
  return String(window.HARBOR_API_BASE || '').replace(/\/+$/, '');
}

function harborHttpAvailable() {
  return !!harborApiBase() && typeof fetch === 'function' && typeof AbortController === 'function';
}

async function callApiHttp(name, args, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(harborApiBase() + '/jsapi/' + encodeURIComponent(name), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: args || [] }),
      signal: controller.signal,
    });
    if (!response.ok) {
      // 保留响应体：后端的结构化错误（NOT_MIGRATED/BAD_PARAMS）对排障更有用
      const text = await response.text();
      throw new Error('HTTP ' + response.status + ' ' + name + ': ' + text.slice(0, 300));
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function callApi(name, argsArray, timeoutMs) {
  const args = argsArray || [];
  // 修复 ㉞：timeoutMs 显式判断（原 `timeoutMs || 60000` 吞 0 值）
  const ms = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 60000;
  const hasNative = typeof window !== 'undefined' && window.pywebview &&
    window.pywebview.api && window.pywebview.api[name];
  if (!hasNative) {
    if (harborHttpAvailable()) return callApiHttp(name, args, ms);
    throw new Error('pywebview bridge 未就绪: ' + name);
  }
  let timer = null;
  try {
    // 修复 ㉞：竞速定时器 clearTimeout——成功返回后不再空留一个 60s 后才触发的 reject
    return await Promise.race([
      window.pywebview.api[name](...args),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('调用超时: ' + name)), ms); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
/* 修复 ㉞：backendErrorMsg 为死代码（全项目无调用点）——已删除 */
