/* ================= 压缩 ================= */
// v1.1.1 省 token：截图三档（视觉 token 是最大开销之一）
const SHOT_PRESETS = {
  low:  { maxSide: 512, quality: 0.40, label: '省流' },
  std:  { maxSide: 640, quality: 0.50, label: '标准' },
  full: { maxSide: 768, quality: 0.55, label: '完整' }
};
function shotPreset() {
  const el = document.getElementById('shotQuality');
  return SHOT_PRESETS[(el && el.value) || 'low'] || SHOT_PRESETS.low;
}
/**
 * 自动裁掉纯色边缘（任务栏/黑边/空白），再按档位压缩。
 * 采样步长 4px 判断"整行/整列近似同色"，最多各裁 25%。
 */
function autoCropCanvas(c) {
  try {
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const w = c.width, h = c.height;
    if (w < 40 || h < 40) return c;
    const d = ctx.getImageData(0, 0, w, h).data;
    const at = (x, y) => { const i = (y * w + x) * 4; return d[i] + ',' + d[i + 1] + ',' + d[i + 2]; };
    const rowUniform = (y) => {
      const ref = at(0, y);
      for (let x = 4; x < w; x += 4) if (at(x, y) !== ref) return false;
      return true;
    };
    const colUniform = (x) => {
      const ref = at(x, 0);
      for (let y = 4; y < h; y += 4) if (at(x, y) !== ref) return false;
      return true;
    };
    let top = 0, bottom = 0, left = 0, right = 0;
    const maxV = Math.floor(h * 0.25), maxH = Math.floor(w * 0.25);
    while (top < maxV && rowUniform(top)) top++;
    while (bottom < maxV && rowUniform(h - 1 - bottom)) bottom++;
    while (left < maxH && colUniform(left)) left++;
    while (right < maxH && colUniform(w - 1 - right)) right++;
    const nw = w - left - right, nh = h - top - bottom;
    if (nw < w * 0.3 || nh < h * 0.3 || (left + right + top + bottom) < 8) return c;
    const out = document.createElement('canvas');
    out.width = nw; out.height = nh;
    out.getContext('2d').drawImage(c, left, top, nw, nh, 0, 0, nw, nh);
    return out;
  } catch (e) { return c; }
}
const COMPRESS_IMG_TIMEOUT_MS = 3000;   // 解码兜底：onload 不触发（异常 dataUrl）时 3s 回落原图，防 Promise 永久挂起
function compressImage(dataUrl, maxSide = 1024, quality = 0.75, crop = false) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    };
    // 3s 兜底：img.onload/onerror 都不触发时回落原 dataUrl（附件链不卡死）
    timer = setTimeout(() => finish(dataUrl), COMPRESS_IMG_TIMEOUT_MS);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      if (scale >= 1 && dataUrl.length < 300000 && !crop) { finish(dataUrl); return; }
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      try {
        const out = crop ? autoCropCanvas(c) : c;
        finish(out.toDataURL('image/jpeg', quality));
      } catch (e) { finish(dataUrl); }
    };
    img.onerror = () => finish(dataUrl);
    img.src = dataUrl;
  });
}
/** 截图专用：按用户档位 + 自动裁边 */
async function compressScreenshot(dataUrl) {
  const p = shotPreset();
  return compressImage(dataUrl, p.maxSide, p.quality, true);
}
function compressCliOutput(out, cap = 8000) {
  if (!out) return '';
  const lines = String(out).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n').map(l => l.replace(/\s+$/,'')).filter(l => l.trim());
  const folded = [];
  for (const l of lines) {
    const p = folded[folded.length-1];
    if (p && p.l === l) p.n++; else folded.push({ l, n: 1 });
  }
  let t = folded.map(x => x.n > 3 ? `${x.l}   （×${x.n}）` : x.l).join('\n');
  if (t.length > cap) t = t.slice(0, cap*0.6) + '\n…[中段折叠]…\n' + t.slice(-cap*0.4);
  return t;
}
function sumSessionTokens(s) {
  let t = 0;
  (s.messages || []).forEach(m => { if (m.usage) t += (m.usage.total_tokens || 0); });
  return t;
}
