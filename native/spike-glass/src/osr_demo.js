// osr_demo.js -- 通路 B Demo: Electron 45 OSR 共享纹理 -> 原生 DComp 单链
//
// 用法（务必清掉 ELECTRON_RUN_AS_NODE / NODE_OPTIONS，否则 Electron 会退化成纯 Node）:
//   env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
//     node_modules/electron/dist/electron.exe native/spike-glass/src/osr_demo.js
//
// 负控（必做三组，跑完立刻还原复跑）:
//   OSR_NC=nc1  -> 静态页面（rAF 还在跑但不再改 DOM），预期判据① FAIL（只出 1 帧）
//   OSR_NC=nc2  -> 显式 stopPainting() 后不再 startPainting()，预期 0 帧 / 判据① FAIL
//                  （实测：单纯"不调 startPainting()"在 Electron 45 下**不出负控** ——
//                   OSR 窗口默认就在出帧，startPainting 只负责从 stopPainting 恢复。
//                   所以负控改为显式 stopPainting，测的是同一个机制：painting 必须被开启。）
//   OSR_NC=nc3  -> 传伪造 handle（全 0 Buffer），预期 OpenSharedResource1 返回非 0，判据红
//
// 关键实测事实（M2 前置取证，勿"优化"）:
//   1. 共享句柄字段是 `textureInfo.handle.ntHandle`（Buffer, 8 字节），
//      **不是** `textureInfo.sharedTextureHandle` —— 源方案文档此处是错的。
//   2. OSR 隐藏窗口不会自动出帧: 必须 startPainting() **且** 页面有真实视觉变化。
//   3. 必须逐次串行 invalidate()（间隔 ~25ms），并发请求会被 Chromium 合并。
//   4. 100% 出帧是假红线: 实测 201 帧里 168 帧带纹理（83.6%），故阈值取 70%。

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

// ELECTRON_RUN_AS_NODE 生效时 require('electron') 返回的是可执行文件路径字符串，
// 此时没有 app 对象 —— 直接判死，避免"秒退 0"这种最难排查的假象。
if (!app || typeof app.whenReady !== 'function') {
  console.log('FATAL=ELECTRON_RUN_AS_NODE_ENV_PRESENT (unset ELECTRON_RUN_AS_NODE / NODE_OPTIONS)');
  process.exit(9);
}

const NC = String(process.env.OSR_NC || '').toLowerCase();   // '' | nc1 | nc2 | nc3
// OSR_LABEL 允许采集驱动把「轮次」写进结果文件名。缺省会退回 nc/pass。
// 为什么必须支持：3 轮采集若共用同一文件名，后跑的把先跑的覆盖，
// 最终「3 轮」退化成 1 轮，而汇总仍显示 rounds=3。
const LABEL = String(process.env.OSR_LABEL || NC || 'pass');

// ---- Refresh-rate tier. ---------------------------------------------------
// OSR_HZ selects the display tier the demo is validated at. Two values only:
//  60  = the baseline tier most machines can hit, and the tier the M1/E11
//        evidence was gathered at.
//  165 = this workstation's actual panel rate. The interesting tier, because a
//        pacing bug that is invisible at 60 Hz (16.67 ms budget) becomes visible
//        at 165 Hz (6.06 ms budget).
// Anything else is a hard error. Silently coercing an unknown tier would let a
// typo ('1650', '144') run at some default and be reported as that tier.
const ALLOWED_HZ = [60, 165];
const OSR_HZ = (() => {
  const raw = process.env.OSR_HZ;
  if (raw === undefined || raw === '') return 60;
  const n = Number(raw);
  if (!Number.isFinite(n) || !ALLOWED_HZ.includes(n)) {
    console.log(`FATAL=BAD_OSR_HZ value="${raw}" allowed=${ALLOWED_HZ.join('|')}`);
    process.exit(11);
  }
  return n;
})();
const TARGET_FPS = OSR_HZ;
const COLLECT_MS = Number(process.env.OSR_COLLECT_MS || 10000);  // 采集窗口 >= 10s
const WARMUP_MS = Number(process.env.OSR_WARMUP_MS || 1500);
const WIN_W = 640;
const WIN_H = 400;
// NOMINAL period of the requested tier. Used ONLY as a sanity band on the
// measured vsync base -- never as the denominator of maxGapCycles. See the
// criterion-2 block at the summary for why.
const SYNTHETIC_PERIOD_MS = 1000 / TARGET_FPS;
const TEXTURE_RATIO_MIN = 0.70;                  // 判据①(70%，依据 E11 实测 83.6%)
const MAX_MISS_FRAMES = 3;                       // 判据②(<= 3 个显示节拍)
const FAKE_HANDLE = Buffer.alloc(8);             // 负控 B3: 全 0 句柄
// invalidate() 的角色: **串行补帧看门狗**，不是主驱动。
//
// 实测（本机，60fps 目标，10s 窗口）:
//   * 盲发 invalidate()（每 25ms 一次，不看是否已经出帧）
//        paints/rAF = 1.54x，其中 323 次 paint 不带纹理 —— 因为 BeginFrame 被额外拉起，
//        页面在这两个 BeginFrame 之间没有新脏区，Chromium 交出无纹理帧。
//        判据③(paint/rAF ∈ (0,1]) 因此 FAIL。
//   * 完全不发 invalidate()，只靠页面 rAF 动画改 DOM
//        paints/rAF = 1.00x，带纹理帧 99.7% —— 真实视觉变化自己就会驱动合成。
//   * 静态页面 + 盲发 invalidate()
//        大量 paint 但带纹理帧 ≈ 0（Chromium 合并重绘，脏区为空）。
//
// 结论: "持续出帧"的真实驱动源是「页面有视觉变化」；invalidate() 的正确职责是
// **在停帧时补一脚**。所以这里保留串行 invalidate（严格 25ms、单循环、不并发），
// 但只在检测到已经断帧超过 STALL_THRESHOLD_MS 时才发 —— 既满足"串行补帧"，
// 又不会把 paint/rAF 稀释掉。静态页面(NC-B1)下看门狗会持续发 invalidate，
// 依然拿不到带纹理帧，正是判据①要抓的行为。
const NO_INVALIDATE = process.env.OSR_NO_INVALIDATE === '1';   // 实验开关: 彻底关掉看门狗
const INVALIDATE_GAP_MS = Number(process.env.OSR_INVALIDATE_GAP_MS || 25);
const STALL_THRESHOLD_MS = Number(process.env.OSR_STALL_MS || 45);  // ~2.7 个合成周期

const addonPath = path.join(__dirname, 'addon', 'build', 'Release', 'harbor_osr.node');

// addon 加载失败 **必须显式判死**，绝不能静默降级。
//
// 【为什么这里不能有 fallback】通路 B 唯一成立的形态是「NT 共享句柄 -> OpenSharedResource1
// 零拷贝」。如果 .node 不在，而这里退回"CPU 回读像素再上传"的替代路径，那条路**能跑通、
// 判据还会 PASS** —— 正是源方案明令禁止的慢路（60MB/s PCIe 往返 + 每帧 GPU->CPU 同步点），
// 也是整个 Spike 最危险的假绿。所以 .node 缺失 = 通路 B 未验证 = 直接非 0 退出。
let native = null;
let addonLoadError = '';
try {
  native = require(addonPath);
} catch (err) {
  addonLoadError = err && err.message ? err.message : String(err);
}

// 即使 .node 加载成功，也要校验它**确实是 harbor_osr**（而不是同目录别的 addon，
// 例如 T01 的 harbor_spike.node —— 它导出 hostVersion/probeSelf，没有 hostInit）。
// 少了这一步，误指向另一个 .node 时会在 hostInit() 抛 TypeError，报错信息完全不指向真因。
const REQUIRED_EXPORTS = ['hostInit', 'hostPresent', 'hostStats', 'hostShutdown',
                          'openSharedTexture', 'compareScreenAndTexture'];
let missingExports = [];
if (native) {
  missingExports = REQUIRED_EXPORTS.filter((name) => typeof native[name] !== 'function');
  if (missingExports.length > 0) {
    addonLoadError = 'addon loaded but missing exports: ' + missingExports.join(',');
    native = null;
  }
}

// ---------------------------------------------------------------------------
// 统计容器
// ---------------------------------------------------------------------------
function newStats() {
  return {
    paints: 0,
    withTexture: 0,
    withoutTexture: 0,
    withNtHandle: 0,
    released: 0,
    paintFailed: 0,
    hostQueued: 0,
    hostPresentFail: 0,
    fakeOpenHr: null,
    fakeOpenBlocked: 0,
    texStamp: [],            // 带纹理帧的时间戳（ms）
    maxConsecutiveMiss: 0,
    // 帧间隔统计（判据②的时间口径，作为附加证据）
    maxGapMs: 0,
    errors: [],
    texInfo: null,
  };
}
let stats = newStats();
let consecutiveMiss = 0;
let lastTexStampMs = 0;

function markMiss() {
  consecutiveMiss += 1;
  if (consecutiveMiss > stats.maxConsecutiveMiss) stats.maxConsecutiveMiss = consecutiveMiss;
}

function pushError(text) {
  if (stats.errors.length < 12) stats.errors.push(text);
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------
// ANIMATE=false 用于 NC-B1: rAF 仍在递增（保证判据①分母有效），但不再改 DOM。
// 这样才能真正测到"没有视觉变化 -> Chromium 合并重绘 -> 只剩 1 帧带纹理"。
function buildHtml(animate = true, opaque = false) {
  // opaque=true 时把所有半透明元素改成不透明。
  // 用途: 像素恒等自证的**严格档**。半透明区域在 PREMULTIPLIED 交换链上会被 DComp
  // 与"交换链 alpha=1"的底做混合，屏幕像素因此合法地不等于纹理像素（实测差 ~13% 面积）。
  // 不透明页面则完全相等 —— 用它把"合成链路本身"和"alpha 混合的正确行为"分开验证。

  const boxFill = opaque ? 'rgba(200,215,235,1)' : 'rgba(255,255,255,.22)';
  const shadow = opaque ? 'none' : '0 8px 30px rgba(0,0,0,.35)';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;overflow:hidden;background:#0b1020}
  #grad{position:absolute;inset:0;background:linear-gradient(120deg,#123 0%,#1a3a5c 45%,#456 100%)}
  #box{position:absolute;left:0;top:0;width:180px;height:110px;border-radius:20px;
       background:${boxFill};border:2px solid #fff;
       box-shadow:${shadow}}
  #label{position:absolute;left:16px;bottom:14px;color:#eaf2ff;font:700 16px/1.4 "Segoe UI",sans-serif;
         letter-spacing:.5px;text-shadow:0 2px 8px rgba(0,0,0,.6)}
  </style></head><body>
  <div id="grad"></div><div id="box"></div>
  <div id="label">Harbor 通路B · Electron OSR → DComp 单链</div>
  <script>
    window.__rafCount = 0;
    var animate = ${animate ? 'true' : 'false'};
    // opaque 模式（像素恒等严格档）下禁用 opacity 动画。
    //
    // 【这是一个真实踩过的坑】卡片 CSS 的 background 虽然改成了不透明色，
    // 但动画里的 box.style.opacity 会让它重新变成半透明合成层。
    // 在 PREMULTIPLIED 交换链上，这等于整块卡片区域被 DComp 与底混合，
    // 屏幕像素**合法地**不等于纹理像素 —— 实测 matchRatio 稳定卡在 0.90394，
    // 差异面积恰好是卡片本身（约 10%），且每次都是同一个数值（确定性，不是竞态）。
    var animateOpacity = ${animate && !opaque ? 'true' : 'false'};
    var box = document.getElementById('box');
    var t = 0;
    (function tick() {
      window.__rafCount += 1;
      if (animate && !window.__frozen) {
        t += 0.055;
        box.style.transform = 'translate(' + (60 + 200 * Math.abs(Math.sin(t))) + 'px,' +
                              (50 + 120 * Math.abs(Math.cos(t * 1.37))) + 'px) rotate(' + (t * 11) + 'deg)';
        if (animateOpacity) {
          box.style.opacity = String(0.55 + 0.45 * Math.abs(Math.sin(t * 2.1)));
        }
      }
      requestAnimationFrame(tick);
    })();
  </script></body></html>`;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const log = [];
  const emit = (line) => { log.push(line); console.log(line); };

  emit(`OSR_DEMO_BEGIN label=${LABEL} electron=${process.versions.electron} node=${process.versions.node} chrome=${process.versions.chrome}`);
  emit(`ADDON_PATH=${addonPath}`);
  emit(`ADDON_LOADED=${native ? 1 : 0}${addonLoadError ? ' error=' + addonLoadError.slice(0, 160) : ''}`);
  if (!native) {
    // 显式 FAIL，且给出可复现的修复动作。退出码 2 = "addon 不可用"，与"判据不过"(1) 区分。
    console.log('VERDICT_OSR=FAIL  FAIL_REASON=addon_unavailable');
    console.log(`ADDON_ERROR=${addonLoadError.slice(0, 240)}`);
    console.log('HINT= run native/build-m2-addon.bat first (or the node-gyp command in the T03 report)');
    console.log('HINT= expected artifact: ' + addonPath);
    console.log('NOTE= 不回退 CPU 回读路径: 那会静默跑通并判 PASS，是本 Spike 最危险的假绿');
    console.log('P0_3_ALL=FAIL');
    app.exit(2);
    return;
  }

  // 原始进程的 DPI awareness（addon 里会尝试抬到 PMv2 并回报实际值）
  const hostInit = native.hostInit(WIN_W, WIN_H, 'Harbor 通路B · DComp 单链');
  emit(`HOST_INIT ok=${hostInit.ok} error=${hostInit.error || ''} dpi=${hostInit.dpi} dpiAwareness=${hostInit.dpiAwareness} size=${hostInit.width}x${hostInit.height}`);
  if (!hostInit.ok) {
    console.log('P0_3_ALL=FAIL');
    console.log('FATAL=HOST_INIT_FAILED');
    app.exit(3);
    return;
  }

  const win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    show: false,                                   // 隐藏: 画面只出现在原生 DComp 窗口里
    frame: false,
    webPreferences: {
      offscreen: { useSharedTexture: true },
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.setFrameRate(TARGET_FPS);

  const paintStartMs = { value: 0 };
  let collectOriginMs = 0;
  let collecting = false;

  win.webContents.on('paint', (event) => {
    const texture = event.texture;
    // 关键: 无论是否在采集窗口内，拿到的 texture **必须** release。
    // 预热期直接 return 会让 Chromium 的共享纹理池（实测约 4~5 张）被耗尽，
    // 之后所有 paint 都退化成 event.texture === undefined —— 表现为"0 带纹理帧"，
    // 极容易误判成"通路 B 不成立"。这个坑必须靠"始终成对释放"消除。
    if (!collecting) {
      if (texture) {
        try { texture.release(); } catch (err) { /* 预热期忽略 */ }
      }
      return;
    }
    const nowMs = performance.now();
    stats.paints += 1;
    if (!texture) {
      stats.withoutTexture += 1;
      markMiss();
      return;
    }
    stats.withTexture += 1;
    let handleBuffer = null;
    try {
      const info = texture.textureInfo || {};
      const nt = info.handle && info.handle.ntHandle;
      // 记录第一帧纹理的真实尺寸/格式: 交换链建的是 640x400 B8G8R8A8，
      // 若 OSR 纹理尺寸与之不同，说明 blit 在缩放（demo 能跑但不该假装"像素精确"）。
      if (stats.texInfo === null && info.codedSize) {
        stats.texInfo = {
          codedWidth: info.codedSize.width,
          codedHeight: info.codedSize.height,
          pixelFormat: info.pixelFormat,
          hasNt: !!nt,
          ntBytes: Buffer.isBuffer(nt) ? nt.length : 0,
        };
      }
      if (nt && Buffer.isBuffer(nt) && nt.length === 8) {
        stats.withNtHandle += 1;
        handleBuffer = nt;
      }
    } catch (err) {
      pushError('textureInfo: ' + (err && err.message));
    }

    consecutiveMiss = 0;
    stats.texStamp.push(nowMs);
    if (lastTexStampMs > 0) {
      const gap = nowMs - lastTexStampMs;
      if (gap > stats.maxGapMs) stats.maxGapMs = gap;
    }
    lastTexStampMs = nowMs;

    // 交给原生侧: NC-B3 时故意传伪造句柄。
    const handleToSend = NC === 'nc3' ? FAKE_HANDLE : handleBuffer;
    if (handleToSend) {
      try {
        const result = native.hostPresent(handleToSend);
        if (result && result.queued === 1) {
          stats.hostQueued += 1;
        } else {
          stats.hostPresentFail += 1;
          if (NC === 'nc3' && stats.fakeOpenHr === null && result) {
            stats.fakeOpenHr = { value: result.openHr, hex: result.openHrHex };
            if (result.openHr !== 0) stats.fakeOpenBlocked = 1;
          }
          if (NC !== 'nc3' && stats.errors.length < 12) {
            pushError('hostPresent failed openHr=' + (result && result.openHrHex));
          }
        }
      } catch (err) {
        pushError('hostPresent: ' + (err && err.message));
      }
    }

    // 原生侧已在 hostPresent 内同步完成 OpenSharedResource1 + CreateSRV，
    // 引用已转移到宿主进程，这里可以安全 release（顺序反了会让句柄失效）。
    try {
      texture.release();
      stats.released += 1;
    } catch (err) {
      pushError('release: ' + (err && err.message));
    }
  });

  win.webContents.on('paint-failed', () => {
    if (!collecting) return;
    stats.paintFailed += 1;
    pushError('paint-failed');
  });

  // 像素恒等自证的严格档默认开启（OSR_OPAQUE=0 可关掉做对照）:
  // OPAQUE 页面不含任何半透明像素，于是"屏幕像素 == 纹理像素"必须逐点精确成立，
  // 这比任何统计口径都硬 —— 它同时证明了交换链格式、alpha 模式、缩放、颜色处理全链无失真。
  const opaqueForProof = process.env.OSR_OPAQUE !== '0';
  const animate = NC !== 'nc1';
  emit(`PAGE_MODE animate=${animate ? 1 : 0} opaque=${opaqueForProof ? 1 : 0}`);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildHtml(animate, opaqueForProof)));

  let invalidateStop = false;
  let invalidateCount = 0;
  const invalidateLoop = (async () => {
    // 串行: 一次 invalidate 之后等 ~25ms 再请求下一帧，避免请求被 Chromium 合并。
    if (NO_INVALIDATE) return;
    // 严格串行: 单循环 + 每次 await 25ms，绝不并发 —— 并发请求会被 Chromium 合并。
    while (!invalidateStop) {
      if (!collecting || lastTexStampMs === 0 ||
          performance.now() - lastTexStampMs >= STALL_THRESHOLD_MS) {
        try {
          win.webContents.invalidate();
          invalidateCount += 1;
        } catch (err) {
          pushError('invalidate: ' + (err && err.message));
        }
      }
      await sleep(INVALIDATE_GAP_MS);
    }
  })();

  if (NC === 'nc2') {
    // 先确保进入"已停绘"状态，再全程不恢复。
    win.webContents.startPainting();
    win.webContents.stopPainting();
    emit('NC_NC2=stopPainting_and_never_start');
  } else {
    win.webContents.startPainting();
    emit('START_PAINTING=1');
  }
  paintStartMs.value = performance.now();

  const readRaf = async () => {
    try {
      const value = await win.webContents.executeJavaScript('window.__rafCount || 0', true);
      return Number(value) || 0;
    } catch (err) {
      pushError('readRaf: ' + (err && err.message));
      return -1;
    }
  };

  // 预热: 前若干帧有 Chromium 首帧/纹理池建立的开销，不计入采集窗口。
  await sleep(WARMUP_MS);
  stats = newStats();
  consecutiveMiss = 0;
  lastTexStampMs = 0;
  const rafAtStart = await readRaf();
  collectOriginMs = performance.now();
  collecting = true;
  emit(`COLLECT_BEGIN windowMs=${COLLECT_MS} rafAtStart=${rafAtStart}`);

  // 从采集一开始就让宿主保留最后一帧 OSR 纹理。
  // 目的: 采集结束时手里有一张与"屏幕上最后一帧"对应的纹理，供像素恒等比对。
  // 必须在这里（而不是采集结束后）打开 —— 采集一停就没有新帧提交了，
  // 事后打开 retain 会导致"no retained frame"（实测踩到过）。
  // 宿主只保留 1 张（每帧替换并释放旧的），不会像"忘记 release JS 侧纹理"那样耗尽纹理池。
  try { native.retainLastFrame(); } catch (err) { pushError('retainLastFrame: ' + (err && err.message)); }

  await sleep(COLLECT_MS);
  collecting = false;
  const collectEndMs = performance.now();
  const rafAtEnd = await readRaf();

  // ---- 冻结画面，让"屏幕上的像素"与"保留的纹理"是**同一帧** ----
  //
  // 顺序很关键，这里踩过一个**偶发**的坑（约 1/3 概率 matchRatio 从 1.00000 掉到 0.90）:
  //   ✗ 先 freeze 再**立刻** pause: freeze 是渲染进程的异步动作，此时还有在途动画帧。
  //     pause 把管线卡在"过渡中间态"，于是 保留纹理 = 第 K 帧、屏幕 = 第 K-1 帧，
  //     两张图的卡片**旋转角不同** —— 实测失败样本的截图确实是另一个角度。
  //     更隐蔽的是：它的 bestShift 也是 (0,0)（不是错位，是内容真的换了），
  //     所以"平移搜索"这种诊断救不了，只能靠时序修复。
  //   ✓ 正确顺序: freeze -> **等内容真正稳定**（等足几个合成周期）-> pause -> 再等上屏 -> 比对。
  //     冻结之后所有帧内容完全相同，此时无论管线里排了第几帧，内容都对得上。
  try {
    await win.webContents.executeJavaScript('window.__frozen = true; true', true);
  } catch (err) {
    pushError('freeze: ' + (err && err.message));
  }

  // 第 1 段等待: 让 freeze 生效并把在途的动画帧全部排空。
  // 取 8 个合成周期（~133ms）: 足够覆盖 OSR 一帧的 paint 延迟 + 交换链 1 帧在飞。
  await sleep(Math.max(150, 8 * SYNTHETIC_PERIOD_MS));

  // 现在才暂停宿主出帧消费。
  //
  // 【为什么必须暂停】OSR 共享纹理来自 Chromium 的**纹理池**，同一块显存会被下一帧复用。
  // 我们虽然持有一次引用（OpenSharedResource1 的引用），但 Chromium 仍会往里写新帧内容。
  // 不暂停就回读，会读到"半新半旧"的像素。
  try { native.pauseRendering(true); } catch (err) { pushError('pauseRendering: ' + (err && err.message)); }

  // 第 2 步: 让 Chromium **彻底停止出帧**。
  //
  // CopyResource 是异步的（只把命令排进 GPU 队列），而 Chromium 的纹理池仍在往同一块
  // 显存写下一帧。只要写者还在，任何"快照时刻"都可能读到下一帧的内容 ——
  // 实测症状: matchRatio 在 0.90~0.96 之间掉，且中心像素恒为
  //   tex=背景色(93,61,30) / screen=卡片色(235,215,200)
  // 即两张图差一帧（卡片位置不同）。所以必须先把写者停下来。
  try {
    win.webContents.stopPainting();
  } catch (err) {
    pushError('stopPainting: ' + (err && err.message));
  }

  // 第 3 步等待: 让 Chromium 的在途帧、宿主交换链的在飞帧、DWM 的合成队列全部排空。
  await sleep(300);

  // 第 4 步: 排空之后重新拷一份快照。此时没有任何写者，结果必然稳定。
  let resnap = { ok: 0 };
  try {
    resnap = native.resnapshotLastFrame() || resnap;
  } catch (err) {
    pushError('resnapshotLastFrame: ' + (err && err.message));
  }
  emit(`RESNAPSHOT_AFTER_STOP=ok=${resnap.ok}`);

  // 第 5 步等待: 让屏幕显示最后稳定的那一帧。
  await sleep(200);
  invalidateStop = true;
  await invalidateLoop;

  const hostStats = native.hostStats();

  // ---- 判据 ⑥ 像素恒等自证: 屏幕像素 == OSR 纹理像素 ----
  //
  // 为什么不是"截个图看着有内容就算过":
  //   负控 NC-B1（静态页面）的实测截图里抓到的是**窗口后面的桌面/IDE 界面** ——
  //   WS_EX_NOREDIRECTIONBITMAP 窗口在没有可合成帧时，在屏幕上就是一块透明洞。
  //   那一版用"颜色数>=16 且 不太黑"来判，结果 NC-B1 拿到 distinctColors=274、
  //   blackRatio=0、meanLuma=26.6 被判成 PASS，这是**假通过**。
  //
  // 现在的口径不可能假通过: 宿主冻结最后一帧纹理，然后把"屏幕上这块矩形"与
  // "纹理里的像素"逐点比对。桌面像素不可能等于 OSR 纹理像素。
  const bmpPath = path.join(__dirname, '..', '..', 'build', 't03', `osr-screen-${LABEL}.bmp`);
  let compare = { ok: 0, error: 'not called', matchRatio: 0 };
  try {
    compare = native.compareScreenAndTexture(bmpPath) || compare;
  } catch (err) {
    compare = { ok: 0, error: 'compare threw: ' + (err && err.message), matchRatio: 0 };
  }
  emit(`PIXEL_COMPARE ok=${compare.ok} error=${compare.error || ''}`);
  emit(`PIXEL_COMPARE_SIZE tex=${compare.texWidth}x${compare.texHeight} screen=${compare.screenWidth}x${compare.screenHeight} sizeEqual=${compare.sizeEqual}`);
  emit(`PIXEL_COMPARE_RESULT compared=${compare.comparedPixels} matched=${compare.matchedPixels} matchRatio=${typeof compare.matchRatio === 'number' ? compare.matchRatio.toFixed(5) : 'n/a'} meanAbsDiff=${typeof compare.meanAbsDiff === 'number' ? compare.meanAbsDiff.toFixed(4) : 'n/a'}`);
  emit(`PIXEL_COMPARE_CENTER ${compare.centerPixelCompare || 'n/a'}`);
  emit(`PIXEL_COMPARE_SCREEN_STABILITY diff=${typeof compare.screenStabilityDiff === 'number' ? compare.screenStabilityDiff.toFixed(4) : 'n/a'}  (两次抓屏间隔120ms; ~0 = 画面已静止, 大 = 还在动)`);
  emit(`PIXEL_COMPARE_GRID8x6 ${compare.matchGrid8x6 || 'n/a'}`);
  emit(`PIXEL_COMPARE_SHIFT_DIAG bestDx=${compare.bestShiftDx} bestDy=${compare.bestShiftDy} bestRatio=${typeof compare.bestShiftRatio === 'number' ? compare.bestShiftRatio.toFixed(5) : 'n/a'}  (仅诊断: 大幅优于 matchRatio => 内容在动/相邻帧, 非错位)`);
  emit(`PIXEL_COMPARE_DESKTOP_BASELINE diffMeanAbs=${typeof compare.desktopDiff === 'number' ? compare.desktopDiff.toFixed(3) : 'n/a'}  (window hidden vs shown; 0 = 窗口是透明洞)`);
  emit(`PIXEL_COMPARE_CORRELATION r=${typeof compare.correlation === 'number' ? compare.correlation.toFixed(5) : 'n/a'}`);
  emit(`PIXEL_COMPARE_BMP=${compare.bmpPath || 'n/a'}`);
  // 判定口径（三条同时满足，全部可复现）:
  //   1) 尺寸一致: 屏幕矩形 == OSR 纹理尺寸（证明交换链按真实纹理尺寸建，没有缩放）
  //   2) 逐点匹配率 >= 98%（每通道 diff <= 2）: 实测在冻结画面 + 不透明页面下为 **1.00000**，
  //      meanAbsDiff = 0.0000，中心像素双路完全相同 —— "屏幕上的像素就是 OSR 纹理的像素"。
  //      这是 B8G8R8A8 / FLIP_DISCARD 全链无格式转换、无缩放、无颜色处理的直接证据。
  //      为什么页面要换成不透明: 半透明区域（rgba 卡片、阴影）在 PREMULTIPLIED 交换链上
  //      会被 DComp 与底做混合，屏幕像素**合法地**不等于纹理像素。实测此时 matchRatio≈0.87、
  //      r≈0.82 —— 那不是合成失败，是 alpha 混合在正确工作。用不透明页面把这两个变量分开，
  //      判据才既硬又不会误报。（早期 0.79 的另一次误诊是拿相邻两帧在比，同样靠冻结页面解决。）
  //   3) 桌面基线差异 >= 2.0: 隐藏窗口后抓同一块屏幕矩形作基线，与其差值。
  //      若窗口其实是"透明洞"（负控 NC-B1），屏幕上显示的就是桌面本身，这条会接近 0。
  //      这条专堵"截到桌面却判 PASS"的假通过 —— NC-B1 的截图确实是 IDE 界面。
  const PIXEL_MATCH_MIN = 0.98;
  const DESKTOP_DIFF_MIN = 2.0;
  // 若根本没有保留帧（负控 NC-B3: 伪造句柄导致一帧都没合成上屏），判据必须是 FAIL。
  // 这一支不能靠"matchRatio=0 默认值"隐性成立 —— 显式判红，否则改口径时容易漏掉。
  const captureOk = compare.ok === 1 && compare.sizeEqual === 1 &&
                    compare.matchRatio >= PIXEL_MATCH_MIN &&
                    compare.desktopDiff >= DESKTOP_DIFF_MIN;
  if (compare.ok !== 1) {
    emit(`P0_3_6_NOTE=no_retained_frame reason="${compare.error || 'unknown'}" -> 判定 FAIL（一帧都没有合成上屏）`);
  }

  try { native.pauseRendering(false); } catch (err) { pushError('pauseRendering(false): ' + (err && err.message)); }
  try { native.releaseRetainedFrame(); } catch (err) { pushError('releaseRetainedFrame: ' + (err && err.message)); }
  const shutdown = native.hostShutdown();

  // -------------------------------------------------------------------------
  // 判据
  // -------------------------------------------------------------------------
  const elapsedMs = collectEndMs - collectOriginMs;
  const rafFrames = rafAtStart >= 0 && rafAtEnd >= 0 ? Math.max(0, rafAtEnd - rafAtStart) : -1;
  const rafFps = rafFrames > 0 ? (rafFrames * 1000) / elapsedMs : 0;
  const textureRatio = rafFrames > 0 ? stats.withTexture / rafFrames : 0;
  const ratioText = rafFrames > 0 ? (textureRatio * 100).toFixed(1) : 'n/a';

  // ① 带纹理帧 / rAF 帧数 >= 70%（分母用 rAF 帧数，不是"时长 x 刷新率"）
  const c1 = rafFrames > 0 && textureRatio >= TEXTURE_RATIO_MIN;
  // ①b rAF 帧率 / 目标帧率 —— 原样落盘，不设阈值（PRD 里 50% 无实测依据，待重核）
  const c1bRatio = rafFps > 0 ? rafFps / TARGET_FPS : 0;
  // ② 带纹理帧之间的最大空洞 <= 3 个 DISPLAY CYCLES
  //
  // DENOMINATOR FIX (R101): this used SYNTHETIC_PERIOD_MS = 1000/TARGET_FPS.
  // That is the NOMINAL period of the requested tier, not the tier's actual
  // pacing. The two coincide at 60 Hz (16.67 vs measured 16.6x) which is why the
  // old number looked fine, and diverge at 165 Hz by 2.75x. The criterion asks
  // "how many display beats were missed", so the beat must be the MEASURED vsync
  // interval.
  //
  // Which measured quantity: the media of the gaps BETWEEN CONSECUTIVE TEXTURED
  // FRAMES, when those gaps are short (<= 2 nominal periods). Do NOT use the
  // median of all gaps in the window: a window with many drops has its median
  // pulled up toward the multi-frame gap, which would inflate the denominator
  // and make the criterion EASIER to pass exactly when it should be harder.
  // Taking the median of the SHORT gaps only keeps the beat estimate stable
  // under dropping, which is the whole point.
  const nominalPeriod = SYNTHETIC_PERIOD_MS;
  const shortGaps = [];
  for (let k = 1; k < stats.texStamp.length; k += 1) {
    const g = stats.texStamp[k] - stats.texStamp[k - 1];
    if (g > 0 && g <= nominalPeriod * 2.0) shortGaps.push(g);
  }
  shortGaps.sort((a, b) => a - b);
  const vsyncBaseMs = shortGaps.length > 0
    ? shortGaps[Math.floor((shortGaps.length - 1) / 2)]
    : 0;
  const vsyncSampled = shortGaps.length;
  // A tier whose beat cannot be measured cannot be judged. Falling back to the
  // nominal period here would re-introduce exactly the bug being fixed.
  const vsyncUsable = vsyncBaseMs > 0 && vsyncSampled >= 10;
  // Sanity band: the measured beat must be within 20% of the requested tier.
  // Wider than that means setFrameRate / the compositor did not honour the tier
  // and the whole run describes a different refresh rate than it claims.
  const vsyncWithinTier = vsyncUsable &&
    Math.abs(vsyncBaseMs - nominalPeriod) / nominalPeriod <= 0.20;
  const maxGapCycles = vsyncUsable ? stats.maxGapMs / vsyncBaseMs : Infinity;
  const c2 = stats.withTexture > 0 && stats.maxConsecutiveMiss <= MAX_MISS_FRAMES &&
             vsyncUsable && vsyncWithinTier && maxGapCycles <= MAX_MISS_FRAMES;
  // ③ paint / rAF 落在 (0, 1]
  //
  // 口径说明（必须写清，否则这条判据会变成偶发红）:
  //   paints 在 paint 回调里同步累加，rAF 数靠 executeJavaScript 跨进程异步读两次再相减。
  //   采集窗口收口时 collecting=false 与读 rafCount 之间有毫秒级窗口，边界上可能多/少 1 帧，
  //   因此实测会出现 361/360 = 1.0027 这种"技术上 >1"的边界噪声（与真实超发无关）。
  //   这条判据的真实意图是抓**系统性超发**（盲发 invalidate 实测 1.54x），
  //   故上界取 1 + 1/rafFrames（即容 1 帧边界），下界仍是 0（不允许 paint 完全不动）。
  const paintPerRaf = rafFrames > 0 ? stats.paints / rafFrames : 0;
  // 判据③ 的余量为什么不是 "1 + 1/rafFrames"（那是第一版，实测判错了）。
  //
  // 语义: 每一帧 rAF 都应有对应 paint（帧是被视觉变化驱动的，不是空转刷的），
  //       所以比值应在 1 附近。但两个计数器的**采样起点不同**：
  //       rafFrames 从 startPainting 之后的第一个 rAF 起算，stats.paints 从第一次
  //       paint 事件起算，尾部还可能收到一次「末帧收尾 paint」（rAF 已停但 paint 已排队）。
  //       净效果是 60s @165Hz 必然多出 2~3 次 paint（实测 9902/9900 = 1.00020）。
  //
  // 第一版用 1 + 1/rafFrames（= 1.000101）作上限 → 一次完全健康的 60s 采集被判红
  //   （c3=false ⇒ allPass=false ⇒ 进程 exit 1），而所有六条物理判据的读数都好得很。
  //   这正是"判据把健康实现判死"，比漏判更糟：它会让人去改本来正确的代码。
  //
  // 正确的余量口径: 允许「端点效应」——首尾各 1 帧，共 2 帧。与帧数无关，
  //   因为它是结构性的（起点错位），不是随机的。同时保留一个极小的相对松弛
  //   0.1% 吸收 paint 事件的合并/拆分（实测最高 1.00020 = 0.02%）。
  //
  // 下界为什么不能是 ">0"（第一版和我的第一次修正都错了）。
  //
  // 判据③ 要证明的是「帧是被视觉变化驱动的，不是被 invalidate 空转刷的」。
  // 只用 >0 当下界，只能拦住"完全没 paint"，拦不住「一半的帧没画」：
  //   实测验算 calc(9903, 4951) → ratio=0.49995，旧判据判 PASS。
  // 而 paint/rAF≈0.5 恰恰说明**约一半 rAF 没有产生 paint**，即画面在那些帧上是冻结的
  //   —— 这正是本判据要排除的情形之一。
  //
  // 与判据① 对称取 70%：① 已确立「带纹理帧 >= 70% of rAF」是本项目可接受的下限
  //   （依据 E11 实测 83.6%，留 13.6pt 余量）。③ 与 ① 描述的是同一件事的两面
  //   （① 看纹理到没到，③ 看 paint 有没有发生），用同一阈值才不会自相矛盾：
  //   若 ③ 允许 50% 而 ① 要求 70%，就会出现「③ 说健康、① 说纹理不够」的不一致读数。
  const PAINT_PER_RAF_MIN = 0.70;
  const paintPerRafUpper = rafFrames > 0 ? 1.0 + (2.0 + 0.001 * rafFrames) / rafFrames : 0;
  const c3 = paintPerRaf >= PAINT_PER_RAF_MIN && paintPerRaf <= paintPerRafUpper;
  // ④ 带纹理帧数 == release() 成功数
  const c4 = stats.withTexture > 0 && stats.withTexture === stats.released;
  // ⑤ 宿主侧真的把帧合成上屏了（NC-B3 靠这条判红）
  const c5 = hostStats.presented > 0 && hostStats.presentFailed === 0 &&
             stats.hostPresentFail === 0;

  const c6 = captureOk;

  const allPass = c1 && c2 && c3 && c4 && c5 && c6;
  const tag = (ok) => (ok ? 'PASS' : 'FAIL');

  emit('--- RESULT ---');
  emit(`ELAPSED_MS=${elapsedMs.toFixed(0)} COLLECT_MS=${COLLECT_MS}`);
  emit(`TOTAL_PAINTS=${stats.paints} WITH_TEXTURE=${stats.withTexture} WITHOUT_TEXTURE=${stats.withoutTexture}`);
  emit(`WITH_NT_HANDLE=${stats.withNtHandle} RELEASED=${stats.released} PAINT_FAILED=${stats.paintFailed}`);
  emit(`OSR_TEX_INFO=${JSON.stringify(stats.texInfo)} REQUESTED=${WIN_W}x${WIN_H} SWAPCHAIN_ACTUAL=${hostStats.width}x${hostStats.height}`);
  if (stats.texInfo) {
    const exact = stats.texInfo.codedWidth === hostStats.width &&
                  stats.texInfo.codedHeight === hostStats.height;
    emit(`TEX_SIZE_MATCHES_SWAPCHAIN=${exact ? 'YES' : 'NO(scaled_blit)'} resizeFailed=${hostStats.resizeFailed}`);
  }
  emit(`RAF_AT_START=${rafAtStart} RAF_AT_END=${rafAtEnd} RAF_FRAMES=${rafFrames} RAF_FPS=${rafFps.toFixed(2)}`);
  emit(`INVALIDATE_CALLS=${invalidateCount} NO_INVALIDATE=${NO_INVALIDATE ? 1 : 0} GAP_MS=${INVALIDATE_GAP_MS} STALL_MS=${STALL_THRESHOLD_MS}`);
  emit(`HOST_SUBMITTED=${hostStats.submitted} HOST_OPEN_OK=${hostStats.openOk} HOST_OPEN_FAIL=${hostStats.openFail}`);
  emit(`HOST_DROPPED=${hostStats.dropped} HOST_RENDERED=${hostStats.rendered} HOST_PRESENTED=${hostStats.presented} HOST_PRESENT_FAILED=${hostStats.presentFailed}`);
  emit(`HOST_LAST_OPEN_HR=${hostStats.lastOpenHrHex} HOST_LAST_PRESENT_HR=${hostStats.lastPresentHrHex}`);
  emit(`HOST_PRESENT_MS last=${hostStats.lastPresentMs.toFixed(3)} avg=${hostStats.avgPresentMs.toFixed(3)} max=${hostStats.maxPresentMs.toFixed(3)} waitTimeouts=${hostStats.waitTimeouts}`);
  // D2 主统计量：Present→Present 间隔分布（与 HOST_PRESENT_MS 不是同一个量——
  // 后者是 Present1 调用耗时，前者才是节拍。别把两者混成一个"帧时间"。）
  emit(`HOST_INTERVAL_MS p50=${Number(hostStats.intervalP50Ms).toFixed(4)} p95=${Number(hostStats.intervalP95Ms).toFixed(4)} p99=${Number(hostStats.intervalP99Ms).toFixed(4)} min=${Number(hostStats.intervalMinMs).toFixed(4)} max=${Number(hostStats.intervalMaxMs).toFixed(4)} samples=${hostStats.intervalSamples}`);
  emit(`HOST_DROPS=${hostStats.drops} HOST_DROP_RATE=${Number(hostStats.dropRate).toFixed(5)}`);
  emit(`HOST_DPI=${hostStats.dpi} HOST_DPI_AWARENESS=${hostStats.dpiAwareness}`);
  emit(`SHUTDOWN_MS=${shutdown.shutdownMs.toFixed(2)} SHUTDOWN_OK=${shutdown.ok}`);

  emit(`P0_3_1_TEXTURE_RATIO=${tag(c1)}   framesWithTexture=${stats.withTexture} / rAF=${rafFrames} = ${ratioText}%  (>=70%)`);
  emit(`P0_3_1B_RATIO_VS_TARGET=${(c1bRatio * 100).toFixed(1)}%  rafFps=${rafFps.toFixed(2)} target=${TARGET_FPS}  (no threshold, record only)`);
  emit(`P0_3_2_MAX_GAP=${tag(c2)}  maxConsecutiveMiss=${stats.maxConsecutiveMiss}  (<=${MAX_MISS_FRAMES})  maxGapMs=${stats.maxGapMs.toFixed(2)} maxGapCycles=${Number.isFinite(maxGapCycles) ? maxGapCycles.toFixed(2) : 'n/a'}  vsyncBaseMs=${vsyncBaseMs.toFixed(4)} vsyncSamples=${vsyncSampled} vsyncSrc=measured(shorter-gap median, <=${(nominalPeriod * 2).toFixed(2)}ms) vsyncWithinTier=${vsyncWithinTier ? 1 : 0}`);
  emit(`P0_3_3_RAF_PAINT_SYNC=${tag(c3)}  paint/rAF=${paintPerRaf.toFixed(4)}x  (>=${PAINT_PER_RAF_MIN}, <=${paintPerRafUpper.toFixed(4)})  paints=${stats.paints} rafFrames=${rafFrames}`);
  emit(`P0_3_4_TEX_EQ_RELEASE=${tag(c4)}  texFrames=${stats.withTexture} released=${stats.released}`);
  emit(`P0_3_5_HOST_PRESENTED=${tag(c5)}  presented=${hostStats.presented} presentFailed=${hostStats.presentFailed} hostPresentFail=${stats.hostPresentFail}`);
  emit(`P0_3_6_PIXEL_IDENTITY=${tag(c6)}  matchRatio=${typeof compare.matchRatio === 'number' ? compare.matchRatio.toFixed(5) : 'n/a'} (>=${PIXEL_MATCH_MIN})  r=${typeof compare.correlation === 'number' ? compare.correlation.toFixed(5) : 'n/a'}  desktopDiff=${typeof compare.desktopDiff === 'number' ? compare.desktopDiff.toFixed(3) : 'n/a'} (>=${DESKTOP_DIFF_MIN})  sizeEqual=${compare.sizeEqual}  compared=${compare.comparedPixels || 0}`);
  if (NC === 'nc3') {
    emit(`NC_B3_FAKE_HANDLE_OPEN_HR=${stats.fakeOpenHr ? stats.fakeOpenHr.hex : 'n/a'} blocked=${stats.fakeOpenBlocked}`);
  }
  emit(`ERRORS=${JSON.stringify(stats.errors)}`);

  // ---- Tier status. ------------------------------------------------------
  // A single run only ever describes ONE tier, so it cannot by itself emit
  // PASS_BOTH. It reports this tier's own verdict and labels which tier it was,
  // leaving the cross-tier roll-up to the runner that executes both. Emitting
  // PASS_BOTH from a single-tier run would be a claim this process never tested.
  emit(`OSR_TIER=${OSR_HZ}  nominalPeriodMs=${nominalPeriod.toFixed(4)}`);
  emit(`P0_3_TIER_RESULT=${allPass ? 'PASS' : 'FAIL'}  tier=${OSR_HZ}Hz`);
  emit(`P0_3_STATUS_PARTIAL=${allPass ? 'TIER_PASS' : 'TIER_FAIL'}  tier=${OSR_HZ}  (single-tier run; PASS_BOTH requires both tiers via run-t03-dual.bat)`);
  // Kept for every existing consumer of P0_3_ALL (exit paths, negative-control
  // greps). It now means "THIS TIER's six criteria all passed", not "the spike
  // passed" -- the cross-tier verdict lives in P0_3_STATUS at the run level.
  emit(`P0_3_ALL=${allPass ? 'PASS' : 'FAIL'}  scope=single_tier tier=${OSR_HZ}Hz`);
  // DDA honesty statement. This demo does NOT implement desktop duplication:
  // grep for DDA in this file returns nothing, so any earlier report of "DDA
  // cannot capture Chromium" from this component was an unimplemented guess.
  // Measured separately (E16c): DDA DOES capture Chromium, including OSR
  // transparent overlays. Recorded as NOT_ATTEMPTED so nobody reads this run as
  // evidence either way.
  emit(`P0_3_DDA=NOT_ATTEMPTED  reason="out_of_scope_for_t03"  see_E16c_probe=1`);

  const resultFile = path.join(__dirname, '..', '..', 'build', 't03', `osr-demo-${OSR_HZ}hz-${LABEL}.json`);
  try {
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    fs.writeFileSync(resultFile, JSON.stringify({
      label: LABEL,
      nc: NC,
      tierHz: OSR_HZ,
      nominalPeriodMs: nominalPeriod,
      elapsedMs,
      collectMs: COLLECT_MS,
      targetFps: TARGET_FPS,
      rafAtStart,
      rafAtEnd,
      rafFrames,
      rafFps,
      paints: stats.paints,
      withTexture: stats.withTexture,
      withoutTexture: stats.withoutTexture,
      withNtHandle: stats.withNtHandle,
      released: stats.released,
      paintFailed: stats.paintFailed,
      maxConsecutiveMiss: stats.maxConsecutiveMiss,
      maxGapMs: stats.maxGapMs,
      vsyncBaseMs,
      vsyncSamples: vsyncSampled,
      // D2 主统计量（Present→Present 间隔分布，来自原生 host 的逐帧记录）
      hostIntervalP50Ms: hostStats.intervalP50Ms,
      hostIntervalP95Ms: hostStats.intervalP95Ms,
      hostIntervalP99Ms: hostStats.intervalP99Ms,
      hostIntervalMinMs: hostStats.intervalMinMs,
      hostIntervalMaxMs: hostStats.intervalMaxMs,
      hostIntervalSamples: hostStats.intervalSamples,
      hostDrops: hostStats.drops,
      hostDropRate: hostStats.dropRate,
      vsyncSrc: 'measured-shorter-gap-median',
      vsyncWithinTier,
      maxGapCycles: Number.isFinite(maxGapCycles) ? maxGapCycles : null,
      textureRatio,
      ratioVsTarget: c1bRatio,
      paintPerRaf,
      paintPerRafUpper,
      fakeOpenHr: stats.fakeOpenHr,
      hostStats,
      texInfo: stats.texInfo,
      compare,
      captureOk,
      shutdownMs: shutdown.shutdownMs,
      criteria: { c1, c2, c3, c4, c5, c6, allPass },
      rawLog: log,
    }, null, 2), 'utf8');
    emit(`RESULT_FILE=${resultFile}`);
  } catch (err) {
    emit(`RESULT_FILE_ERROR=${err && err.message}`);
  }

  // ---- 退出路径证明: Release/Shutdown 之后进程能正常退出、不卡死 ----
  //
  // app.exit() 是强杀，不能证明"D3D/DComp 拆除干净"。所以这里默认走**自然退出**:
  //   把退出码记到 process.exitCode，然后 app.quit()，让 Electron 自己跑完 shutdown 流程。
  //   watchShutdown 打出"从 quit 到 beforeExit 的耗时"，若 GPU/DWM 侧还挂着引用，
  //   这个数字会飙到秒级（甚至窗口关不掉要手动杀）。
  // 需要强杀的场合（例如对接 CI 超时）设 OSR_FORCE_EXIT=1。
  const forceExit = process.env.OSR_FORCE_EXIT === '1';
  process.exitCode = allPass ? 0 : 1;
  if (forceExit) {
    emit('EXIT_MODE=force (app.exit)');
    console.log(`PROCESS_EXIT_START=${Date.now()}`);
    app.exit(allPass ? 0 : 1);
    return;
  }
  emit('EXIT_MODE=natural (app.quit -> beforeExit)');

  // 退出阶段的计时不能用 console.log —— Electron 在 shutdown 期间会关掉/丢弃 stdout，
  // 实测 will-quit/before-quit 的 console.log 会静默丢失，看起来像"进程卡住了"。
  // 改用同步追加写文件：写成功即证明这一阶段真的执行到了。
  const exitTraceFile = path.join(__dirname, '..', '..', 'build', 't03', `exit-trace-${LABEL}.txt`);
  const trace = (line) => {
    try {
      fs.appendFileSync(exitTraceFile, line + '\n', 'utf8');
    } catch (err) {
      /* 追踪失败不影响判据 */
    }
  };
  trace(`EXIT_MODE_NATURAL start=${new Date().toISOString()}`);
  const quitBeginMs = Date.now();
  app.on('will-quit', () => {
    trace(`WILL_QUIT_AFTER_QUIT_MS=${Date.now() - quitBeginMs}`);
    // 退出码必须在这里强制落地。
    // 实测: Electron 的自然退出路径会忽略 process.exitCode（NC-B1 明明 P0_3_ALL=FAIL，
    // 进程却以 0 退出），这条会让负控"看起来没红"。此时窗口销毁 + hostShutdown 都已完成，
    // "不卡死"已由 BEFORE_QUIT/WILL_QUIT/NATURAL_EXIT 的毫秒数证明，
    // 所以在 will-quit 里显式指定退出码不会掩盖任何挂起问题。
    app.exit(allPass ? 0 : 1);
  });
  app.on('before-quit', () => trace(`BEFORE_QUIT_AFTER_QUIT_MS=${Date.now() - quitBeginMs}`));
  process.on('exit', (code) => {
    // 这一行落盘 = 事件循环已空、Node 自然收尾（没有挂起的 GPU 同步 / DWM 引用）。
    trace(`NATURAL_EXIT_TOTAL_MS=${Date.now() - quitBeginMs} EXIT_CODE=${code}`);
  });
  // 关掉 win.destroy() 会触发的 "window-all-closed -> 自动 quit" 捷径，
  // 保证走完整的 before-quit / will-quit 链路（否则监听器还没挂上 app 就已经退了）。
  app.on('window-all-closed', () => {
    trace('WINDOW_ALL_CLOSED (suppressed auto-quit)');
  });
  try { win.destroy(); } catch (err) { /* 已销毁 */ }
  app.quit();
}).catch((err) => {
  console.log('FATAL=' + (err && err.stack ? err.stack : err));
  console.log('P0_3_ALL=FAIL');
  app.exit(4);
});
