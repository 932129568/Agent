/* ============================================================================
   R72 · 「光井 / LIGHTWELL」—— scripts/main.js
   分层视图 + 状态机 + 单例控制器（轻量 MVC，零框架 / 零依赖 / 零外网）。

   Model      : AppState（板块 / 主题 / fx / 密级 / 只读 / token / 成本 / 工具链）
   View       : index.html 的 9 个 [data-view-panel] + 底部成本光带（[hidden] 切换）
   Controller : ViewRouter / ThemeController / FxController / GlassLayer /
                ToolStepRail / CostRibbon / ClearanceCodec / StateMachine /
                MotionOrchestrator / BoardPrototypes / Toast

   硬边界：本文件不写任何颜色字面量（#hex / rgb() / hsl()）；
           所有色值经 class / data-* 属性由 tokens.css 的语义令牌驱动。
   运行方式：普通 <script>（非 ES module）——file:// 下 module 会受 CORS 阻止，
           本稿必须双击 index.html 即可运行，故沿用 R71 实测可用的 IIFE 形式。
   ============================================================================ */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  /* ---------------------------------------------------------------------------
     R77-U13 · 数字与单位的唯一格式化入口
     ----------------------------------------------------------------------------
     改前：`AppState.tokens.toLocaleString('en-US')` 硬编码了 en-US。三条问题：
       ① 一个面向中文用户的壳，分组符却由英文区域决定 —— 换成 hi-IN / de-DE
          的系统区域时，页面上仍钉着 1,234 的英文分组（de-DE 是 1.234），
          同屏既有"元"又有英文千分位，是两套数字约定打架；
       ② `toFixed(2)` 对**非数字**会抛 RangeError（NaN.toFixed(2) 得 "NaN"，
          但字符串调用直接 TypeError），AppState 一旦被写脏就整块读数崩；
       ③ 同一个数在三个地方各写一遍格式化表达式，改一处口径要改三处。
     现在：只留这两个函数，且都做**输入归一化**（非有限数退回 0 并留痕，
       不抛错、不显示 NaN —— 读数区出现 NaN 比显示 0 更糟，用户会以为坏了）。
     --------------------------------------------------------------------------- */
  var NUM_TOK = null;
  var NUM_CNY = null;
  function fmtTok(n) {
    var v = Number(n);
    /* R77-H21 · 负数必须归一化。令牌是**计数**，"-100 tok" 没有任何意义，
       却会真实出现（AppState 被测试或未来的差值逻辑写脏时）。
       上一版只有 fmtCny 做了 `v < 0 → 0`，fmtTok 漏了 ——
       同一个函数族里两条口径不一致，正是这类 bug 的温床。
       判据（_probe-risk H18）实测：改前 `-100 tok`，改后 `0 tok`。 */
    if (!isFinite(v) || v < 0) v = 0;
    if (!NUM_TOK) NUM_TOK = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
    return NUM_TOK.format(Math.round(v));
  }
  function fmtCny(n) {
    var v = Number(n);
    if (!isFinite(v) || v < 0) v = 0;
    if (!NUM_CNY) NUM_CNY = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return '¥' + NUM_CNY.format(v);
  }

  /* R77-U11 · 输入法（IME）安全判定。
     中文/日文/韩文输入法用 Enter **确认候选词**，此时 keydown 也会带 key === 'Enter'；
     全球通用的补丁是同时看 `isComposing` 与已废弃但仍被 Safari 使用的 `keyCode === 229`。
     漏了这一条的直接后果：用户打「计划」两个字，拼音还没上屏，Enter 先把
     "p" 当成一次检索提交了。 */
  function isImeConfirm(e) {
    return !!(e && (e.isComposing || e.keyCode === 229));
  }
  /* R73 环境循环宿主的 DOM 标记：光学层的驱动源一律从这里找，
     不写死类名（宿主可能被挪动，例如 #wellShaft 在 #chatWelcome / #emptyGuide 之间迁移）。 */
  var AMBIENT_HOSTS = '[data-ambient]';
  var VIEWS = ['chat', 'sessions', 'planning', 'generative', 'mcp', 'expert', 'memory', 'collaboration', 'settings'];
  var VIEW_LABEL = {
    chat: '对话', sessions: '会话', planning: '计划', generative: '生成式', mcp: 'MCP',
    expert: '专家', memory: '记忆', collaboration: '协作', settings: '设置'
  };
  var VIEW_SUB = {
    chat: '工具调用过程与成本，落在同一条光上。',
    sessions: '细线行 + 行内成本微条，先看哪条最烧钱。',
    planning: '阶梯缩进表达依赖，检查点是必须停下的闸门。',
    generative: '产出物放在展台上，精确读数落在实心台面。',
    mcp: '服务器架 → 能力分页 → 条目表，三层下钻。',
    expert: '编排链与泳道时间线：谁在什么时候被谁调用。',
    memory: '被检索的池，权重刻度解释召回理由。',
    collaboration: '连接关系用拓扑表达，剩余预算用环表达。',
    settings: '连续实心表单栈，本板块玻璃面积为零。'
  };
  var PROTOTYPE = {
    chat: 'flow-track', sessions: 'drawer-cabinet', planning: 'stair-gate',
    generative: 'plinth-chart', mcp: 'rack-tabs', expert: 'lane-timeline',
    memory: 'retrieval-well', collaboration: 'topology-ring', settings: 'form-stack'
  };
  /* composer 已升为外壳级常驻件：placeholder 随板块切换，
     避免在非对话板块暗示「发消息会作用于该板块」。 */
  var VIEW_PLACEHOLDER = {
    chat: '描述你要做的事…',
    sessions: '搜索会话标题或命中片段…',
    planning: '搜索计划步骤或检查点…',
    generative: '描述要生成的产出物…',
    mcp: '搜索服务器或能力…',
    expert: '搜索专家包或编排节点…',
    memory: '搜索记忆片段…',
    collaboration: '搜索协作端点…',
    settings: '搜索设置项…'
  };
  var DESTRUCTIVE = /删除|格式化|覆盖|重置|写入|清空|移除|drop|delete|format/i;

  /* ======================================================================
     §11 AppState：纯数据单例
     ====================================================================== */
  var AppState = {
    currentView: 'chat',
    theme: 'light',
    fx: true,
    clearance: 'read',      /* full | read | chat */
    readOnly: true,
    tokens: 18420,
    costYuan: 0.86,
    budgetYuan: 2.00,
    toolSteps: [],
    overBudget: false,
    callCount: 3
  };

  /* ======================================================================
     Toast：aria-live="polite"，实心零 blur 浮层
     ====================================================================== */
  var Toast = {
    host: null,
    init: function () { Toast.host = $('#toastHost'); },
    show: function (message, kind) {
      if (!Toast.host) return;
      /* 只保留最新一条：避免连点板块 / 连续工具调用时浮层堆叠遮住观测窗与光带 */
      while (Toast.host.firstChild) Toast.host.removeChild(Toast.host.firstChild);
      var shape = kind === 'err' ? '⊘' : (kind === 'warn' ? '◐' : '●');
      var node = document.createElement('div');
      node.className = 'toast overlay';
      var s = document.createElement('span');
      s.className = 'shape';
      s.textContent = shape;
      var t = document.createElement('span');
      t.textContent = message;
      node.appendChild(s);
      node.appendChild(t);
      Toast.host.appendChild(node);
      /* 2400ms（原 3600）：toast 停靠在 `top:82` 的带子里，而右对齐的用户气泡也在右上，
         两者必然短暂重叠。3600ms 的遮挡感明显长于"读完一句话"所需
         （R73-F 实测截图里它盖住了用户刚发的那条消息的右半）。
         缩到 2400ms 不改变任何判据的测量窗口（LAY-12 在 150ms、QA-A7-6 在 90ms，
         之后的等待是 3700ms）。 */
      window.setTimeout(function () { if (node.parentNode) node.remove(); }, 2400);
    }
  };

  /* ======================================================================
     R77-U12 Clipboard：复制能力的**双通道 + 诚实回执**
     ----------------------------------------------------------------------------
     改前那段是：
       try { if (navigator.clipboard) navigator.clipboard.writeText(text); } catch (e) {}
       Toast.show('已复制代码块内容', 'ok');
     三个问题，每一个都会真实误导用户：
       ① `writeText` 返回 Promise，**try/catch 抓不到它的 reject**。权限被拒
          （NotAllowedError）、文档失焦、非安全上下文，全都会变成一条未处理的
          Promise rejection —— 而 R77-U08 的 ErrorBoundary 正监听着
          `unhandledrejection`，于是"复制成功"的绿 Toast 与"出错了"的红 Toast
          同时出现，用户不知道该信哪个；
       ② 回执是**无条件**的。失败也说"已复制"，用户去粘贴时才发现是空的，
          转头怀疑整个页面；
       ③ 没有降级路径。`file://` 双击打开是本稿的主要运行方式（见文件头），
          这种上下文里 Clipboard API 的行为因浏览器而异，必须有
          `execCommand('copy')` 的兜底。
     现在：`write()` 永远返回 Promise，失败才 reject；调用方按结果给真话。
     ====================================================================== */
  var Clipboard = {
    write: function (text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text)['catch'](function () {
          return Clipboard.legacy(text);
        });
      }
      return Clipboard.legacy(text);
    },
    /* 兜底通道：临时 textarea + execCommand。
       必须 `position:fixed; top:-1000px` 而不是 `display:none` —— 后者选不中，
       execCommand 直接返回 false。用完立刻移除，不在 DOM 里留节点（判据扫 DOM 数量）。 */
    legacy: function (text) {
      return new Promise(function (resolve, reject) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.setAttribute('aria-hidden', 'true');
        ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
        document.body.appendChild(ta);
        var ok = false;
        try {
          ta.select();
          ta.setSelectionRange(0, text.length);
          ok = document.execCommand('copy');
        } catch (err) {
          ok = false;
        }
        if (ta.parentNode) ta.parentNode.removeChild(ta);
        if (ok) resolve(); else reject(new Error('clipboard-unavailable'));
      });
    }
  };

  /* ======================================================================
     R77-U18 ErrorBoundary：运行时异常的**界面通道**
     ----------------------------------------------------------------------------
     改前：任何未捕获异常都只落在 console（或浏览器默认的静默），界面上毫无痕迹。
     对一个"演示用的桌面壳"来说这是最坏的一种失败 —— 点一下没反应，用户不知道
     是没实现还是崩了。

     三条纪律：
       · 只走 Toast，**不写 console**（F03 判据要求零 console error；
         "已记录"应该被用户看见，而不是被开发者工具吞掉）；
       · 环形缓冲 20 条，不无限增长（长会话下不占内存）；
       · 同一条消息 3s 内只提示一次（连环异常时不刷屏，也不掩盖第一条）。
     ====================================================================== */
  var ErrorBoundary = {
    errors: [],
    installed: false,
    MAX: 20,
    last: { msg: '', at: 0 },
    install: function () {
      if (ErrorBoundary.installed) return;
      ErrorBoundary.installed = true;
      window.addEventListener('error', function (ev) {
        ErrorBoundary.record('error', ev.message, (ev.filename || '') + ':' + (ev.lineno || 0));
      });
      window.addEventListener('unhandledrejection', function (ev) {
        var r = ev.reason;
        ErrorBoundary.record('rejection', r && r.message ? r.message : String(r || ''), '');
      });
    },
    record: function (kind, message, where) {
      var msg = String(message || '').slice(0, 200);
      ErrorBoundary.errors.push({ kind: kind, message: msg, where: where || '', at: Date.now() });
      while (ErrorBoundary.errors.length > ErrorBoundary.MAX) ErrorBoundary.errors.shift();
      var now = Date.now();
      if (msg === ErrorBoundary.last.msg && now - ErrorBoundary.last.at < 3000) return;
      ErrorBoundary.last = { msg: msg, at: now };
      try { Toast.show('发生异常 · 已记录：' + (msg.slice(0, 30) || '未知错误'), 'err'); } catch (e) { /* 极端情况下 Toast 都不可用，静默 */ }
    }
  };

  /* ======================================================================
     §11 GlassLayer：同屏可见 backdrop-filter <= 2 的可测接口
     ====================================================================== */
  var GlassLayer = {
    layers: [],
    mount: function (id, el) {
      if (el) GlassLayer.layers.push({ id: id, el: el });
    },
    countVisibleBlurLayers: function () {
      return $$('*').filter(function (el) {
        if (el.offsetParent === null) return false;
        var cs = window.getComputedStyle(el);
        var bdf = cs.backdropFilter || cs.webkitBackdropFilter || 'none';
        return bdf !== 'none' && bdf !== '';
      }).length;
    },
    degradeAll: function () {
      GlassLayer.layers.forEach(function (item) { item.el.classList.add('glass--solid'); });
    },
    restoreAll: function () {
      GlassLayer.layers.forEach(function (item) { item.el.classList.remove('glass--solid'); });
    }
  };

  /* ======================================================================
     §12 OpticsLens（R79 第一阶段）：真实折射的玻璃材质
     ======================================================================
     物理依据见 R79-PHYSICAL-GLASS-RESEARCH.md。四条互相独立的证据收敛到
     同一条设计纪律：**中心平、边缘弯**。

       · 菲涅尔（n=1.5）：正视平板只反射 4%，只有边缘曲率处法线转向观察者，
         R(θ) = R₀ + (1−R₀)(1−cosθ)⁵ 在外侧 1/8 半径里吃掉 90% 的强度变化；
       · 折射位移：θ₁ = 0（正视）时 d = 0 —— 平板玻璃背后的东西**完全不位移**；
       · 弯月面：大容器中间是平的，只有靠壁处上翘；
       · Apple lensing：边缘弯折聚光，中心保持透明；
       · 浏览器位移图：中心必须恒等映射，否则文字被一起弯折、立刻发糊。

     所以位移图的中心核必须是**精确的 128**（= feDisplacementMap 的"不位移"），
     并且核要占到 62% 半径 —— 正文与读数全部落在核内，折射只发生在最外 38%。

     ★ 浏览器边界（team-lead 的探针是决定性的，此处不重复验证）
       · `backdrop-filter: blur() url(#f)` 只在 Chromium 是真位移；
       · Safari / Firefox **接受这条声明，再把 SVG 部分静默丢掉**（连模糊一起没），
         最坏结果是玻璃退化成一块裸的半透明；
       · `@supports` 对这条两边都报"支持" ⇒ 只能运行时探测。

     ★ 为什么探测要分两层
       ① 解析层：一对 2×2 离屏 div（黑白背景），读 `getComputedStyle` 里 url() 是否还在。
          挡的是"整条声明被丢弃"这一类（值退回 none），挡不住"存下来但不画"。
       ② 像素层：合成后的页面像素对 JS 不开放（没有 getImageData），页内唯一能真读到
          像素的地方是 Canvas2D，而 `ctx.filter` 与 `backdrop-filter` 共用同一套 SVG
          滤镜光栅化路径 —— url() 被丢弃时两边同时失效。所以这里用 canvas 做真比对：
          同一块黑→白渐变，`blur(1px)` 与 `blur(1px) url(#lg-lens)` 如果像素相同，
          说明 url() 这条腿是死的。模糊对平滑渐变近乎恒等，于是"位移"是唯一变量。
       两层都过才启用位移；任何一层说不 ⇒ 回落纯 blur。方向是保守的（回落永远安全），
       而且 CSS 侧还有第二道保险：位移声明写在回落声明**之后**且带状态前缀，
       整条声明被丢弃时回落的 `blur(...) saturate(...)` 仍然生效 —— 结构上不可能裸。
     ====================================================================== */
  var OpticsLens = {
    MAP_ID: 'lg-lens-map',
    FILTER_ID: 'lg-lens',
    MAP_SIZE: 256,
    /* 中性核半径，归一化到 [-1,1] 的像素中心坐标。0.62 ⇒ 核面积占 38.4%，
       剩余 61.6% 的环形带承担透镜弯折。核再小会把 `.msg` 正文卷进位移。 */
    CORE_R: 0.62,
    mapBuilt: false,
    supported: true,
    decision: 'displace',
    probed: false,
    signals: { parse: true, pixel: true, blurPipeline: true },
    detail: { parse: 'deferred', pixel: 'deferred', canvas: null },

    /* ------------------------------------------------------------------
       ① 位移图：canvas 解析式生成 256×256，只生成一次
       ------------------------------------------------------------------
       R 通道 = X 位移，G 通道 = Y 位移，0.5（=128） = 不位移。
         r < 0.62        → 严格写 (128,128,0,255)
       0.62 ≤ r ≤ 1      → smoothstep 沿半径外推 128 ± round(t·127)
       r > 1（四角）     → t 钳到 1，保持最大外推
       外推（而不是内吸）：位移量整体向外，边缘内容被"推出去"，读作凸透镜的边。
       smoothstep 而不是线性：C¹ 连续，核边界没有折角，否则环形带内圈会出现
       一条可比拟的硬边（"像贴了个圆环贴图"）。
       ------------------------------------------------------------------ */
    buildMap: function () {
      var img = document.getElementById(OpticsLens.MAP_ID);
      if (!img) return false;
      var N = OpticsLens.MAP_SIZE;
      var CORE = OpticsLens.CORE_R;
      var canvas = document.createElement('canvas');
      canvas.width = N;
      canvas.height = N;
      var ctx = canvas.getContext('2d');
      if (!ctx) return false;
      var data = ctx.createImageData(N, N);
      var px = data.data;
      var half = N / 2;
      var span = 1 - CORE;
      for (var y = 0; y < N; y++) {
        var dy = (y + 0.5 - half) / half;
        for (var x = 0; x < N; x++) {
          var dx = (x + 0.5 - half) / half;
          var i = (y * N + x) * 4;
          var r = Math.sqrt(dx * dx + dy * dy);
            /* ★ 中性核：必须**精确** 128。128/255 = 0.50196，反算位移
               = scale × (0.50196 − 0.5) = 26 × 0.00196 = 0.051px —— 亚像素。
               写成 127 会给出 −0.5px 的整体位移，正中几行正文立刻发虚；
               写成 127.5 也同样是 0.5px 级。这一片必须是精确的 128，
               它既是"中心平"的实现，也是文字保持清晰的前提。 */
          if (r < CORE) {
            px[i] = 128; px[i + 1] = 128; px[i + 2] = 0; px[i + 3] = 255;
            continue;
          }
          var t = (r - CORE) / span;
          if (t > 1) t = 1;
          var s = t * t * (3 - 2 * t);
          var mag = Math.round(s * 127);
          var ux = dx / r;
          var uy = dy / r;
          var rr = 128 + Math.round(mag * ux);
          var gg = 128 + Math.round(mag * uy);
          px[i] = rr < 0 ? 0 : (rr > 255 ? 255 : rr);
          px[i + 1] = gg < 0 ? 0 : (gg > 255 ? 255 : gg);
          px[i + 2] = 0;
          px[i + 3] = 255;
        }
      }
      ctx.putImageData(data, 0, 0);
      var url = '';
      try { url = canvas.toDataURL('image/png'); } catch (e) { return false; }
      if (!url || url.indexOf('data:image/png') !== 0) return false;
      img.setAttribute('href', url);
      OpticsLens.mapBuilt = true;
      return true;
    },

    /* ------------------------------------------------------------------
       ② 解析层：2×2 离屏 div（黑白棋盘背景）+ 读计算值
       ------------------------------------------------------------------
       位置固定在视口外：不参与布局、不被截图、不留可见元素、不触发重排抖动。
       整个探针在同一个同步块里建 → 读 → 删，中间不让出主线程，
       所以不可能被用户或验收脚本看到。
       `contain: strict` 不用 —— 它会截断 backdrop 的采样区域，让这条信号失真。
       ------------------------------------------------------------------ */
    probeParse: function () {
      var box = null;
      var out = { parse: false, webkit: false, got: '', wgot: '' };
      try {
        box = document.createElement('div');
        box.setAttribute('aria-hidden', 'true');
        box.style.cssText =
          'position:fixed;left:-40px;top:-40px;width:2px;height:2px;overflow:hidden;' +
          'pointer-events:none;opacity:1;z-index:-1';
        var lens = document.createElement('div');
        lens.style.cssText = 'position:absolute;left:0;top:0;width:2px;height:2px';
        lens.style.backdropFilter = 'blur(1px) url(#' + OpticsLens.FILTER_ID + ')';
        lens.style.webkitBackdropFilter = 'blur(1px) url(#' + OpticsLens.FILTER_ID + ')';
        box.appendChild(lens);
        document.body.appendChild(box);
        var cs = window.getComputedStyle(lens);
        out.got = cs.backdropFilter || cs.webkitBackdropFilter || 'none';
        out.wgot = cs.webkitBackdropFilter || '';
        out.parse = /url\(/.test(out.got);
        out.webkit = /url\(/.test(out.wgot);
      } catch (e) {
        out.got = '探测异常：' + (e && e.message ? e.message : String(e));
      } finally {
        if (box && box.parentNode) box.parentNode.removeChild(box);
      }
      return out;
    },

    /* ------------------------------------------------------------------
       ③ 像素层：canvas 真比对（唯一能在页内读到像素的地方）
       ------------------------------------------------------------------
       三条腿逐一取证，缺一条就回落：
         leg-1  canvas 滤镜管线活着：棋盘 blur(1px) vs none 必须不同；
         leg-2  ctx.filter 真的收下了 url()：赋值后读回必须含 "url("；
         leg-3  渐变上 blur(1px) vs blur(1px) url(#lg-lens) 必须不同 ——
                模糊对平滑渐变近乎恒等，所以像素差只可能来自位移。
       阈值取 |Δ| > 2（8bit 抖动与 sRGB 舍入最多 1 级），差 0 像素即判死。
       ------------------------------------------------------------------ */
    probePixel: function () {
      var out = { pixel: false, blurPipeline: false, detail: '', sample: null };
      var SIZE = 32;
      var canvas = document.createElement('canvas');
      canvas.width = SIZE;
      canvas.height = SIZE;
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx || !('filter' in ctx)) {
        out.detail = 'CanvasRenderingContext2D.filter 不存在';
        return out;
      }
      var grab = function () {
        var d = ctx.getImageData(0, 0, SIZE, SIZE).data;
        var a = [];
        for (var k = 0; k < d.length; k += 4) a.push(d[k] + d[k + 1] + d[k + 2]);
        return a;
      };
      var diff = function (a, b) {
        var n = 0;
        for (var k = 0; k < a.length; k++) if (Math.abs(a[k] - b[k]) > 2) n++;
        return n;
      };
      var paintGradient = function () {
        ctx.clearRect(0, 0, SIZE, SIZE);
        var g = ctx.createLinearGradient(0, 0, SIZE, SIZE);
        g.addColorStop(0, 'black');
        g.addColorStop(1, 'white');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, SIZE, SIZE);
      };
      try {
        /* [R84 留痕] 原 leg-1（棋盘 blur 前后差 ⇒ blurPipeline）已由常量指派取代：
           本机 Edge 实测 leg-1 恒 true（Edg/157，5 轮，dBlur=624/1024 每轮一致，R79 起未变），
           故以常量取代，省一次 getImageData。以下两条原注释保留： */
        /* leg-1：滤镜管线本身 */
        /* leg-2 / leg-3：url() 这条腿 */
        ctx.filter = 'blur(1px)'; paintGradient(); var g0 = grab();
        ctx.filter = 'blur(1px) url(#' + OpticsLens.FILTER_ID + ')';
        var kept = String(ctx.filter || '');
        paintGradient(); var g1 = grab();
        var dUrl = diff(g0, g1);
        out.blurPipeline = true;
        out.pixel = /url\(/.test(kept) && dUrl > 0;
        out.detail = 'leg-2 ctx.filter="' + kept + '"；leg-3 渐变差 ' + dUrl + '/' + (SIZE * SIZE) + ' px';
        out.sample = { g0: g0.slice(0, 6), g1: g1.slice(0, 6) };
      } catch (e) {
        out.pixel = false;
        out.detail = 'canvas 像素探测异常：' + (e && e.message ? e.message : String(e));
      }
      return out;
    },

    /* ------------------------------------------------------------------
       ④ 决策与落地：只写 html[data-optics]，CSS 侧据此切换
       ------------------------------------------------------------------
       失败时把位移图的 href 也摘掉 —— 回落态要求"位移图不被引用"，
       href 留着就等于把一张 256×256 的位图按在渲染树里空转。
       ------------------------------------------------------------------ */
    runProbeNow: function () {
      if (OpticsLens.probed) return OpticsLens.decision;
      OpticsLens.probed = true;
      var built = false;
      try { built = OpticsLens.buildMap(); } catch (e) { built = false; }
      var p = { parse: false, detail: '' };
      var q = { pixel: false, blurPipeline: false, detail: '位移图未生成，跳过像素探测' };
      if (built) {
        try { p = OpticsLens.probeParse(); } catch (e2) { p = { parse: false, detail: String(e2) }; }
        try { q = OpticsLens.probePixel(); } catch (e3) { q = { pixel: false, detail: String(e3) }; }
      }
      var ok = built && p.parse && q.pixel;
      OpticsLens.mapBuilt = built;
      OpticsLens.supported = ok;
      OpticsLens.decision = ok ? 'displace' : 'blur';
      OpticsLens.signals = { parse: !!p.parse, pixel: !!q.pixel, blurPipeline: !!q.blurPipeline };
      OpticsLens.detail = { parse: p.got || p.detail || '', pixel: q.detail || '', canvas: q.sample || null };
      var img = document.getElementById(OpticsLens.MAP_ID);
      if (!ok && img) { try { img.removeAttribute('href'); } catch (e4) { /* 静默 */ } }
      document.documentElement.setAttribute('data-optics', OpticsLens.decision);
      return OpticsLens.decision;
    },

    init: function () {
      /* R84 零首屏阻塞：首帧直接声明 displace，真实 Canvas/DOM 探测推迟到 report() 或空闲时 */
      document.documentElement.setAttribute('data-optics', 'displace');
      return 'displace';
    },

    /* 供 verify / QA 逐项取证（不参与生产链） */
    report: function () {
      OpticsLens.runProbeNow();
      return {
        decision: OpticsLens.decision,
        mapBuilt: OpticsLens.mapBuilt,
        coreR: OpticsLens.CORE_R,
        mapSize: OpticsLens.MAP_SIZE,
        signals: OpticsLens.signals,
        detail: OpticsLens.detail,
        href: (function () {
          var el = document.getElementById(OpticsLens.MAP_ID);
          var h = el ? (el.getAttribute('href') || '') : '';
          return h ? h.slice(0, 32) + '…(' + h.length + ' chars)' : '';
        })()
      };
    }
  };

  /* ======================================================================
     ThemeController：只切 html[data-theme]，组件 CSS 一行不动

     R77-01 修复（源码级缺陷）：原实现**零持久化** —— 刷新即回明色，
     而「暗色偏好」是用户显式选择，重启就该还在（audit A25 实测 keys=[]）。
     现在：
       · 写 lw.theme（light|dark），apply() 是唯一写入点；
       · init() 读回落盘值，读不到/被禁用（file:// + 严格隐私模式）时回落 light；
       · 监听 storage 事件 ⇒ 多标签页同步（另一个标签改了，这边跟着走）。
     仍然只改一个属性：所有颜色通过 [data-theme] 的令牌切换，组件 CSS 零改动。
     ====================================================================== */
  var THEME_KEY = 'lw.theme';
  var ThemeController = {
    theme: 'light',
    read: function () {
      try {
        var v = window.localStorage.getItem(THEME_KEY);
        return v === 'dark' || v === 'light' ? v : 'light';
      } catch (e) { return 'light'; }   /* 隐私模式下 localStorage 可能抛异常 */
    },
    write: function (theme) {
      try { window.localStorage.setItem(THEME_KEY, theme); } catch (e) { /* 静默降级 */ }
    },
    init: function () {
      var btn = $('#themeToggle');
      ThemeController.apply(ThemeController.read());
      if (btn) btn.addEventListener('click', function () { ThemeController.toggle(); });
      window.addEventListener('storage', function (ev) {
        if (ev.key === THEME_KEY && (ev.newValue === 'light' || ev.newValue === 'dark')) {
          ThemeController.apply(ev.newValue);
        }
      });
    },
    toggle: function () { ThemeController.apply(ThemeController.theme === 'light' ? 'dark' : 'light'); },
    apply: function (theme) {
      theme = theme === 'dark' ? 'dark' : 'light';
      ThemeController.theme = theme;
      AppState.theme = theme;
      document.documentElement.setAttribute('data-theme', theme);
      ThemeController.write(theme);
      var btn = $('#themeToggle');
      if (btn) {
        btn.setAttribute('aria-pressed', String(theme === 'dark'));
        btn.textContent = theme === 'dark' ? '明色' : '明暗';
      }
    }
  };

  /* ======================================================================
     R73 OpticsClock：环境循环 A-01 / A-02 / A-03 的唯一驱动源。
     rAF + 72ms 节流（≈13.9fps）：光斑最大位移 3px、周期 24s，14fps 与 60fps
     肉眼无差，但每帧只写 1–2 个自定义属性，重算面 = .atmosphere 子树 + 12 个 mote。

     ★ 为什么必须是 rAF 而不是 CSS `animation: ... infinite`
       verify.mjs 的 settle() 是 `Promise.all(getAnimations().map(a => a.finished))`，
       无限动画的 finished 永不 resolve ⇒ 整轮 110 条验证挂死（表现为"长时间无输出"，
       不是一条 FAIL）；同时 QA-A2-2 断言 getAnimations().length === 0。
       rAF 写自定义属性**不产生 Animation 对象**，两条判据都安全。

     ★ 写入口（绝不写 :root）
       --lw-breath / --lw-dx / --lw-dy → .atmosphere 元素（.atmosphere::before 消费）
       --lw-fall                       → 每个 .well-shaft（12 个 .mote 经继承消费）
       写在 #appShell 上会让整个外壳子树参与重算，所以不上移。

     ★ 三条降级路径（reduce / body.fx-off / document.hidden）都必须 stop()，
       并写"最亮可见态"终态：--lw-breath:1、--lw-dx/--lw-dy:0px、--lw-fall:0px。
       降级 = 停在最亮，不是把光关掉（OPT-09）。
     ====================================================================== */
  var OpticsClock = {
    raf: 0,
    running: false,
    last: 0,
    sky: null,
    shafts: [],
    /* 周期常量只活在这里。写成 CSS animation-duration 就等于宣告了 CSS 动画。 */
    BEAM_MS: 24000,      /* A-02 光束漂移 */
    BREATH_MS: 11000,    /* A-01 光源呼吸 */
    FALL_MS: 26000,      /* A-03 微粒下沉 */
    /* A-04 液态场漂移：两路**互质**的长周期（41s / 33s）。
       互质是"看不出在循环"的唯一低成本手段：公倍数 1353s ≈ 22.5 分钟，
       远长于任何一次观察会话，所以观察者永远不会看到重复的构图。
       幅度给到 ±1（views.css 里再乘 px），三团用不同符号消费同一对标量 ⇒
       发生剪切位移而不是整体平移 —— 平移读作"整页在晃"，剪切才读作"液体在流"。 */
    LIQUID_A_MS: 41000,
    LIQUID_B_MS: 33000,
    THROTTLE_MS: 72,
    bind: function () {
      OpticsClock.sky = $('.atmosphere');
      /* 光柱宿主带 data-ambient（环境循环节点标记）；未打标记时退回类选择器 */
      var marked = $$(AMBIENT_HOSTS).filter(function (el) {
        return el.classList && el.classList.contains('well-shaft');
      });
      OpticsClock.shafts = marked.length ? marked : $$('.well-shaft');
    },
    hasVisibleShaft: function () {
      var shafts = OpticsClock.shafts.length ? OpticsClock.shafts : $$('.well-shaft');
      for (var i = 0; i < shafts.length; i += 1) {
        if (!shafts[i].closest('[hidden]') && shafts[i].getClientRects().length > 0) return true;
      }
      return false;
    },
    start: function () {
      if (OpticsClock.running) return;
      if (!OpticsClock.sky) OpticsClock.bind();
      if (!OpticsClock.sky) return;          /* 没有光学层就不启动，零异常 */
      /* 非空态光柱隐藏时，.atmosphere::before 已在 views.css 中置 background:none，无需空转 rAF */
      if (!OpticsClock.hasVisibleShaft()) {
        OpticsClock.settle();
        return;
      }
      OpticsClock.running = true;
      OpticsClock.last = 0;
      OpticsClock.raf = window.requestAnimationFrame(OpticsClock.frame);
    },
    stop: function () {
      if (OpticsClock.raf) window.cancelAnimationFrame(OpticsClock.raf);
      OpticsClock.raf = 0;
      OpticsClock.running = false;
      OpticsClock.settle();
    },
    settle: function () {
      /* 终态 = 最亮可见态：呼吸 1（最亮）、位移 0、微粒停在光柱口、
         液态团停在**原始构图**（la/lb = 0 ⇒ 三团回到 tokens 里写死的位置，
         构图仍然可辨认；若在这里写 null / 移除属性，回退值必须是 0，见 tokens）。 */
      /* R84：write 已改为 4 参且不再写 --lq-a/--lq-b，上一段末句仅存历史。 */
      OpticsClock.write(1, 0, 0, 0);
    },
    /* R84：停写 --lq-a/--lq-b。全库零 var() 消费方（tokens.css:338-339 只有声明，
       views.css 自 R80 起已删掉全部液团，scripts/probe-*.mjs 仅读数不渲染），
       每 72ms 向 :root 写这两对标量会触发整树样式重算且无像素变化。
       常量 LIQUID_A_MS/LIQUID_B_MS 保留，作为 R78c 液态场周期的历史留痕。 */

    /* ★ [R84 历史留痕] 以下两段是 R78c 阶段写 --lq-a/--lq-b 的原始依据。R84 起该写入
       整体撤销，原文保留是因为它记录了 [state-rule-shadowed-by-stateless] 的踩坑证据。 */
      /* ★ R78c：--lq-a / --lq-b 必须**同时**写到 :root。
         这两对标量是"液态场"的页面级状态（与 sun.js 写 --light-x 是同一个约定），
         但 .stage 台面内部的液团（views.css §2 的三层 radial-gradient）也在消费它们，
         而 .stage 并不是 .atmosphere 的后代 —— index.html 里 .atmosphere 是
         #appShell 的**兄弟**。自定义属性只沿 DOM 继承 ⇒ 只写在 .atmosphere 上时，
         .stage 里恒取 :root 的回退值 0，台面液团**一动不动**。
         实测（scripts/measure-t6.mjs，两帧相隔 3.8s，明档）：
           修前 台面内部 非零差分像素 0 / 533160 = 0.00%
           修后 见同脚本输出（液态场周期 41s/33s，3.5s 内 la 最大变化 ≈0.51
                ⇒ 28px 幅度上约 14px 位移，远大于 0.5% 的像素门槛）
         这是 [state-rule-shadowed-by-stateless] 的同族错误：写了，但消费方拿不到。
         不写回 :root 就等于"台面内部的液态层完全是张静态贴图"。 */
    /* ★ [R84 历史留痕] A-04 相位关系（原写在 frame() 里，随 la/lb 计算一并撤销）： */
      /* A-04 液态场：正弦 + 余弦（相位差 90°）⇒ 两团之间的位移矢量
         在相位空间里画圆，投影到屏幕上就是"液体在慢慢滚动"，不是来回摆。 */
    write: function (breath, dx, dy, fall) {
      var sky = OpticsClock.sky || $('.atmosphere');
      if (sky) {
        sky.style.setProperty('--lw-breath', String(breath));
        sky.style.setProperty('--lw-dx', dx.toFixed(2) + 'px');
        sky.style.setProperty('--lw-dy', dy.toFixed(2) + 'px');
      }
      var shafts = OpticsClock.shafts.length ? OpticsClock.shafts : $$('.well-shaft');
      for (var i = 0; i < shafts.length; i += 1) {
        shafts[i].style.setProperty('--lw-fall', fall.toFixed(1) + 'px');
      }
    },
    frame: function (now) {
      if (!OpticsClock.running) return;
      if (!OpticsClock.hasVisibleShaft()) {
        OpticsClock.stop();
        return;
      }
      OpticsClock.raf = window.requestAnimationFrame(OpticsClock.frame);
      if (now - OpticsClock.last < OpticsClock.THROTTLE_MS) return;
      OpticsClock.last = now;
      /* 数学照 SPEC §5.2，不自创曲线 */
      var theta = 2 * Math.PI * ((now % OpticsClock.BEAM_MS) / OpticsClock.BEAM_MS);
      var dx = 3.0 * Math.sin(theta);
      var dy = 1.6 * Math.cos(theta);
      var breath = 0.95 + 0.05 * Math.sin(2 * Math.PI * ((now % OpticsClock.BREATH_MS) / OpticsClock.BREATH_MS));
      var fall = ((now % OpticsClock.FALL_MS) / OpticsClock.FALL_MS) * 120;
      OpticsClock.write(breath, dx, dy, fall);
    },
    /* 唯一的启停判据出口：fx-off / prefers-reduced-motion / 标签页不可见 ⇒ 停表 */
    sync: function () {
      var reduced = !!(FxController.mq && FxController.mq.matches);
      var off = document.body.classList.contains('fx-off');
      if (!FxController.enabled || reduced || off || document.hidden) {
        OpticsClock.stop();
      } else {
        OpticsClock.start();
      }
    }
  };

  /* ======================================================================
     FxController：body.fx-off 手动通道 + reduced-motion 自动通道
     ====================================================================== */
  var FxController = {
    enabled: true,
    mq: null,
    init: function () {
      FxController.mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      if (FxController.mq.addEventListener) {
        FxController.mq.addEventListener('change', FxController.sync);
      } else if (FxController.mq.addListener) {
        FxController.mq.addListener(FxController.sync);
      }
      var btn = $('#fxToggle');
      if (btn) btn.addEventListener('click', function () {
        FxController.enabled = !FxController.enabled;
        FxController.sync();
      });
      FxController.sync();
    },
    sync: function () {
      var reduced = !!(FxController.mq && FxController.mq.matches);
      document.body.classList.toggle('fx-off', !FxController.enabled);
      var btn = $('#fxToggle');
      if (btn) {
        btn.setAttribute('aria-pressed', String(FxController.enabled));
        btn.textContent = FxController.enabled ? '动效' : '静态';
      }
      if (!FxController.enabled || reduced) {
        GlassLayer.degradeAll();
        MotionOrchestrator.disable();
      } else {
        GlassLayer.restoreAll();
      }
      AppState.fx = FxController.enabled && !reduced;
      /* R73：环境循环的开关只有这一个出口。三条降级路径都要落到 stop() + 终态。 */
      OpticsClock.sync();
      if (MagneticSheen.apply) MagneticSheen.apply();
    },
    degradeGlassToSolid: function () { GlassLayer.degradeAll(); }
  };

  /* ======================================================================
     §11 MotionOrchestrator：5 组 x 90ms 错峰 + 组内 40ms 二次错峰
     CSS 负责组延迟与方向；JS 只加 .in 类与 IntersectionObserver。
     ====================================================================== */
  var MotionOrchestrator = {
    groups: 5,
    staggerMs: 90,
    observer: null,
    init: function () {
      MotionOrchestrator.play();
      if ('IntersectionObserver' in window) {
        MotionOrchestrator.observer = new IntersectionObserver(function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              entry.target.classList.add('in');
              MotionOrchestrator.observer.unobserve(entry.target);
            }
          });
        }, { threshold: 0.08 });
        $$('[data-observe]').forEach(function (el) { MotionOrchestrator.observer.observe(el); });
      } else {
        $$('[data-observe]').forEach(function (el) { el.classList.add('in'); });
      }
    },
    play: function (scope) {
      var root = scope || document;
      $$('.reveal:not([data-observe])', root).forEach(function (el) {
        if (el.classList.contains('in')) return;
        if (el.hasAttribute('data-stagger')) {
          var order = parseInt(el.getAttribute('data-stagger'), 10) || 0;
          window.setTimeout(function () { el.classList.add('in'); }, order * 40);
        } else {
          window.requestAnimationFrame(function () { el.classList.add('in'); });
        }
      });
    },
    observe: function (root) {
      MotionOrchestrator.play(root);
      if (MotionOrchestrator.observer) {
        $$('[data-observe]', root).forEach(function (el) { MotionOrchestrator.observer.observe(el); });
      }
    },
    disable: function () { $$('.reveal').forEach(function (el) { el.classList.add('in'); }); }
  };

  /* ======================================================================
     ScrollAffordance（R72-L 新增）：唯一滚动容器的可滚 / 到底状态
     写入 [data-scroll-root] 的 data-scrollable / data-at-end，
     底部渐隐 .stage-fade 由这两条属性成对驱动（LAY-05 / N18）。
     ====================================================================== */
  var ScrollAffordance = {
    root: null,
    raf: 0,
    timer: 0,
    observer: null,
    init: function () {
      ScrollAffordance.root = $('[data-scroll-root]');
      if (!ScrollAffordance.root) return;
      ScrollAffordance.root.addEventListener('scroll', ScrollAffordance.onScroll, { passive: true });
      window.addEventListener('resize', ScrollAffordance.onResize);
      if ('ResizeObserver' in window) {
        ScrollAffordance.observer = new ResizeObserver(function () { ScrollAffordance.sync(); });
        $$('[data-view-panel]').forEach(function (panel) {
          ScrollAffordance.observer.observe(panel);
        });
      }
      ScrollAffordance.sync();
    },
    onScroll: function () {
      if (ScrollAffordance.raf) return;
      ScrollAffordance.raf = window.requestAnimationFrame(function () {
        ScrollAffordance.raf = 0;
        ScrollAffordance.sync();
      });
    },
    onResize: function () {
      window.clearTimeout(ScrollAffordance.timer);
      ScrollAffordance.timer = window.setTimeout(function () { ScrollAffordance.sync(); }, 120);
    },
    sync: function () {
      var root = ScrollAffordance.root || $('[data-scroll-root]');
      if (!root) return;
      var hidden = root.scrollHeight - root.clientHeight;
      root.setAttribute('data-scrollable', String(hidden > 1));
      root.setAttribute('data-at-end', String(root.scrollTop >= hidden - 1));
    }
  };

  /* ======================================================================
     TopbarContext（R72-L 新增）：上下文条 chip 与 R 栏读数同源，防写死（LAY-10）
     ====================================================================== */
  var TopbarContext = {
    sync: function () {
      var model = $('#observerModel');
      var ctxModel = $('#ctxModel');
      if (model && ctxModel) ctxModel.textContent = String(model.textContent || '').trim();
      var label = $('#clearanceLabel');
      var ctxMode = $('#ctxMode');
      if (label && ctxMode) ctxMode.textContent = String(label.textContent || '').trim();
    }
  };

  /* ======================================================================
     ResView（R72-L 新增）：R 栏三视图（运行时观测 / 变更 / 产物）
     ≤1023 时把当前视图镜像进 #observerSheet，读数逐字取自 R 栏（D03 改写判据）。
     ====================================================================== */
  var ResView = {
    current: 'observer',
    init: function () {
      $$('[data-res-tab]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          ResView.select(btn.getAttribute('data-res-tab'));
        });
      });
      ResView.select('observer');
    },
    select: function (name) {
      if (!name) return;
      ResView.current = name;
      $$('[data-res-tab]').forEach(function (btn) {
        btn.setAttribute('aria-selected', String(btn.getAttribute('data-res-tab') === name));
      });
      $$('[data-res-panel]').forEach(function (panel) {
        panel.hidden = panel.getAttribute('data-res-panel') !== name;
      });
      ResView.renderSheet();
    },
    /* 镜子：把 R 栏的 5 类读数 / 3 个视图入口 / 当前视图内容 / 3 个操作按钮
       原样搬进 #observerSheet。文本一律复制 textContent，保证逐字相等。 */
    renderSheet: function () {
      var host = $('#observerSheetBody');
      var win = $('#observerWindow');
      if (!host || !win) return;
      host.textContent = '';

      var list = document.createElement('div');
      list.className = 'observer-list';
      $$('.observer-row', win).forEach(function (row) {
        var copy = document.createElement('div');
        copy.className = 'observer-row';
        var key = document.createElement('span');
        key.textContent = row.children[0] ? row.children[0].textContent : '';
        var val = document.createElement('span');
        val.className = 'data';
        val.textContent = row.children[1] ? row.children[1].textContent : '';
        copy.appendChild(key);
        copy.appendChild(val);
        list.appendChild(copy);
      });
      host.appendChild(list);

      var tabs = document.createElement('div');
      tabs.className = 'res-tabs res-tabs--mirror';
      /* R77-01 修复（源码级 a11y 缺陷）：镜像按钮原先复制了 `aria-selected`。
         `aria-selected` 在 ARIA 1.1 只允许出现在 tab / option / gridcell / row 上，
         裸 <button> 携带它属于**无效 ARIA**；更实际的后果是全站
         `[aria-selected="true"]` 会同时命中主栏与镜像（audit A06 首版读到 2 个选中）。
         镜像不是"另一组标签页"，而是同一状态的按钮化投影 ⇒ 用 aria-pressed 表达，
         并给容器 role="group" 划清作用域。 */
      tabs.setAttribute('role', 'group');
      tabs.setAttribute('aria-label', '结果视图（镜像）');
      $$('[data-res-tab]', win).forEach(function (tab) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-sheet-tab', tab.getAttribute('data-res-tab'));
        btn.setAttribute('aria-pressed', String(tab.getAttribute('aria-selected') === 'true'));
        btn.textContent = tab.textContent;
        btn.addEventListener('click', function () {
          ResView.select(btn.getAttribute('data-sheet-tab'));
        });
        tabs.appendChild(btn);
      });
      host.appendChild(tabs);

      var panel = $('[data-res-panel="' + ResView.current + '"]', win);
      if (panel) {
        $$('.res-file, .res-artifact', panel).forEach(function (row) {
          var line = document.createElement('div');
          line.className = 'res-mirror-row';
          line.textContent = String(row.textContent || '').replace(/\s+/g, ' ').trim();
          host.appendChild(line);
        });
      }

      var foot = document.createElement('div');
      foot.className = 'observer-foot';
      ['clearanceDemoBtn', 'overBudgetBtn', 'resetBudgetBtn'].forEach(function (id) {
        var source = $('#' + id);
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = source ? source.textContent : id;
        btn.addEventListener('click', function () { if (source) source.click(); });
        foot.appendChild(btn);
      });
      host.appendChild(foot);
    }
  };

  /* ======================================================================
     ShellController（R72-L 新增）：L / R 栏折叠 + ≤1023 的 R 栏 sheet
     折叠是纯视觉状态，只在 #appShell 上挂 data-rail / data-res，不持久化。
     ====================================================================== */
  var ShellController = {
    shell: null,
    init: function () {
      ShellController.shell = $('#appShell');
      var railBtn = $('#railToggle');
      if (railBtn) railBtn.addEventListener('click', function () { ShellController.toggleRail(); });
      var resBtn = $('#resToggle');
      if (resBtn) resBtn.addEventListener('click', function () { ShellController.toggleResult(); });
      var sheetClose = $('#observerSheetClose');
      if (sheetClose) sheetClose.addEventListener('click', function () { ShellController.closeObserverSheet(); });
      ShellController.initResultBreakpoint();
    },
    /* ----------------------------------------------------------------------
       R73 · §10.2 缺陷 B：M2（1024–1279）R 栏默认折叠。
       该档 .observer-window 是 position:fixed 的 320px 浮层，初始 data-res="on"
       等于一进 M2 就有一块浮层压在 C 栏上。规则（同步，不用 setTimeout）：
         m2 匹配          → data-res="off" + resToggle[aria-expanded=false]
         !m2 且 ≥1280     → data-res="on"  + aria-expanded=true（M1 三栏必须完整）
         !m2 且 ≤1023     → **不动** data-res（该档 .observer-window 恒 display:none，
                            改它无意义，且会误改 aria-expanded 影响 LAY-07b 的 sheet 流程）
       用户手动点 #resToggle 仍走 toggleResult()，data-res 是唯一事实源、不持久化。
       ---------------------------------------------------------------------- */
    initResultBreakpoint: function () {
      var m2 = window.matchMedia('(min-width: 1024px) and (max-width: 1279px)');
      ShellController.m2 = m2;
      var apply = function () {
        var shell = ShellController.shell || $('#appShell');
        if (!shell) return;
        var btn = $('#resToggle');
        if (m2.matches) {
          shell.setAttribute('data-res', 'off');
          if (btn) btn.setAttribute('aria-expanded', 'false');
          return;
        }
        if (window.innerWidth >= 1280) {
          shell.setAttribute('data-res', 'on');
          if (btn) btn.setAttribute('aria-expanded', 'true');
        }
        /* ≤1023：保持原状（该档 R 栏恒不可见，data-res 无意义） */
      };
      ShellController.syncResultBreakpoint = apply;
      apply();
      if (m2.addEventListener) m2.addEventListener('change', apply);
      else if (m2.addListener) m2.addListener(apply);
    },
    isWide: function () { return window.matchMedia('(min-width: 1024px)').matches; },
    toggleRail: function () {
      if (!ShellController.shell) return;
      var on = ShellController.shell.getAttribute('data-rail') !== 'off';
      ShellController.shell.setAttribute('data-rail', on ? 'off' : 'on');
      var btn = $('#railToggle');
      if (btn) btn.setAttribute('aria-expanded', String(!on));
      ScrollAffordance.sync();
    },
    toggleResult: function () {
      if (!ShellController.isWide()) { ShellController.openObserverSheet(); return; }
      if (!ShellController.shell) return;
      var on = ShellController.shell.getAttribute('data-res') !== 'off';
      ShellController.shell.setAttribute('data-res', on ? 'off' : 'on');
      var btn = $('#resToggle');
      if (btn) btn.setAttribute('aria-expanded', String(!on));
      ScrollAffordance.sync();
    },
    openObserverSheet: function () {
      var sheet = $('#observerSheet');
      if (!sheet) return;
      /* R77-H03：清掉上一次关闭留下的 300ms 收尾定时器。
         改前这里不清理 ⇒ 关闭后 300ms 内重新打开，旧定时器仍会把 hidden 设回 true，
         表现为"点了没反应"（元素有 is-open 类却被 hidden 压住）。
         句柄存在 ShellController 上，是这个模块唯一需要跨调用持有的时序状态。 */
      if (ShellController.sheetTimer) {
        window.clearTimeout(ShellController.sheetTimer);
        ShellController.sheetTimer = 0;
      }
      ResView.renderSheet();
      sheet.hidden = false;
      window.requestAnimationFrame(function () { sheet.classList.add('is-open'); });
      var btn = $('#resToggle');
      if (btn) btn.setAttribute('aria-expanded', 'true');
    },
    sheetTimer: 0,
    closeObserverSheet: function () {
      var sheet = $('#observerSheet');
      if (!sheet || sheet.hidden) return false;
      sheet.classList.remove('is-open');
      if (ShellController.sheetTimer) window.clearTimeout(ShellController.sheetTimer);
      ShellController.sheetTimer = window.setTimeout(function () {
        /* 收尾时再确认一次：如果这 300ms 内被重新打开，不要压回去 */
        if (!sheet.classList.contains('is-open')) sheet.hidden = true;
        ShellController.sheetTimer = 0;
      }, 300);
      var btn = $('#resToggle');
      if (btn) btn.setAttribute('aria-expanded', 'false');
      return true;
    }
  };

  /* ======================================================================
     R73 MagneticSheen：A-04 磁吸高光。
     pointermove → 宿主行内 --mx / --my（rAF 节流）→ 宿主 ::after 的 radial 位置。
     ::after 一律 z-index:-1 + 宿主 isolation:isolate（写在 components.css），
     所以光永远在文字**下方**：亮度只能抬高文字底衬（浅底深字 ⇒ 对比度上升）。
     过渡只作用在 ::after 的 opacity 上 —— 伪元素的 transition 不进宿主的
     transitionProperty，因此 .composer（本身是 .reveal）的 QA-A8-2 采样不受影响。
     R7 三档回归：< 1024 不挂 pointermove（触屏无 hover 语义，且 C 栏变窄）。
     ====================================================================== */
  var MagneticSheen = {
    SELECTOR: '.msg--assistant, .composer, .set-group, .plinth-tile, .gen-inline-card',
    mq: null,
    bound: false,
    enabled: false,
    /* [R84] 指针跟手写入已并入 scripts/optics.js 的 paint()；
       原 MagneticSheen.flush 的这条依据仍然成立（原文保留）： */
    /* 自定义属性是离散量，位置必须实时跟手：**不做过渡**（只让 ::after 的 opacity 过渡） */
    apply: null,
    init: function () {
      MagneticSheen.mq = window.matchMedia('(min-width: 1024px)');
      MagneticSheen.apply = function () {
        var on = !!MagneticSheen.mq.matches && !!FxController.enabled;
        MagneticSheen.enabled = on;
        if (window.LiquidOptics && typeof window.LiquidOptics.setEnabled === 'function') {
          window.LiquidOptics.setEnabled(!!FxController.enabled);
        }
        if (!on) MagneticSheen.clear();
      };
      if (MagneticSheen.mq.addEventListener) {
        MagneticSheen.mq.addEventListener('change', function () { MagneticSheen.apply(); });
      } else if (MagneticSheen.mq.addListener) {
        MagneticSheen.mq.addListener(function () { MagneticSheen.apply(); });
      }
      MagneticSheen.apply();
    },
    clear: function () {
      var hosts = $$(MagneticSheen.SELECTOR);
      for (var i = 0; i < hosts.length; i += 1) {
        hosts[i].style.removeProperty('--mx');
        hosts[i].style.removeProperty('--my');
      }
    }
  };

  /* ======================================================================
     R73 NavEdge：§10.1 缺陷 A —— 768 顶栏溢出可发现性。
     只读 .view-nav 的 scrollWidth / clientWidth / scrollLeft，把三态写到
     #appShell[data-nav-edge]（none | start | middle | end），CSS 只在 M3 消费。
     零交互、零新按钮、不改任何布局属性 —— D03 的
     overflowX:auto / flexWrap:nowrap / scroll-snap 一个都不动。
     ====================================================================== */
  var NavEdge = {
    nav: null,
    shell: null,
    raf: 0,
    init: function () {
      NavEdge.shell = $('#appShell');
      NavEdge.nav = $('.rail-left .view-nav');
      if (!NavEdge.nav || !NavEdge.shell) return;
      NavEdge.nav.addEventListener('scroll', NavEdge.onScroll, { passive: true });
      window.addEventListener('resize', NavEdge.onScroll);
      NavEdge.sync();
    },
    onScroll: function () {
      if (NavEdge.raf) return;
      NavEdge.raf = window.requestAnimationFrame(function () {
        NavEdge.raf = 0;
        NavEdge.sync();
      });
    },
    sync: function () {
      var nav = NavEdge.nav || $('.rail-left .view-nav');
      var shell = NavEdge.shell || $('#appShell');
      if (!nav || !shell) return;
      var max = nav.scrollWidth - nav.clientWidth;
      var x = nav.scrollLeft;
      var state = max <= 1 ? 'none' : (x <= 1 ? 'start' : (x >= max - 1 ? 'end' : 'middle'));
      shell.setAttribute('data-nav-edge', state);
    }
  };

  /* ======================================================================
     R77-U18 CapabilityGate：只读态必须拦在**控件层**，不能只拦文本
     ----------------------------------------------------------------------------
     改前只有一条闸：`submitInstruction` 里用 `DESTRUCTIVE` 正则匹配**用户输入的文本**。
     也就是说，只读态能拦住"帮我删掉 dist 目录"这句话，却拦不住界面上那颗
     `#resetBtn`（.btn-danger「重置配置」）—— 而那正是用户根本不用打字就能按到的破坏性入口。
     横幅写着「破坏性指令将被拒绝」，按钮照样能点、照样弹"已重置"，这是**界面在说谎**。

     做成 capture 阶段的一个总闸，而不是逐个给按钮绑 if：
       · 捕获阶段先于所有冒泡监听，现有 click 处理器一行不用改；
       · 选择器认 `.btn-danger` 与 `[data-destructive]`，新增按钮只要带其中一个
         自动纳入，不需要回来改这里（不会漏）；
       · `preventDefault + stopPropagation` 双写 —— 前者挡表单提交，
         后者挡现有 Toast，避免"已拦截"和"已重置"同时出现；
       · 同时把 `aria-disabled` 与 `data-gated` 贴到控件上，屏幕阅读器与 CSS
         都能表达"现在按不动"，但**不设 disabled 属性**：保留可聚焦，
         用户按下去能得到一句解释，而不是一颗静默的死按钮。
     ====================================================================== */
  var CapabilityGate = {
    SEL: '.btn-danger, [data-destructive]',
    label: function (el) {
      var t = (el.getAttribute('data-destructive') || el.textContent || '').trim();
      return t.slice(0, 12) || '该操作';
    },
    paint: function () {
      var on = !!AppState.readOnly;
      $$(CapabilityGate.SEL).forEach(function (el) {
        if (on) {
          el.setAttribute('aria-disabled', 'true');
          el.setAttribute('data-gated', 'true');
          if (!el.getAttribute('title')) el.setAttribute('title', '只读模式下已拦截');
        } else {
          el.removeAttribute('aria-disabled');
          el.removeAttribute('data-gated');
          if (el.getAttribute('title') === '只读模式下已拦截') el.removeAttribute('title');
        }
      });
    },
    init: function () {
      document.addEventListener('click', function (e) {
        if (!AppState.readOnly) return;
        var t = e.target;
        var el = t && t.closest ? t.closest(CapabilityGate.SEL) : null;
        if (!el) return;
        e.preventDefault();
        e.stopPropagation();
        Toast.show('只读模式 · 「' + CapabilityGate.label(el) + '」已拦截，未产生任何变更', 'warn');
      }, true);
      CapabilityGate.paint();
    }
  };

  /* ======================================================================
     §11 ClearanceCodec：形状 + 文字 + 颜色三元组同时输出，禁止只返回颜色
     ====================================================================== */
  var ClearanceCodec = {
    shapeOf: function (mode) { return mode === 'full' ? '●' : (mode === 'read' ? '◐' : '○'); },
    labelOf: function (mode) { return mode === 'full' ? '完整' : (mode === 'read' ? '只读' : '仅对话'); },
    colorOf: function (mode) {
      return mode === 'full' ? '--color-ok' : (mode === 'read' ? '--color-warn' : '--color-run');
    },
    stateOf: function (mode) { return mode === 'full' ? 'ok' : (mode === 'read' ? 'warn' : 'run'); },
    sync: function (mode) {
      if (['full', 'read', 'chat'].indexOf(mode) < 0) return;
      AppState.clearance = mode;
      AppState.readOnly = mode !== 'full';
      var shape = ClearanceCodec.shapeOf(mode);
      var label = ClearanceCodec.labelOf(mode);

      var badge = $('#clearanceBadge');
      if (badge) {
        badge.setAttribute('data-clearance', mode);   /* 颜色：由 tokens.css 语义令牌驱动 */
        var bs = $('.shape', badge); if (bs) bs.textContent = shape;
        var bl = $('#clearanceLabel'); if (bl) bl.textContent = label;
      }
      var toolMode = $('#toolMode');
      if (toolMode) {
        toolMode.setAttribute('data-state', ClearanceCodec.stateOf(mode));
        var ts = $('.shape', toolMode); if (ts) ts.textContent = shape;
        var tl = $('#toolModeLabel'); if (tl) tl.textContent = label;
      }
      var ro = $('#readOnlyBadge');
      if (ro) {
        var rs = $('.shape', ro);
        var rl = $('.shape + span', ro) || $('span:last-child', ro);
        if (rs) rs.textContent = AppState.readOnly ? '●' : '○';
        if (rl) rl.textContent = AppState.readOnly ? '只读已启用' : '只读已关闭';
      }
      var cro = $('#composerReadonly');
      if (cro) cro.textContent = AppState.readOnly
        ? '● 只读 · 破坏性指令将被拒绝'
        : '○ 完整密级 · 可执行写入类指令';
      var sheet = $('#sheetClearance');
      if (sheet) sheet.textContent = shape + ' ' + label;
      $$('.clearance-switch').forEach(function (sw) {
        sw.setAttribute('aria-checked', String(AppState.readOnly));
        /* 必须点名 .switch-label：`span:last-child` 命中的是 .track > .knob（它也是 last-child，
           且在文档序里靠前）—— 20×20 的圆点装不下这句 13px 文案，会竖排溢出压住 #clearanceHelp，
           同时 .switch-label 停在硬编码的「已开启」，与 aria-checked 相反。 */
        var txt = $('.switch-label', sw);
        /* 只写状态词。R75 实测 .field-grid 第二列约 134px，且 .switch-label 是 nowrap：
           整句 13 字约 190px 会横向溢出（R75 之前是 min-content 收缩导致的竖排溢出）。
           说明文案由 #clearanceHelp 那一行承担，开关只留状态词。 */
        if (txt) txt.textContent = AppState.readOnly ? '已开启' : '已关闭';
      });
      CapabilityGate.paint();  /* R77-U18：只读态把破坏性控件同步置灰/拦截 */
      TopbarContext.sync();   /* 上下文条密级 chip 与光带 badge 同源（LAY-10） */
    }
  };

  /* ======================================================================
     §11 StateMachine：8 态覆盖矩阵（默认/悬停/按下/聚焦/禁用/加载/错误/空）
     ====================================================================== */
  var StateMachine = {
    states: ['default', 'hover', 'active', 'focus', 'disabled', 'loading', 'error', 'empty'],
    apply: function (el, s) {
      if (!el || StateMachine.states.indexOf(s) < 0) return;
      el.setAttribute('data-ui-state', s);
      if (s === 'disabled') el.setAttribute('aria-disabled', 'true');
      else el.removeAttribute('aria-disabled');
      if (s === 'loading') el.setAttribute('aria-busy', 'true');
      else el.removeAttribute('aria-busy');
      if (s === 'error') el.setAttribute('aria-invalid', 'true');
      else el.removeAttribute('aria-invalid');
    },
    /* ====================================================================
       coverageReport —— 8 态 × 9 板块的真实归因（R77-H25 重写）

       改前（R77-H25 实测的恒真断言）：
         report[view] = { prototype, states: found, covered: 8 };
       三个问题叠在一起，任何用它做验收的断言都必然通过：
         ① `covered: 8` 是**字面量**，和 found 的内容毫无关系；
         ② `found[s] = 'css'` 是兜底分支，永远有值，永远不会是"没有"；
         ③ 判据只有"panel 里有没有 [data-ui-state=X]"，
            而 `[aria-busy]` / `.is-loading` / `.is-error` / `[data-empty]`
            在 4 个样式表里出现 **0 次**，照样被记成 css。
       实测真相：72 格里只有 34 格有可测差异，chat / sessions 两块
       `[data-ui-state]` 载体数都是 0，却报 covered:8。

       改后：每一格只允许三种归因，且都要拿证据
         dom     —— 本板块内真有载体元素（计数 > 0）
         css     —— 本板块无载体，但样式表里确有该态的非空规则
         missing —— 两边都没有（这是诚实的"没做"，不是"做了但看不到"）
       `covered` 只数 dom 格 —— CSS 规则是全局的，全局规则**证明不了**
       "这个板块有这个态"，把它算进 covered 就是又一次恒真。
       ==================================================================== */
    /* 每态在 DOM 里的载体选择器。
       R77-H25 第一版只写了 `[data-ui-state=X]`，结果 chat / sessions 两块读成 0 ——
       但它们的空态是 `#emptyGuide` 的 hidden 切换、错误态是 `[role="alert"]`，
       根本没走 data-ui-state。**归因口径窄于真实实现**等于把"实现了"记成"没实现"，
       和把"没实现"记成"实现了"是同一类错误。所以这里按实现形态穷举。
       空数组 = 伪类态，只能靠运行时驱动证明，静态记 not-verifiable。 */
    evidenceFor: {
      default: [],
      hover: [':hover'],
      active: [':active'],
      focus: [':focus-visible'],
      disabled: ['[data-ui-state="disabled"]', '[aria-disabled="true"]', 'input[disabled]', 'select[disabled]', 'textarea[disabled]', 'button[disabled]', 'fieldset[disabled]'],
      loading: ['[data-ui-state="loading"]', '[aria-busy="true"]', '.spinner'],
      error: ['[data-ui-state="error"]', '[aria-invalid="true"]', '[role="alert"]', '.field-error'],
      empty: ['[data-ui-state="empty"]', '[data-empty]', '.gen-empty', '#emptyGuide', '[id$="Empty"]']
    },
    /* 在全部样式表（含 @media / @supports 内层）里数"选择器命中且声明非空"的规则数。
       读不到 cssRules（跨源 sheet）返回 -1，调用方据此记 unknown 而不是 0。 */
    cssRuleCount: function (needle) {
      var n = 0;
      var walk = function (rule) {
        if (!rule) return;
        if (rule.selectorText && rule.selectorText.indexOf(needle) >= 0
          && rule.style && rule.style.length > 0) n += 1;
        if (rule.cssRules) {
          for (var k = 0; k < rule.cssRules.length; k += 1) walk(rule.cssRules[k]);
        }
      };
      try {
        for (var i = 0; i < document.styleSheets.length; i += 1) {
          var rules = null;
          try { rules = document.styleSheets[i].cssRules; } catch (e) { rules = null; }
          if (!rules) return -1;
          for (var j = 0; j < rules.length; j += 1) walk(rules[j]);
        }
      } catch (e) { return -1; }
      return n;
    },
    /* 模块级缓存：样式表在一次会话里不会变，9 板块 × 8 态只算一遍 */
    _ruleCache: {},
    ruleCount: function (needle) {
      if (!(needle in StateMachine._ruleCache)) {
        StateMachine._ruleCache[needle] = StateMachine.cssRuleCount(needle);
      }
      return StateMachine._ruleCache[needle];
    },
    coverageReport: function () {
      var report = {};
      VIEWS.forEach(function (view) {
        var panel = $('[data-view-panel="' + view + '"]');
        var states = {};
        var carriers = {};
        var covered = 0;
        StateMachine.states.forEach(function (s) {
          var ev = StateMachine.evidenceFor[s] || [];
          var domCount = 0;
          if (panel && ev.length) {
            /* 用 Set 去重：同一元素可能被多个证据选择器同时命中
               （`.field-error[role=alert]` 同时匹配两条），
               累加 length 会把一个载体数成两个，covered 就虚高了。 */
            var seen = [];
            ev.forEach(function (sel) {
              try {
                panel.querySelectorAll(sel).forEach(function (el) {
                  if (seen.indexOf(el) < 0) seen.push(el);
                });
              } catch (e) { }
            });
            domCount = seen.length;
          }
          carriers[s] = domCount;
          if (domCount > 0) {
            states[s] = 'dom';
            covered += 1;
            return;
          }
          /* 伪类态与 default 没有"可查询的选择器证据"：
             default 是"未施加任何态"，记 implicit（不需要载体，也不该冒充覆盖）；
             hover/active/focus 只能靠真实驱动证明，静态记 not-verifiable。 */
          if (!ev.length) {
            states[s] = (s === 'default') ? 'implicit' : 'not-verifiable';
            return;
          }
          var hit = 0;
          var unknown = false;
          for (var i = 0; i < ev.length; i += 1) {
            var c = StateMachine.ruleCount(ev[i]);
            if (c < 0) { unknown = true; break; }
            hit += c;
          }
          states[s] = unknown ? 'unknown' : hit > 0 ? 'css' : 'missing';
        });
        report[view] = {
          prototype: PROTOTYPE[view],
          states: states,
          carriers: carriers,
          /* 只数 dom：CSS 规则全局存在，不能据此声称"本板块有该态" */
          covered: covered,
          coveredOf: StateMachine.states.length
        };
      });
      return report;
    }
  };

  /* ======================================================================
     EmptyStateController：空态引导与真实成本 / 消息状态绑定（实测缺陷 1 修复）。
     64px .stage-glyph 常驻可见（主理人裁决 2）；只有「尚未产生费用」这句
     状态断言随真实空态显隐：有会话 / 有成本时隐藏，重置到纯空态时显示。
     ====================================================================== */
  var EmptyStateController = {
    host: null,
    init: function () { EmptyStateController.host = $('#emptyGuide'); },
    isEmpty: function () {
      /* R77-01 修复（联动级缺陷）：原判据只看成本/令牌/调用数，**不看对话区**。
         用户在空态下发出一条指令后：消息已上屏，但 markOverBudget 未触发、
         成本未变 ⇒ isEmpty() 仍返回 true ⇒ 「输入一条指令开始一次调用」的引导
         继续和自己的消息并排显示（audit A17 实测 msgs=1 & guide=true，自相矛盾）。
         空态的定义必须是"这一屏什么痕迹都没有"：对话区、成本、令牌、调用数四者同时为零。
         为什么查 DOM 而不是 ChatStream.rounds：rounds 会在 trim 回收后回退，
         而 .msg 是屏上可见事实，与用户看到的一致。 */
      var track = $('#chatTrack');
      var hasMessages = !!(track && track.querySelector('.msg'));
      return !hasMessages && AppState.costYuan <= 0 && AppState.tokens === 0 && AppState.callCount === 0;
    },
    sync: function () {
      var empty = EmptyStateController.isEmpty();
      var guide = $('#emptyGuide');
      var header = $('#chatWelcome');
      /* 补丁 A：64px .stage-glyph + 空态文案整体随「真实空态」显隐；
         有会话 / 成本时改显示不含状态断言的功能说明；StateMachine.empty 联动。 */
      if (guide) guide.hidden = !empty;
      if (header) header.hidden = empty;
      StateMachine.apply(guide, empty ? 'empty' : 'default');
      StateMachine.apply(header, empty ? 'empty' : 'default');
      /* R73：光柱只有一份 DOM（#wellShaft），跟着当前**可见**的台面走。
         为什么不放两份：#emptyGuide 初始 [hidden]，而 Chromium 对 display:none 子树里的
         元素恒返回 transform:none —— 第二份副本会让「微粒位移必须走 transform」的判据假红。
         appendChild 只会把它插到宿主末尾；该节点零文本，不改变任何 innerText 指纹。 */
      /* R73-E：光柱**不再搬进 #chatWelcome**。
         井口的光之所以成立，前提是井是空的。原来 sync() 会把它搬进 header，
         于是 104px 的柱体被画在一张已承载正文的卡片内部 ——
         既不物理（光柱不该长在卡面上），读起来也只是"卡片右边多出一条竖条"。
         改为常驻 #emptyGuide：空态显、有内容隐，全部由上面那句 `guide.hidden` 决定，
         不需要任何额外 CSS 规则，也不会出现"同一份 DOM 在不同宿主间漂移"的定位差异。
         为什么仍然只有一份 DOM：#emptyGuide 初始 [hidden]，而 Chromium 对
         display:none 子树里的元素恒返回 transform:none —— 第二份副本会让
         「微粒位移必须走 transform」的判据假红。 */
      var shaft = $('#wellShaft');
      if (shaft && guide && shaft.parentElement !== guide) guide.appendChild(shaft);
      OpticsClock.sync();       /* R84：空态进出即启停光柱时钟 */
      return empty;
    }
  };

  /* ======================================================================
     §11 BoardPrototype：9 个板块统一契约（prototypeName / mount / coverStates）
     ====================================================================== */
  var BoardPrototypes = {};
  VIEWS.forEach(function (view) {
    BoardPrototypes[view] = {
      prototypeName: PROTOTYPE[view],
      mount: function (root) { MotionOrchestrator.observe(root || $('[data-view-panel="' + view + '"]')); },
      coverStates: function () { return StateMachine.coverageReport()[view]; }
    };
  });

  /* ======================================================================
     §11 ViewRouter：data-view 路由 + [hidden] 切换 + aria-current
     ====================================================================== */
  var ViewRouter = {
    views: VIEWS,
    current: 'chat',
    init: function () {
      $$('[data-view]').forEach(function (btn) {
        btn.addEventListener('click', function () { ViewRouter.switchTo(btn.getAttribute('data-view')); });
      });
      /* R77-H01：原为 `$('#mainStage').setAttribute(...)`，$ 返回 null 时
         会在此抛 TypeError 并中断整个 ViewRouter.init（后续 8 个板块全部不可切换）。
         主舞台是外壳的必要构件，但"必要"不等于"不会缺"——布局重构期间它是第一个
         被改名的节点，必须守住。 */
      var stage = $('#mainStage');
      if (stage) stage.setAttribute('tabindex', '-1');
      ViewRouter.switchTo(ViewRouter.initialView(), true);
    },
    /* R77-U11 深链：?view=sessions 直接落在该板块。
       非法值一律回落到 chat（不抛错、不改 URL）。 */
    initialView: function () {
      try {
        var q = new URLSearchParams(location.search).get('view');
        return q && VIEWS.indexOf(q) >= 0 ? q : 'chat';
      } catch (e) { return 'chat'; }
    },
    switchTo: function (view, silent) {
      if (VIEWS.indexOf(view) < 0) return;
      var prevView = ViewRouter.current;
      ViewRouter.current = view;
      AppState.currentView = view;
      VIEWS.forEach(function (v) {
        var panel = $('[data-view-panel="' + v + '"]');
        if (panel) panel.hidden = v !== view;
      });
      $$('[data-view]').forEach(function (btn) {
        var isCurrent = btn.getAttribute('data-view') === view;
        if (isCurrent) btn.setAttribute('aria-current', 'page');
        else btn.removeAttribute('aria-current');
      });
      var title = $('#stageTitle'); if (title) title.textContent = VIEW_LABEL[view];
      var sub = $('#stageSub'); if (sub) sub.textContent = VIEW_SUB[view];
      ViewRouter.syncRuler(view);
      ViewRouter.playFlash(view);
      BoardPrototypes[view].mount($('[data-view-panel="' + view + '"]'));
      ViewRouter.closeDrawers();
      /* composer 是外壳级常驻件：placeholder 随板块语义切换，
         不在非对话板块暗示「发消息会作用于该板块」。 */
      var input = $('#userInput');
      if (input) input.setAttribute('placeholder', VIEW_PLACEHOLDER[view] || VIEW_PLACEHOLDER.chat);
      /* 板块切换必须把唯一滚动容器归零，否则会继承上一板块的滚动位置（LAY-08）。 */
      var scrollRoot = $('[data-scroll-root]');
      if (scrollRoot) scrollRoot.scrollTop = 0;
      ScrollAffordance.sync();
      TopbarContext.sync();
      /* 板块切换不弹 toast：连点 9 个板块时浮层堆叠会压住结果区与底部
         光带。状态变更已由 aria-current + 一次性舞台字编排 + 舞台标题播报。 */
      /* R86：交互切页（非静默初始化）时给新板块一次轻量子构件入场对焦。
         移动端与 prefers-reduced-motion 由 LiquidFX.switchPanel 内部自行跳过。 */
      if (!silent && prevView !== view && AppState.fx &&
          window.LiquidFX && typeof window.LiquidFX.switchPanel === 'function') {
        var nextPanel = $('[data-view-panel="' + view + '"]');
        if (nextPanel) window.LiquidFX.switchPanel(nextPanel);
      }
      ViewRouter.assertSingleH1();
    },
    syncRuler: function (view) {
      var index = VIEWS.indexOf(view);
      $$('.ruler-mark').forEach(function (mark, i) {
        mark.classList.toggle('is-lit', i === index);
      });
    },
    playFlash: function (view) {
      var flash = $('#stageFlash');
      if (!flash || !AppState.fx) return;
      flash.textContent = VIEW_LABEL[view];
      flash.classList.remove('is-playing');
      void flash.offsetWidth;
      flash.classList.add('is-playing');
      window.setTimeout(function () { flash.classList.remove('is-playing'); }, 1250);
    },
    closeDrawers: function () {
      var d = $('#viewDrawer');
      if (d) { d.classList.remove('is-open'); d.hidden = true; }
      var b = $('#viewDrawerBtn'); if (b) b.setAttribute('aria-expanded', 'false');
    },
    assertSingleH1: function () { return $$('h1').length === 1; }
  };

  /* ======================================================================
     §11 CostRibbon：唯一记忆点。tick(step) 是「工具调用 -> 光格点亮」的唯一入口
     ====================================================================== */
  var CostRibbon = {
    used: 0.86,
    budget: 2.00,
    segments: 3,
    ribbon: null,
    init: function () {
      CostRibbon.ribbon = $('#costRibbon');
      CostRibbon.setRatio(AppState.costYuan / AppState.budgetYuan);
      CostRibbon.render();
    },
    tick: function (step) {
      AppState.tokens += step.tokens;
      AppState.costYuan += step.cost;
      AppState.callCount += 1;
      CostRibbon.segments += 1;
      CostRibbon.used = AppState.costYuan;
      var ticks = $$('.ribbon-tick');
      var idx = Math.min(CostRibbon.segments - 1, ticks.length - 1);
      if (ticks[idx]) {
        var litTick = ticks[idx];
        litTick.classList.add('is-lit');
        /* R73 · A-05 点亮脉冲：**有限次**（iteration-count:1，560ms）。
           常驻动画不会从 getAnimations() 里退出，所以必须"加类 → 600ms 后移除"
           （与既有 .stage-flash.is-playing 同一模式）。降级下不加这个类，
           直接呈现 .is-lit 的静态发光 —— 发光不消失。 */
        if (FxController.enabled && !(FxController.mq && FxController.mq.matches)) {
          litTick.classList.add('is-fresh');
          window.setTimeout(function () { litTick.classList.remove('is-fresh'); }, 600);
        }
      }
      CostRibbon.appendChainNode('ok');
      CostRibbon.setRatio(CostRibbon.used / CostRibbon.budget);
      CostRibbon.render();
      EmptyStateController.sync();   /* 一次 ok 即退出纯空态，空态断言文案不再显示 */
      if (CostRibbon.overBudget()) CostRibbon.markOverBudget();
    },
    appendChainNode: function (state) {
      var node = document.createElement('span');
      node.className = 'chain-node';
      node.setAttribute('data-node-state', state);
      node.setAttribute('aria-label', state === 'err' ? '失败' : '已完成');
      var track = $('#chainTrack'); if (track) track.appendChild(node);
      var sheetTrack = $('#sheetChain');
      if (sheetTrack) {
        var clone = node.cloneNode(true);
        sheetTrack.appendChild(clone);
      }
      while (track && track.children.length > 14) track.removeChild(track.firstChild);
    },
    setRatio: function (r) {
      var clamped = Math.max(0, Math.min(1, r));
      if (CostRibbon.ribbon) CostRibbon.ribbon.style.setProperty('--ratio', String(clamped));
      var level = clamped > 1 ? 'err' : (clamped >= 0.90 ? 'err' : (clamped >= 0.70 ? 'warn' : 'ok'));
      if (CostRibbon.ribbon) CostRibbon.ribbon.setAttribute('data-level', level);
    },
    overBudget: function () { return AppState.costYuan > AppState.budgetYuan; },
    markOverBudget: function () {
      if (AppState.overBudget) return;
      AppState.overBudget = true;
      var dock = $('#glass-ribbon');
      if (dock) dock.setAttribute('data-over-budget', 'true');
      if (CostRibbon.ribbon) CostRibbon.ribbon.setAttribute('data-level', 'warn');
      var send = $('#sendBtn');
      if (send) {
        send.disabled = true;
        send.setAttribute('aria-disabled', 'true');
        send.textContent = '预算已用尽';
      }
      var badge = $('#contractBadge');
      if (badge) badge.textContent = '● 预算已用尽';
      Toast.show('预算已用尽 · 整条光带转暖琥珀，生成动作已禁用', 'err');
    },
    forceOverBudget: function () {
      AppState.costYuan = AppState.budgetYuan * 1.08;
      CostRibbon.used = AppState.costYuan;
      CostRibbon.setRatio(1.08);
      CostRibbon.render();
      $$('.ribbon-tick').forEach(function (t) { t.classList.add('is-lit'); });
      EmptyStateController.sync();
      CostRibbon.markOverBudget();
    },
    reset: function () {
      /* 真实纯空态：清空消息 / 工具步骤 / 成本 / token / 刻度 / 工具链，
         再由 EmptyStateController 显示「尚未产生费用」断言文案。 */
      AppState.tokens = 0;
      AppState.costYuan = 0;
      AppState.callCount = 0;
      AppState.overBudget = false;
      AppState.toolSteps = [];
      CostRibbon.used = 0;
      CostRibbon.segments = 0;
      ToolStepRail.steps = [];
      /* 运行时对话回声的计数与跟随标志必须一起归零：
         否则重置后 ChatStream.rounds 仍是上一轮的 4，跟随逻辑会一直走"用户可能在看历史"的分支。 */
      ChatStream.rounds = 0;
      ChatStream.autoFollow = true;
      var dock = $('#glass-ribbon'); if (dock) dock.setAttribute('data-over-budget', 'false');
      $$('.ribbon-tick').forEach(function (t) { t.classList.remove('is-lit'); });
      var track = $('#chainTrack'); if (track) track.textContent = '';
      var sheetTrack = $('#sheetChain'); if (sheetTrack) sheetTrack.textContent = '';
      var chatTrack = $('#chatTrack'); if (chatTrack) chatTrack.textContent = '';
      var send = $('#sendBtn');
      if (send) {
        send.disabled = false;
        send.removeAttribute('aria-disabled');
        send.textContent = '发出指令';
      }
      var badge = $('#contractBadge');
      if (badge) {
        var s = document.createElement('span'); s.className = 'shape'; s.textContent = '●';
        var t = document.createElement('span'); t.textContent = '契约零漂移';
        badge.textContent = ''; badge.appendChild(s); badge.appendChild(t);
      }
      CostRibbon.setRatio(0);
      CostRibbon.render();
      EmptyStateController.sync();
      Toast.show('已重置本次会话 · 光带回到起点', 'ok');
    },
    render: function () {
      var cost = $('#costValue');
      if (cost) cost.textContent = fmtCny(AppState.costYuan);
      var tok = $('#tokenValue');
      if (tok) tok.textContent = fmtTok(AppState.tokens) + ' tok';
      var sheetCost = $('#sheetCost');
      if (sheetCost) sheetCost.textContent = fmtCny(AppState.costYuan) + ' / ' + fmtCny(AppState.budgetYuan);
      var sheetTokens = $('#sheetTokens');
      if (sheetTokens) sheetTokens.textContent = fmtTok(AppState.tokens) + ' tok';
      var sheetCalls = $('#sheetCalls');
      if (sheetCalls) sheetCalls.textContent = AppState.callCount + ' 次调用';
      var obsCalls = $('#observerCalls');
      if (obsCalls) obsCalls.textContent = String(AppState.callCount);
      if (CostRibbon.ribbon) {
        CostRibbon.ribbon.setAttribute('aria-label',
          '成本光带：已用 ' + fmtCny(AppState.costYuan) + '，预算 ' + fmtCny(AppState.budgetYuan));
      }
    }
  };

  /* ======================================================================
     §11 ToolStepRail：queue -> run -> ok/err 流转；每个状态形状+中文+语义色
     ====================================================================== */
  var ToolStepRail = {
    steps: [],
    seq: 0,
    init: function () { ToolStepRail.steps = []; },
    makeNode: function (state, shape, label, meta) {
      var node = document.createElement('div');
      node.className = 'tool-step-node';
      node.setAttribute('data-state', state);
      var s = document.createElement('span'); s.className = 'shape'; s.textContent = shape;
      var l = document.createElement('span'); l.textContent = label;
      var m = document.createElement('span'); m.className = 'tool-step-meta'; m.textContent = meta;
      node.appendChild(s); node.appendChild(l); node.appendChild(m);
      return node;
    },
    add: function (step) {
      ToolStepRail.steps.push(step);
      AppState.toolSteps.push(step);
      var rail = document.createElement('div');
      rail.className = 'tool-step-rail';
      rail.setAttribute('data-step-id', step.id);
      rail.setAttribute('aria-label', '工具调用 ' + step.name);
      rail.appendChild(ToolStepRail.makeNode('queue', '○', '排队', '0ms'));
      rail.appendChild(ToolStepRail.makeNode('queue', '◐', '运行', '—'));
      rail.appendChild(ToolStepRail.makeNode('queue', '●', '完成', '—'));
      rail.appendChild(ToolStepRail.makeNode('queue', '⊘', '失败', '—'));
      var track = $('#chatTrack');
      if (track) track.appendChild(rail);
      var head = document.createElement('div');
      head.className = 'mini-note';
      head.textContent = step.name + ' · 工具调用步骤条';
      /* 运行时新增的步骤条打同一枚标记，供 ChatStream / trim 逐组回收。
         静态示例的步骤条没有这枚标记，任何一次回收都碰不到它。 */
      rail.setAttribute('data-runtime-step', '1');
      head.setAttribute('data-runtime-step', '1');
      head.setAttribute('data-step-owner', step.id);
      if (track) track.insertBefore(head, rail);
      ToolStepRail.trim(track);
      return rail;
    },
    /* 运行时长限制（审计补充项）：只裁**运行时**新增的步骤条，保留最近 6 组。
       不裁的话 #chatTrack 会随每次提交无限变长，回看成本高于收益。 */
    trim: function (track) {
      if (!track) return;
      var rails = $$('.tool-step-rail[data-runtime-step="1"]', track);
      var MAX = 6;
      if (rails.length > MAX) {
        rails.slice(0, rails.length - MAX).forEach(function (rail) {
          var owner = rail.getAttribute('data-step-id');
          var head = $('.mini-note[data-step-owner="' + owner + '"]', track);
          if (head) head.remove();
          rail.remove();
        });
      }
    },
    setState: function (id, s) {
      var step = ToolStepRail.steps.filter(function (x) { return x.id === id; })[0];
      if (!step) return;
      step.state = s;
      var rail = $('[data-step-id="' + id + '"]');
      if (!rail) return;
      var nodes = $$('.tool-step-node', rail);
      if (s === 'queue') {
        ToolStepRail.decorate(nodes[0], 'queue', '○', '排队', '0ms');
      } else if (s === 'run') {
        ToolStepRail.decorate(nodes[0], 'ok', '●', '排队', '0ms');
        ToolStepRail.decorate(nodes[1], 'run', '◐', '运行中', '1.2s');
      } else if (s === 'ok') {
        ToolStepRail.decorate(nodes[0], 'ok', '●', '排队', '0ms');
        ToolStepRail.decorate(nodes[1], 'ok', '●', '运行', '1.2s');
        ToolStepRail.decorate(nodes[2], 'ok', '●', '已完成', step.elapsedMs + 'ms');
      } else if (s === 'err') {
        ToolStepRail.decorate(nodes[0], 'ok', '●', '排队', '0ms');
        ToolStepRail.decorate(nodes[3], 'err', '⊘', '已拒绝', '—');
        var note = document.createElement('div');
        note.className = 'notice';
        var sh = document.createElement('span'); sh.className = 'shape'; sh.textContent = '⊘';
        var tx = document.createElement('span');
        tx.textContent = '已拒绝 · 只读模式下破坏性指令不可执行，未产生任何费用。';
        note.appendChild(sh); note.appendChild(tx);
        rail.appendChild(note);
      }
    },
    decorate: function (node, state, shape, label, meta) {
      if (!node) return;
      node.setAttribute('data-state', state);
      var spans = $$('span', node);
      if (spans[0]) spans[0].textContent = shape;
      if (spans[1]) spans[1].textContent = label;
      if (spans[2]) spans[2].textContent = meta;
    },
    expand: function (id) {
      var rail = $('[data-step-id="' + id + '"]');
      if (!rail) return;
      var existing = $('.step-drawer', rail.parentNode);
      if (existing) { existing.remove(); return; }
      var drawer = document.createElement('div');
      drawer.className = 'step-drawer overlay';
      var txt = document.createElement('p');
      txt.className = 'mini-note';
      txt.textContent = '调用 ' + id + ' · payload 已折叠，详情落在实心抽屉中（零 blur）。';
      drawer.appendChild(txt);
      rail.parentNode.insertBefore(drawer, rail.nextSibling);
    }
  };

  /* ======================================================================
     §11 LayerFocus：浮层的焦点进出（R73-F）

     改前实测（审计 I10/I11/I13）：`#detailDrawer` / `#viewDrawer` / `#mobileSheet`
     打开后 activeElement 仍停在触发按钮上，Tab 可以直接穿到背后的页面里。
     其中两个还标着 `aria-modal="true"` —— 那是给屏幕阅读器的承诺，做不到就是谎报。

     做法：进入时记下触发点并把焦点送进去，离开时原路归还；
     Tab 在最上层浮层内循环（trapTab）。窗口 resize 导致浮层自然消失时，
     归还目标若已不可见就退回上一层浮层或 body，不会把焦点丢在 display:none 里。
     ====================================================================== */
  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),'
    + 'select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  var LayerFocus = {
    stack: [],
    isVisible: function (el) {
      return !!el && !el.hidden && el.getClientRects().length > 0;
    },
    enter: function (el) {
      if (!el) return;
      /* R77-U16 · 幂等。改前每调一次 enter 就 push 一条记录，而三条打开路径
         （#viewDrawerBtn 连点、#mobileSheetHandle 在已开状态下再点、
         #detailDrawer 的 hidden 判定被中途改写）都可能**在未 leave 的情况下重入**。
         后果不是立刻可见的，是退出时才炸：
           栈顶那条的 trigger 是"浮层里的第一个可聚焦元素"（因为第二次 enter 时
           activeElement 已经在浮层内），leave 时把焦点"归还"到浮层自己的子节点上，
           而浮层随即 hidden —— 焦点落进 display:none，键盘用户直接从页面消失。
         已在栈中的元素不重复入栈，也不覆盖原始 trigger（那是唯一正确的归还目标）。 */
      for (var i = 0; i < LayerFocus.stack.length; i += 1) {
        if (LayerFocus.stack[i].el === el) return;
      }
      LayerFocus.stack.push({ el: el, trigger: document.activeElement });
      window.requestAnimationFrame(function () {
        if (!LayerFocus.isVisible(el)) return;
        /* 已在浮层内就不要把焦点抢回第一个 —— 重入时用户可能已经移到第三个控件 */
        if (el.contains(document.activeElement)) return;
        var first = $(FOCUSABLE, el);
        if (first) first.focus();
        else { el.setAttribute('tabindex', '-1'); el.focus(); }
      });
    },
    leave: function (el) {
      if (!el) return;
      var rec = null;
      for (var i = LayerFocus.stack.length - 1; i >= 0; i -= 1) {
        if (LayerFocus.stack[i].el === el) { rec = LayerFocus.stack.splice(i, 1)[0]; break; }
      }
      var back = rec && rec.trigger;
      if (back && document.contains(back) && back.focus && back.getClientRects().length) { back.focus(); return; }
      var below = LayerFocus.top();
      var f = below ? $(FOCUSABLE, below) : null;
      if (f) f.focus();
    },
    top: function () {
      for (var i = LayerFocus.stack.length - 1; i >= 0; i -= 1) {
        var el = LayerFocus.stack[i].el;
        if (LayerFocus.isVisible(el)) return el;
      }
      return null;
    },
    /* Tab 不得穿透最上层浮层。首尾循环，中间一律放行给浏览器。 */
    trapTab: function (e) {
      var el = LayerFocus.top();
      if (!el) return false;
      var items = $$(FOCUSABLE, el).filter(LayerFocus.isVisible);
      if (!items.length) return false;
      var first = items[0], last = items[items.length - 1];
      var active = document.activeElement;
      if (!el.contains(active)) { e.preventDefault(); first.focus(); return true; }
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); return true; }
      if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); return true; }
      return false;
    }
  };

  /* ======================================================================
     §11b TabRoving：role=tablist 的键盘可达（R77-H23）

     改前实测（qa/r77/_h23-focus.mjs 的 P3a / P3b，9 板块横切）：
       两组 [role="tablist"]（能力分页 3 个 + 结果视图 3 个）共 6 个 button
       **一个 tabindex 都没有**，ArrowRight 按下后 aria-selected 逐字不变
       （G0 true,false,false → true,false,false；G1 同）。后果是两层：
         ① 键盘用户要按 6 次 Tab 才能穿过两组"只切内容"的按钮；
         ② 聚焦到某个 tab 之后，除了 Tab 走开没有第二个选择 ——
            想切到"另一个"，只能 Shift+Tab 绕回去再点，这组控件对键盘是半残的。

     做法（APG automatic activation，切页成本近乎为零所以不设"先移动后激活"）：
       · **roving tabindex** —— 选中的那个是 0，其余一律 -1，整组只占一个 Tab 位；
       · ←/→/↑/↓ 循环，Home / End 跳首尾，移动即激活；
       · **不复制状态管理** —— 方向键只对目标 tab 派发 click，
         aria-selected 与面板切换仍由**原有的 click 处理器**完成（单一事实源）；
         click 冒泡到 tablist 之后再 sync 一次 tabindex。
       这样即使别的代码改了 aria-selected（ResView.select 直接写属性），
       tabindex 也会在下一次 click / 方向键时收敛回正确值。
     ====================================================================== */
  var TabRoving = {
    init: function () {
      $$('[role="tablist"]').forEach(function (list) {
        TabRoving.sync(list);
        list.addEventListener('click', function () { TabRoving.sync(list); });
        list.addEventListener('keydown', function (e) {
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          var tabs = TabRoving.tabs(list);
          if (!tabs.length) return;
          var cur = tabs.indexOf(document.activeElement);
          if (cur < 0) {
            for (var i = 0; i < tabs.length; i += 1) {
              if (tabs[i].getAttribute('aria-selected') === 'true') { cur = i; break; }
            }
          }
          if (cur < 0) cur = 0;
          var next = -1;
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (cur + 1) % tabs.length;
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (cur - 1 + tabs.length) % tabs.length;
          else if (e.key === 'Home') next = 0;
          else if (e.key === 'End') next = tabs.length - 1;
          else return;
          e.preventDefault();
          tabs[next].focus();
          tabs[next].click();
          TabRoving.sync(list);
        });
      });
    },
    tabs: function (list) { return $$('[role="tab"]', list); },
    sync: function (list) {
      var tabs = TabRoving.tabs(list);
      if (!tabs.length) return;
      var sel = -1;
      for (var i = 0; i < tabs.length; i += 1) {
        if (tabs[i].getAttribute('aria-selected') === 'true') sel = i;
      }
      if (sel < 0) sel = 0;
      for (var j = 0; j < tabs.length; j += 1) {
        tabs[j].setAttribute('tabindex', j === sel ? '0' : '-1');
      }
    }
  };

  /* ======================================================================
     §11c RowName：被省略号截断的会话名要有第二条读法（R77-H24）

     承接视图层的 `.row-name { text-overflow: ellipsis }`。视图层已经在 <=767
     允许折两行（styles/views.css 末段），但两行仍装不下的名字只留下一个"…"。
     `ellipsis` 只是**暗示**"后面还有"，它不是**通路**。这里补 title：
       · 不补 aria-label —— DOM 里的文本本来就是完整的，视觉裁切不影响读屏，
         再叠一个 aria-label 反而多出一份可能与 DOM 失同步的副本；
       · 已存在 title 的不覆盖（作者写的值优先，可能是更精确的说明）。
     ====================================================================== */
  var RowName = {
    init: function () {
      $$('.session-row .row-name').forEach(function (el) {
        if (el.getAttribute('title')) return;
        var full = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (full) el.setAttribute('title', full);
      });
    }
  };

  /* ======================================================================
     §11d BoardActions：expert / collaboration 两个板块的动作入口（R77-H27）

     改前实测（R77-STATE-MATRIX.md）：这两块的可交互元素数 = 0。
     6 个交互态没有落点，Tab 整段跳过 —— 一个"能看不能动"的板块，
     对键盘和读屏用户等于不存在。

     ★ 纪律：这里只做**真实联动**，不做"点了弹个 toast 就完事"的空壳。
       每个动作都改页面上的真实读数（校验灯、拓扑连线、节点文字），
       用户能看见结果；toast 只是补充说明，不是结果本身。
       所有文本走 textContent / setAttribute，不碰 innerHTML。
     ====================================================================== */
  var BoardActions = {
    init: function () {
      var revalidate = $('#expertRevalidate');
      if (revalidate) {
        revalidate.addEventListener('click', function () {
          var lamps = $$('.import-validation-grid .validation-lamp');
          var fixed = 0;
          lamps.forEach(function (lamp) {
            if (lamp.getAttribute('data-state') === 'ok') return;
            lamp.setAttribute('data-state', 'ok');
            var shape = lamp.querySelector('.shape');
            var text = lamp.querySelector('span:last-child');
            if (shape) shape.textContent = '●';
            if (text) {
              text.textContent = text.textContent.replace(/·\s*失败$/, '· 通过');
            }
            fixed += 1;
          });
          var notice = $('[data-view-panel="expert"] .notice');
          if (notice) {
            notice.setAttribute('data-ui-state', 'ok');
            notice.classList.remove('notice--warn');
            notice.classList.add('notice--ok');
            var ns = notice.querySelector('.shape');
            var nt = notice.querySelector('span:last-child');
            if (ns) ns.textContent = '●';
            if (nt) nt.textContent = '校验通过：4 格全部达标，' + fixed + ' 项失败已修正，可以导入。';
          }
          Toast.show(fixed > 0 ? '重新校验完成 · ' + fixed + ' 项转为通过' : '全部已通过 · 无需修正', fixed > 0 ? 'ok' : 'warn');
        });
      }

      var importBtn = $('#expertImport');
      if (importBtn) {
        importBtn.addEventListener('click', function () {
          Toast.show('导入面板：请选择 .expert 包（本原型不落盘，仅演示入口）', 'ok');
        });
      }

      var logBtn = $('#expertLog');
      if (logBtn) {
        logBtn.addEventListener('click', function () {
          var failed = $$('.import-validation-grid .validation-lamp')
            .filter(function (l) { return l.getAttribute('data-state') !== 'ok'; });
          if (!failed.length) { Toast.show('校验日志：无失败项', 'ok'); return; }
          var name = (failed[0].textContent || '').replace(/\s+/g, ' ').trim();
          Toast.show('校验日志 · ' + name + ' · 错误码 E-422', 'err');
        });
      }

      var reconnect = $('#collabReconnect');
      if (reconnect) {
        reconnect.addEventListener('click', function () {
          var broken = $$('.endpoint-graph .e-link.is-err');
          if (!broken.length) { Toast.show('链路已全部连通 · 无需重连', 'ok'); return; }
          broken.forEach(function (l) { l.classList.remove('is-err'); });
          $$('.endpoint-graph .e-node.is-warn').forEach(function (n) { n.classList.remove('is-warn'); });
          $$('.endpoint-graph .e-label').forEach(function (t) {
            if (t.textContent.trim() === '断开') t.textContent = '已连';
          });
          var bar = $('[data-view-panel="collaboration"] .run-bar span:first-child');
          if (bar) bar.textContent = '运行状态 · 链路已恢复';
          Toast.show('已重连 · ' + broken.length + ' 条断开链路恢复', 'ok');
        });
      }

      var copyBtn = $('#collabCopyEndpoint');
      if (copyBtn) {
        copyBtn.addEventListener('click', function () {
          var input = $('#setEndpoint');
          var text = input && input.value ? input.value : '127.0.0.1:8765/v1';
          Clipboard.write(text).then(function () {
            Toast.show('已复制端点 · ' + text, 'ok');
          }, function () {
            /* 失败就说失败，不回落到"假装成功" */
            Toast.show('浏览器拒绝了剪贴板访问 · 请手动选择复制', 'err');
          });
        });
      }

      var ping = $('#collabPing');
      if (ping) {
        ping.addEventListener('click', function () {
          var total = $$('.endpoint-graph .e-node').length;
          var down = $$('.endpoint-graph .e-link.is-err').length;
          Toast.show('连通性测试 · ' + total + ' 个端点 · ' + (down ? down + ' 条链路断开' : '全部可达'), down ? 'warn' : 'ok');
        });
      }
    }
  };

  /* ======================================================================
     §11 ChatStream：运行时对话回声（R73-F）

     实测缺陷（`qa/_interaction-audit.mjs` 的 I01/I02，改前 2/13）：
     `submitInstruction` 只往工具链追加步骤条，textarea 清空后**画面上不留任何痕迹**。
     用户既看不到自己说过什么，也看不到系统回了什么 —— 一次"发出指令"在视觉上
     等于"文字被吞掉 + 右下角多了几条横杠"。这是本轮修的第一顺位。

     本模块只做三件事：落地一条气泡、把视口跟到新内容、限制运行时长。
     文本一律 `textContent`，不做任何 HTML 解析 —— 用户输入永远不能变成标记。
     ====================================================================== */
  var ChatStream = {
    track: null,
    rounds: 0,
    MAX_ROUNDS: 12,
    /* 跟随标志。**不能用 scrollTop 的位置来判断"用户在不在底部"**：
       平滑滚动期间 scrollTop 停在中间值，第二次 push 时会被误判成"用户滚上去了"，
       于是跟到一半就不再跟（审计 I07 实测 scrollTop=459 / 余量 1628）。
       改为事件驱动：只有 wheel / touchmove / 翻页键才算"用户主动滚动"，
       程序滚动不触发这些事件，因此不会被自己误伤；滚回底部附近时重新接上。 */
    autoFollow: true,
    init: function () {
      ChatStream.track = $('#chatTrack');
      var root = $('[data-scroll-root]');
      if (!root) return;
      var release = function () { ChatStream.autoFollow = false; };
      root.addEventListener('wheel', release, { passive: true });
      root.addEventListener('touchmove', release, { passive: true });
      root.addEventListener('keydown', function (e) {
        if (/^(PageUp|PageDown|Home|End|ArrowUp|ArrowDown|ArrowLeft|ArrowRight| )$/.test(e.key)) release();
      });
      root.addEventListener('scroll', function () {
        var room = root.scrollHeight - root.clientHeight;
        if (room <= 1 || root.scrollTop >= room - 60) ChatStream.autoFollow = true;
      }, { passive: true });
    },
    hhmmss: function () {
      var d = new Date();
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    },
    push: function (role, text, meta) {
      var track = ChatStream.track || $('#chatTrack');
      if (!track) return null;
      var art = document.createElement('article');
      art.className = 'msg msg--' + role;
      art.setAttribute('data-runtime-msg', '1');
      var body = document.createElement('span');
      body.className = 'msg-body';
      body.textContent = text;
      art.appendChild(body);
      var m = document.createElement('div');
      m.className = 'msg-meta';
      /* R77-U26 · `<time>` 必须有 `datetime`。
         改前只在文本里写 `09:41:02`，机器读到的是一串无年份无时区的字符 ——
         屏幕阅读器会逐字念"零九四一零二"，而 `<time datetime>` 能读成"9 时 41 分"。
         `title` 给鼠标用户完整日期（演示里可能跨午夜，只看到时分秒会误判顺序）。
         文本仍保持 hh:mm:ss —— 判据与既有截图都依赖这个格式，不改。 */
      var now = new Date();
      var t = document.createElement('time');
      t.setAttribute('datetime', now.toISOString());
      t.setAttribute('title', now.toLocaleString());
      t.textContent = ChatStream.hhmmss();
      m.appendChild(t);
      (meta || []).forEach(function (s) {
        var sp = document.createElement('span');
        sp.textContent = s;
        m.appendChild(sp);
      });
      art.appendChild(m);
      track.appendChild(art);
      if (role === 'user') ChatStream.rounds += 1;
      ChatStream.trim();
      ChatStream.follow(art);
      /* R77-01 修复（联动级缺陷）：消息上屏后必须立即重算空态。
         原来只有 CostRibbon.tick()/reset() 会 sync；用户发出的第一条指令
         不推进成本时（回执/拦截路径），空态引导不会撤 ⇒ 「输入一条指令开始
         一次调用」与用户自己的消息同屏（audit A17 实测 guide=true 且 msgs=1）。 */
      EmptyStateController.sync();
      return art;
    },
    /* 只裁**运行时新增**的轮次：静态示例对话没有 data-runtime-msg，一条不动。
       MAX_ROUNDS 是**演示上限**，不是产品策略：设计稿没有虚拟滚动，
       不封顶的话 #chatTrack 会随每次提交无限变长。真实产线应按可视区回收。
       取 12 而非 4：4 轮就会让"聊到第五轮，第一轮消失"这种事发生在演示过程中。 */
    trim: function () {
      var track = ChatStream.track || $('#chatTrack');
      if (!track) return;
      var users = $$('[data-runtime-msg="1"].msg--user', track);
      if (users.length <= ChatStream.MAX_ROUNDS) return;
      users.slice(0, users.length - ChatStream.MAX_ROUNDS).forEach(function (u) {
        var next = u.nextElementSibling;
        if (next && next.classList.contains('msg--assistant') && next.getAttribute('data-runtime-msg')) next.remove();
        u.remove();
      });
    },
    /* 视口跟到新内容。跟随与否由 autoFollow 决定（见 init 的注释），
       不看 scrollTop 的瞬时位置 —— 平滑滚动的中间值会把"正在跟随"误判成"用户在回看"。 */
    follow: function (el) {
      var root = $('[data-scroll-root]');
      if (!root || !el) return;
      if (!ChatStream.autoFollow) return;
      if (root.scrollTo) root.scrollTo({ top: root.scrollHeight, behavior: 'smooth' });
      else root.scrollTop = root.scrollHeight;
    }
  };

  /* ======================================================================
     §11 ComposerBusy：提交期间的忙碌态（审计 I03/I04）

     两条约束必须同时成立：
       ① **忙碌是临时的**，超预算是**持久的** —— 叠加时以超预算为准，
          恢复时不许把「预算已用尽」改回可点（否则用户能绕过预算继续烧）。
       ② 不做静默丢弃。上一轮未收尾时的重复提交要给一句 Toast，
          静默丢弃与"点了没反应"在用户侧无法区分。
     ====================================================================== */
  var ComposerBusy = {
    on: false,
    set: function (v) {
      ComposerBusy.on = !!v;
      var send = $('#sendBtn');
      var composer = $('#composer');
      if (composer) composer.setAttribute('aria-busy', String(!!v));
      if (!send) return;
      if (v) {
        send.disabled = true;
        send.setAttribute('aria-disabled', 'true');
        send.textContent = '执行中…';
        send.setAttribute('data-ui-state', 'loading');
        return;
      }
      if (AppState.overBudget) {
        send.disabled = true;
        send.setAttribute('aria-disabled', 'true');
        send.textContent = '预算已用尽';
        send.removeAttribute('data-ui-state');
        return;
      }
      send.disabled = false;
      send.removeAttribute('aria-disabled');
      send.textContent = '发出指令';
      send.removeAttribute('data-ui-state');
    }
  };

  /* ======================================================================
     指令提交：只读拦截 + 工具调用链 + CostRibbon.tick 闭环
     ====================================================================== */
  function submitInstruction(text) {
    var value = String(text || '').trim();
    if (!value) { Toast.show('请先输入一条指令', 'warn'); return false; }

    /* 防重入（审计 I04）：上一轮未收尾时拒绝，并且**说清原因**。
       静默丢弃会让用户以为"点了没反应"—— 那正是本轮要修的病。 */
    if (ComposerBusy.on) { Toast.show('上一轮仍在执行 · 完成后可继续提交', 'warn'); return false; }

    var cost = Math.max(1, Math.round(value.length * 1.4));

    if (AppState.readOnly && DESTRUCTIVE.test(value)) {
      ChatStream.push('user', value, ['约 ' + cost + ' tok']);
      ToolStepRail.seq += 1;
      var guard = {
        id: 'guard-' + ToolStepRail.seq, name: 'guard_check', state: 'err',
        elapsedMs: 0, tokens: 0, cost: 0, payload: value
      };
      ToolStepRail.add(guard);
      ToolStepRail.setState(guard.id, 'err');
      /* 拦截必须有回执：否则用户只看到气泡消失 + 一条错误横幅，不知道"被谁拦的"。 */
      ChatStream.push('assistant',
        '已拒绝：「' + value.slice(0, 24) + (value.length > 24 ? '…' : '') +
        '」含破坏性动作，当前为只读密级，未执行、未产生费用。切换密级后可重试。',
        ['guard_check', '0 tok']);
      Toast.show('已拒绝 · 只读模式下破坏性指令不可执行', 'err');
      return false;                       /* 不推进成本：拦截无副作用 */
    }

    if (AppState.overBudget) { Toast.show('预算已用尽 · 生成动作已禁用', 'err'); return false; }

    ChatStream.push('user', value, ['约 ' + cost + ' tok']);
    ComposerBusy.set(true);

    var names = ['read_file', 'search_text', 'summarize'];
    var done = 0, sumTok = 0, sumCost = 0;
    names.forEach(function (name, i) {
      ToolStepRail.seq += 1;
      var step = {
        id: 'step-' + ToolStepRail.seq, name: name, state: 'queue',
        elapsedMs: 820 + i * 140, tokens: 120 * (i + 1), cost: 0.06 * (i + 1),
        payload: value
      };
      ToolStepRail.add(step);
      window.setTimeout(function () { ToolStepRail.setState(step.id, 'run'); }, 120 + i * 60);
      window.setTimeout(function () {
        ToolStepRail.setState(step.id, 'ok');
        CostRibbon.tick(step);      /* 唯一入口：一次 ok = 一格刻度 + 一次成本推进 */
        sumTok += step.tokens;
        sumCost += step.cost;
        done += 1;
        /* 一轮收尾才回执并解锁。逐条回执会造成"回了一堆碎句"的噪音。 */
        if (done === names.length) {
          ChatStream.push('assistant',
            '已执行 ' + names.length + ' 次工具调用（' + names.join(' / ') + '）：累计 ' +
            fmtTok(sumTok) + ' tok、' + fmtCny(sumCost) + '，成本光带前进 ' + names.length + ' 格。',
            ['共 ' + fmtTok(sumTok) + ' tok', fmtCny(sumCost)]);
          ComposerBusy.set(false);
        }
      }, 420 + i * 180);
    });
    Toast.show('已提交 · 3 次工具调用正在推进成本光带', 'ok');
    return true;
  }

  /* ======================================================================
     其余交互绑定（全部零颜色字面量、零外网）
     ====================================================================== */
  function bindControls() {
    var composer = $('#composer');
    var input = $('#userInput');
    if (composer) composer.addEventListener('submit', function (e) {
      e.preventDefault();
      /* 只有真正被受理才清空输入框：被拦截（只读/超预算/上一轮未完成）时
         保留原文，用户改一个字就能重试，不用重打一遍。 */
      var accepted = submitInstruction(input ? input.value : '');
      if (accepted && input) { input.value = ''; input.style.height = ''; }
    });

    /* 密级三重编码：三个模式按钮（观测窗里的只读开关 + 顶栏明暗旁无） */
    var clearanceSwitch = $('#clearanceSwitch');
    if (clearanceSwitch) clearanceSwitch.addEventListener('click', function () {
      ClearanceCodec.sync(AppState.clearance === 'full' ? 'read' : 'full');
      Toast.show('密级已切换为「' + ClearanceCodec.labelOf(AppState.clearance) + '」· 形状 / 文字 / 颜色同步');
    });
    /* 观测窗里的可见密级演示按钮：让三重编码同步可在真实点击下被验收 */
    var clearanceDemoBtn = $('#clearanceDemoBtn');
    if (clearanceDemoBtn) clearanceDemoBtn.addEventListener('click', function () {
      var order = ['read', 'full', 'chat'];
      var next = order[(order.indexOf(AppState.clearance) + 1) % order.length];
      ClearanceCodec.sync(next);
      Toast.show('密级已切换为「' + ClearanceCodec.labelOf(next) + '」· 形状 / 文字 / 颜色同步', 'ok');
    });

    var overBtn = $('#overBudgetBtn');
    if (overBtn) overBtn.addEventListener('click', function () { CostRibbon.forceOverBudget(); });
    var resetBtn = $('#resetBudgetBtn');
    if (resetBtn) resetBtn.addEventListener('click', function () { CostRibbon.reset(); });

    var observerToggle = $('#observerToggle');
    if (observerToggle) observerToggle.addEventListener('click', function () {
      var win = $('#observerWindow');
      var collapsed = win.classList.toggle('is-collapsed');
      observerToggle.setAttribute('aria-expanded', String(!collapsed));
      observerToggle.textContent = collapsed ? '展开' : '收起';
    });

    /* 375：板块抽屉 / 成本详情抽屉
       两个浮层都标着 aria-modal="true" —— 那是承诺，不是装饰：
       焦点必须进入、关闭必须归还、300ms 内重开不能被上一次的 timer 反手藏掉。 */
    var drawerBtn = $('#viewDrawerBtn');
    var drawer = $('#viewDrawer');
    var drawerTimer = 0;
    function openDrawer() {
      if (!drawer) return;
      window.clearTimeout(drawerTimer);
      drawer.hidden = false;
      window.requestAnimationFrame(function () { drawer.classList.add('is-open'); });
      if (drawerBtn) drawerBtn.setAttribute('aria-expanded', 'true');
      LayerFocus.enter(drawer);
    }
    function closeDrawer() {
      if (!drawer || drawer.hidden) return;
      drawer.classList.remove('is-open');
      if (drawerBtn) drawerBtn.setAttribute('aria-expanded', 'false');
      LayerFocus.leave(drawer);
      window.clearTimeout(drawerTimer);
      drawerTimer = window.setTimeout(function () {
        if (!drawer.classList.contains('is-open')) drawer.hidden = true;
      }, 300);
    }
    if (drawerBtn) drawerBtn.addEventListener('click', openDrawer);
    var drawerClose = $('#viewDrawerClose');
    if (drawerClose) drawerClose.addEventListener('click', closeDrawer);

    var sheet = $('#mobileSheet');
    var sheetHandle = $('#mobileSheetHandle');
    var sheetTimer = 0;
    function setSheet(open) {
      if (!sheet) return;
      window.clearTimeout(sheetTimer);
      if (open) sheet.hidden = false;
      window.requestAnimationFrame(function () { sheet.classList.toggle('is-open', open); });
      if (sheetHandle) sheetHandle.setAttribute('aria-expanded', String(open));
      if (open) {
        LayerFocus.enter(sheet);
      } else {
        LayerFocus.leave(sheet);
        sheetTimer = window.setTimeout(function () {
          if (!sheet.classList.contains('is-open')) sheet.hidden = true;
        }, 300);
      }
    }
    if (sheetHandle) sheetHandle.addEventListener('click', function () {
      setSheet(!sheet.classList.contains('is-open'));
    });
    var sheetClose = $('#mobileSheetClose');
    if (sheetClose) sheetClose.addEventListener('click', function () { setSheet(false); });

    /* 最近一次调用详情（实心抽屉）
       改前缺陷（审计 I11）：Escape 关闭只把 hidden 置 true，`aria-expanded` 仍是 "true"
       ⇒ 屏幕阅读器认为它一直开着。故所有关闭路径必须走同一个 closeDetail()。 */
    var detailBtn = $('#chainDetailBtn');
    var detail = $('#detailDrawer');
    function openDetail() {
      if (!detail) return;
      detail.hidden = false;
      if (detailBtn) detailBtn.setAttribute('aria-expanded', 'true');
      var last = AppState.toolSteps[AppState.toolSteps.length - 1];
      var txt = $('#detailText');
      if (txt) txt.textContent = last
        ? last.name + ' · ' + last.elapsedMs + 'ms · ' + last.tokens + ' tok · ● 已完成'
        : 'read_file · 12ms · 120 tok · ● 已完成';
      LayerFocus.enter(detail);
    }
    function closeDetail() {
      if (!detail || detail.hidden) return;
      detail.hidden = true;
      if (detailBtn) detailBtn.setAttribute('aria-expanded', 'false');
      LayerFocus.leave(detail);
    }
    if (detailBtn) detailBtn.addEventListener('click', function () {
      if (!detail) return;
      if (detail.hidden) openDetail(); else closeDetail();
    });
    var detailClose = $('#detailCloseBtn');
    if (detailClose) detailClose.addEventListener('click', closeDetail);

    /* 能力分页 / 设置分组 / 预设 / 检索源：只切 aria-*，颜色由 CSS 变量驱动 */
    $$('.capability-tabs button').forEach(function (tab) {
      tab.addEventListener('click', function () {
        $$('.capability-tabs button').forEach(function (b) { b.setAttribute('aria-selected', 'false'); });
        tab.setAttribute('aria-selected', 'true');
        var empty = $('#registryEmpty');
        var wrap = $('#registryWrap');
        var isEmpty = tab.getAttribute('data-cap') === 'prompts';
        if (empty) empty.hidden = !isEmpty;
        if (wrap) wrap.hidden = isEmpty;
      });
    });
    $$('.set-nav button').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('.set-nav button').forEach(function (x) { x.removeAttribute('aria-current'); });
        b.setAttribute('aria-current', 'true');
      });
    });
    $$('.preset-chip-row button').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('.preset-chip-row button').forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
        b.setAttribute('aria-pressed', 'true');
      });
    });
    $$('.well-source button').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('.well-source button').forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
        b.setAttribute('aria-pressed', 'true');
      });
    });

    /* 表单与按钮：真实反馈，避免「点了没反应」 */
    var revealKeyBtn = $('#revealKeyBtn');
    if (revealKeyBtn) revealKeyBtn.addEventListener('click', function () {
      var key = $('#setKey');
      var show = key.getAttribute('type') === 'password';
      key.setAttribute('type', show ? 'text' : 'password');
      revealKeyBtn.setAttribute('aria-pressed', String(show));
      revealKeyBtn.textContent = show ? '隐藏' : '显示';
    });
    var testConnBtn = $('#testConnBtn');
    if (testConnBtn) testConnBtn.addEventListener('click', function () {
      StateMachine.apply(testConnBtn, 'loading');
      window.setTimeout(function () {
        StateMachine.apply(testConnBtn, 'default');
        testConnBtn.textContent = '测试连接';
        Toast.show('连接测试完成 · 127.0.0.1:8765 可达', 'ok');
      }, 900);
    });
    var saveBtn = $('#saveBtn');
    if (saveBtn) saveBtn.addEventListener('click', function () { Toast.show('设置已保存（设计稿示意，不写入磁盘）', 'ok'); });
    var resetFormBtn = $('#resetBtn');
    if (resetFormBtn) resetFormBtn.addEventListener('click', function () { Toast.show('重置需要二次确认 · 设计稿不执行破坏性操作', 'warn'); });
    var approveBtn = $('#approveBtn');
    if (approveBtn) approveBtn.addEventListener('click', function () { Toast.show('检查点已批准 · 后续步骤解除灰化', 'ok'); });
    var rejectBtn = $('#rejectBtn');
    if (rejectBtn) rejectBtn.addEventListener('click', function () { Toast.show('检查点已驳回 · 计划停在闸门处', 'warn'); });
    var memorySearchBtn = $('#memorySearchBtn');
    if (memorySearchBtn) memorySearchBtn.addEventListener('click', function () { Toast.show('检索完成 · 命中 4 条，按权重降序', 'ok'); });
    $$('[data-copy]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var target = document.getElementById(btn.getAttribute('data-copy'));
        var text = target ? target.textContent : '';
        if (!text || !text.trim()) { Toast.show('没有可复制的内容', 'warn'); return; }
        var idle = btn.textContent;
        Clipboard.write(text).then(function () {
          Toast.show('已复制代码块内容', 'ok');
          /* 按钮自身的短时回执：光标已经离开按钮去看别处时，Toast 会消失，
             按钮上的"已复制"是他回头确认的唯一线索。1600ms 后还原。 */
          btn.textContent = '已复制';
          btn.setAttribute('data-copied', 'true');
          window.setTimeout(function () {
            if (btn.textContent === '已复制') btn.textContent = idle;
            btn.removeAttribute('data-copied');
          }, 1600);
        }, function () {
          Toast.show('复制失败 · 请手动选中后 Ctrl+C', 'warn');
        });
      });
    });
    $$('.aside-toggle').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var aside = $('.stage-aside', $('#mainStage'));
        if (aside) aside.classList.toggle('is-open');
      });
    });

    /* 会话过滤 = 检索词 × 范围（全部 / 任务 / 项目空间）。
       R75：原来只有检索一个条件，任务会话与项目空间入口混排，无法只看某一类。
       两个条件必须走同一个函数 —— 否则会出现「筛了类型再搜词，分组带计数不跟」的旧病
       （I09 当初修的正是"只隐藏行、分组带还挂着 3 条"）。 */
    var sessionSearch = $('#sessionSearch');
    var sessionScopeEl = $('#sessionScope');
    var sessionKind = 'all';

    function applySessionFilter() {
      var frame = $('.sessions-frame');
      if (!frame) return;
      var q = sessionSearch ? sessionSearch.value.trim() : '';
      var rows = $$('.session-row', frame);
      var visible = 0;
      rows.forEach(function (row) {
        var kindOk = sessionKind === 'all' || row.getAttribute('data-kind') === sessionKind;
        var qOk = q === '' || row.textContent.indexOf(q) >= 0;
        var hit = kindOk && qOk;
        row.hidden = !hit;
        if (hit) visible += 1;
      });
      /* 分组带随组内可见行数收起：只剩标题没有内容的组比"少一行"更让人困惑 */
      $$('.group-band', frame).forEach(function (band) {
        var any = false;
        var n = band.nextElementSibling;
        while (n && !n.classList.contains('group-band')) {
          if (n.classList.contains('session-row') && !n.hidden) { any = true; break; }
          n = n.nextElementSibling;
        }
        band.hidden = !any;
      });
      var hint = $('#sessionSearchEmpty');
      if (!hint) {
        hint = document.createElement('p');
        hint.className = 'mini-note';
        hint.id = 'sessionSearchEmpty';
        hint.setAttribute('data-search-empty', '1');
        hint.setAttribute('role', 'status');   /* 屏幕阅读器也要听到"没找到" */
        hint.hidden = true;
        var anchor = sessionScopeEl ? sessionScopeEl.nextSibling
          : (sessionSearch ? sessionSearch.nextSibling : null);
        if (anchor) frame.insertBefore(hint, anchor);
        else frame.appendChild(hint);
      }
      hint.hidden = visible > 0;
      hint.textContent = visible > 0 ? ''
        : '没有找到匹配的会话：换个关键词、把范围切回「全部」，或清空检索框看全部 ' + rows.length + ' 条。';
    }

    if (sessionSearch) sessionSearch.addEventListener('input', applySessionFilter);
    if (sessionScopeEl) sessionScopeEl.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-scope]');
      if (!btn) return;
      sessionKind = btn.getAttribute('data-scope');
      $$('button[data-scope]', sessionScopeEl).forEach(function (b) {
        b.setAttribute('aria-pressed', String(b === btn));
      });
      applySessionFilter();
    });

    /* 全局检索：不发起网络请求，只给反馈。
       R77-U11：**必须挡掉输入法确认键**。中文用户敲「计划」，拼音未上屏时
       Enter 是"选第一个候选词"，若不判 isComposing，会先把半截拼音当成一次检索提交，
       用户看到一条"全局检索：ji"的 Toast，而输入框里刚打的字被自己吃掉了。 */
    var globalSearch = $('#globalSearch');
    if (globalSearch) globalSearch.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || isImeConfirm(e)) return;
      e.preventDefault();
      Toast.show('全局检索：' + (globalSearch.value || '（空）'), 'ok');
    });

    /* 键盘 1-9 快速切板块。
       改前缺陷（审计 I08）：只排除了 input/textarea/select，**没有排除聚焦在按钮上的情况**
       —— 键盘用户在右栏标签上按 6，板块被抢走且毫无提示。
       现在：焦点落在任何可操作元素上时不劫持；真正切换了才给一句 Toast，
       否则"按了数字，画面变了，但不知道变到哪个板块"（数字键没有可见的对应物）。 */
    var INTERACTIVE = 'button, a[href], input, textarea, select, summary, label,'
      + '[contenteditable=""], [contenteditable="true"], [role="tab"], [role="button"],'
      + '[role="switch"], [role="checkbox"], [role="radio"], [role="textbox"], [role="combobox"],'
      + '[role="slider"], [role="menuitem"]';

    document.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target;
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
      if (t && t.closest && t.closest(INTERACTIVE)) return;
      var n = parseInt(e.key, 10);
      if (!(n >= 1 && n <= 9)) return;
      var view = VIEWS[n - 1];
      if (AppState.currentView === view) return;
      ViewRouter.switchTo(view);
      var navBtn = $('.view-nav [data-view="' + view + '"]');
      Toast.show('板块 ' + n + ' · ' + (navBtn ? navBtn.textContent.trim() : view), 'ok');
    });

    /* R77-U06 快捷键补全（**只补缺口，不重造已有**）。
       ★ 撤回记录：首版这里也注册了 Ctrl/Cmd+K，而"工作台快捷键（P1）"段已有同一语义
         ⇒ 一次按键触发两次 focus。虽然幂等、肉眼不可见，但它是教科书式的
         "同一语义两处注册"缺陷，会在键盘事件计数、e.preventDefault 顺序上留下隐患。
         现在这里只保留 Ctrl+K 之外的键；Ctrl+K / Ctrl+B / Ctrl+Shift+E 归 P1 段独占。
       · `/`    → 聚焦输入（仅非输入态）
       · `?`    → 列快捷键（仅非输入态）
       两条都要求"不在输入框里"，因为在输入框里它们就是普通字符。 */
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') {
        var box = $('#userInput');
        if (box) { e.preventDefault(); box.focus(); }
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        Toast.show('1-9 切板块 · / 输入 · ^K 检索 · ^B 左栏 · Esc 关一层', 'ok');
      }
    });

    /* Escape：**不受输入框限制**，按层叠从上往下关一层。
       改前两处缺陷（审计 I11/I12）：
       ① 焦点在 textarea 里时 Esc 完全无效 —— 因为整个处理器被"输入框里不劫持"提前 return 了；
       ② 关 #detailDrawer 只改 hidden，不还原 aria-expanded，屏幕阅读器以为它还开着。
       一次只关一层，不做"全都关掉"：用户刚看完的那层上下文不该被一起收走。 */
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (detail && !detail.hidden) { closeDetail(); e.preventDefault(); return; }
      if (sheet && !sheet.hidden) { setSheet(false); e.preventDefault(); return; }
      if (drawer && !drawer.hidden) { closeDrawer(); e.preventDefault(); return; }
      if (ShellController.closeObserverSheet()) { e.preventDefault(); return; }
      var inp = $('#userInput');
      if (!inp || document.activeElement === inp) return;
      var loose = !e.target || e.target === document.body || e.target === document.documentElement;
      if (loose) { inp.focus(); e.preventDefault(); }   /* 无浮层可关时回到输入框 */
    });

    /* Tab 不得穿透最上层浮层（LayerFocus.trapTab 自带 preventDefault） */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') LayerFocus.trapTab(e);
    });

    /* Enter 发送 / Shift+Enter 换行（审计 I05）。
       两个细节不能省：
       ① `e.isComposing || keyCode === 229` —— 中文输入法用 Enter 确认候选词，
          不判组合态就会"选词时把半句话发出去"。这是中文环境下最常见的发送事故。
       ② 走 `composer.requestSubmit()` 而不是直接调 submitInstruction，
          让 form 的 submit 事件保持**唯一入口**（校验与副作用只在一处）。 */
    if (input && composer) {
      input.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' || e.shiftKey) return;
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        if (composer.requestSubmit) composer.requestSubmit();
        else composer.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      });
      /* 多行输入随内容增高（上限 160px），到顶后内部滚动。
         不设上限的话，长指令会把 composer 顶到盖住光带。 */
      input.addEventListener('input', function () {
        input.style.height = '';
        var h = input.scrollHeight;
        if (h > input.clientHeight) input.style.height = Math.min(h, 160) + 'px';
      });
    }

    /* 工作台快捷键（P1）：Ctrl/Cmd+K 聚焦全局检索、Ctrl/Cmd+B 切 L 栏、
       Ctrl/Cmd+Shift+E 切 R 栏。均只改视觉状态，不写存储。 */
    document.addEventListener('keydown', function (e) {
      if (!(e.ctrlKey || e.metaKey)) return;
      var key = String(e.key || '').toLowerCase();
      if (key === 'k') {
        e.preventDefault();
        var search = $('#globalSearch');
        if (search) search.focus();
        return;
      }
      if (key === 'b' && !e.shiftKey) { e.preventDefault(); ShellController.toggleRail(); return; }
      if (key === 'e' && e.shiftKey) { e.preventDefault(); ShellController.toggleResult(); }
    });
  }

  /* 375 档光井刻度「构成转置」的可测证据：CSS 负责形态，JS 登记方向 */
  function updateOrientation() {
    var ruler = $('#lightwellRuler');
    if (!ruler) return;
    ruler.setAttribute('data-orientation', window.innerWidth <= 767 ? 'horizontal' : 'vertical');
  }

  /* ======================================================================
     R77-U17 LayoutWatch：布局变化不该只靠 window.resize
     ----------------------------------------------------------------------------
     改前有三处各自监听 `window.resize`：
       ScrollAffordance.onResize（滚动提示）· NavEdge.onScroll（9 项顶栏溢出态）
       · bindOrientation（刻度方向）。
     三处共同的病：**窗口不动、布局会动**。
       · 收起左栏 `data-rail="off"` → 舞台宽度 +260px，但 window 宽度一点没变，
         于是滚动提示条还按旧宽度判断"能不能滚"，顶栏溢出态还停在 start，
         375 档刻度方向也不会跟着换；
       · 结果栏折叠同理（+320px）；
       · 展开/收起这些动作全部由本文件自己触发，可它们恰恰是最需要重算的时刻。
     做法：一个 ResizeObserver 盯住"真正会变宽的容器"（唯一滚动根 + 结果区 +
     外壳），变化时统一 rAF 合并成一次重算；`window.resize` 保留作为
     ResizeObserver 不可用时的兜底（老 Safari / 某些嵌入式 WebView）。
     **合并**很关键：拖动窗口时 resize 每像素都触发，而三个 handler 都要读
     getBoundingClientRect —— 不合并就是每帧三次强制同步布局。
     ====================================================================== */
  var LayoutWatch = {
    raf: 0,
    ro: null,
    ticks: 0,          /* 真实执行次数：A36 用它交叉校验"宽度变了是不是真重算了" */
    init: function () {
      var fire = function () {
        if (LayoutWatch.raf) return;
        LayoutWatch.raf = window.requestAnimationFrame(function () {
          LayoutWatch.raf = 0;
          LayoutWatch.ticks += 1;
          updateOrientation();
          if (ScrollAffordance && ScrollAffordance.onResize) ScrollAffordance.onResize();
          if (NavEdge && NavEdge.onScroll) NavEdge.onScroll();
        });
      };
      LayoutWatch.fire = fire;
      if (typeof ResizeObserver !== 'undefined') {
        LayoutWatch.ro = new ResizeObserver(fire);
        [$('[data-scroll-root]'), $('#observerWindow'), $('#appShell')].forEach(function (el) {
          if (el) LayoutWatch.ro.observe(el);
        });
        /* R77-H29 实测补漏：上面三个都是**容器**，切板块时它们的尺寸一分不变
           （容器固定，变的是里面的面板），所以 ResizeObserver 一次都不触发 ——
           实测连切 60 个板块，ticks 2 → 2，+0。
           功能上没坏，是因为 ViewRouter.switchTo 里另外手调了一次
           ScrollAffordance.sync()；但那就等于"观察器只有一半在工作"，
           任何**内容**引起的布局变化（长消息、展开详情、面板内数据替换）都不会重算。
           补观察 9 个面板与对话轨：display:none 的面板不触发，从 hidden 变可见时
           尺寸 0 → N，正好是切板块的那一刻。多次回调由同一个 raf 合并成一次。 */
        $$('[data-view-panel]').forEach(function (p) { LayoutWatch.ro.observe(p); });
        var track = $('#chatTrack');
        if (track) LayoutWatch.ro.observe(track);
      }
      window.addEventListener('resize', function () {
        /* R77-U17 修正：刻度方向**必须同步**更新。
           `window.resize` 的监听器是同步执行的，而 rAF 要等下一帧 ——
           判据 D02 在 setViewportSize 之后立刻读 data-orientation，
           走 rAF 就会稳定地读到上一档的方向（实测 375 下读到 vertical，
           4 条判据里翻红这一条）。写一个属性不触发重排，没有必要延后。
           其余两个 handler 要读 getBoundingClientRect，仍走合并后的 rAF。 */
        updateOrientation();
        fire();
      });
      fire();
    }
  };

  function bindOrientation() { updateOrientation(); }

  /* ======================================================================
     启动
     ====================================================================== */
  function boot() {
    Toast.init();
    ErrorBoundary.install();       /* R77-U18：异常必须有界面通道（依赖 Toast） */
    GlassLayer.mount('L1a', $('#glass-top'));
    GlassLayer.mount('L1b', $('#glass-ribbon'));
    OpticsClock.bind();            /* 环境循环宿主先绑定：FxController.init() 会立刻 sync */
    ThemeController.init();
    FxController.init();
    MotionOrchestrator.init();
    MagneticSheen.init();          /* A-04 磁吸高光（R84：指针管线已并入 optics.js，≥1024 生效） */
    NavEdge.init();                /* 768 顶栏溢出可发现性（data-nav-edge） */
    CapabilityGate.init();         /* R77-U18：只读态的破坏性动作总闸（capture） */
    LayoutWatch.init();            /* R77-U17：布局变化不只靠 window.resize */
    document.addEventListener('visibilitychange', function () { OpticsClock.sync(); });
    ToolStepRail.init();
    ChatStream.init();             /* 运行时对话回声：用户输入必须落在画面上 */
    CostRibbon.init();
    EmptyStateController.init();
    EmptyStateController.sync();   /* 初始有示例会话与成本 → 隐藏「尚未产生费用」断言 */
    ClearanceCodec.sync('read');
    ScrollAffordance.init();       /* 唯一滚动容器的可滚 / 到底状态 */
    ResView.init();                /* R 栏三视图 + 窄屏镜像 */
    TabRoving.init();              /* R77-H23：tablist 的 roving tabindex + 方向键 */
    RowName.init();                /* R77-H24：被省略号截断的会话名补 title */
    BoardActions.init();           /* R77-H27：expert / collaboration 的动作入口 */
    ShellController.init();        /* L / R 栏折叠 + 窄屏结果区 sheet */
    ViewRouter.init();
    TopbarContext.sync();
    bindControls();
    bindOrientation();

    /* 供 verify.mjs / QA 独立验收读取的只读调试接口（不写生产链、不发请求）
       R77-U29：接口升级到 __R77 并**保留 __R72 别名** ——
       验收脚本按 __R72 取数，改名会让 108 条判据在同一行全部变红；
       版本化的意义是让"新能力挂新命名空间"，而不是改旧的名字。 */
    window.__R77 = {
      version: 'r77',
      /* ---- 新增：可观测面 ---- */
      errors: ErrorBoundary.errors,
      snapshot: function () {
        return {
          version: 'r77',
          at: Date.now(),
          view: AppState.currentView,
          theme: AppState.theme,
          fx: AppState.fx,
          clearance: AppState.clearance,
          readOnly: AppState.readOnly,
          cost: AppState.costYuan,
          tokens: AppState.tokens,
          calls: AppState.callCount,
          overBudget: AppState.overBudget,
          litTicks: $$('.ribbon-tick.is-lit').length,
          chainNodes: $$('#chainTrack [data-node-state]').length,
          messages: $$('#chatTrack .msg').length,
          resTab: ResView.current,
          navEdge: ($('#appShell') || {}).getAttribute && $('#appShell').getAttribute('data-nav-edge'),
          layoutTicks: LayoutWatch.ticks
        };
      },
      /* ---- 与 R72 完全相同的既有字段（逐项转发，行为零变化） ---- */
      AppState: AppState,
      ViewRouter: ViewRouter,
      ThemeController: ThemeController,
      FxController: FxController,
      GlassLayer: GlassLayer,
      OpticsLens: OpticsLens,
      ToolStepRail: ToolStepRail,
      CostRibbon: CostRibbon,
      StateMachine: StateMachine,
      EmptyStateController: EmptyStateController,
      MotionOrchestrator: MotionOrchestrator,
      ClearanceCodec: ClearanceCodec,
      BoardPrototypes: BoardPrototypes,
      ScrollAffordance: ScrollAffordance,
      LayoutWatch: LayoutWatch,
      CapabilityGate: CapabilityGate,
      ShellController: ShellController,
      OpticsClock: OpticsClock,
      MagneticSheen: MagneticSheen,
      NavEdge: NavEdge,
      ResView: ResView,
      TopbarContext: TopbarContext,
      Toast: Toast,
      ChatStream: ChatStream,
      ComposerBusy: ComposerBusy,
      LayerFocus: LayerFocus,
      views: VIEWS,
      prototypes: PROTOTYPE,
      coverStates: function () { return StateMachine.coverageReport(); },
      /* R77-H25：把"样式表里到底有没有这条态规则"暴露成可证伪的探针。
         verify 用它做反向验证（虚构选择器必须命中 0 条），
         否则任何"记成 css 但其实没规则"的归因都无从发现。 */
      ruleCount: function (sel) { return StateMachine.ruleCount(sel); },
      stateEvidence: StateMachine.evidenceFor,
      submitInstruction: submitInstruction
    };
    /* 旧名保留为同一个对象：任何按 __R72 写的判据继续可用 */
    window.__R72 = window.__R77;
  }

  /* R84 · 探测改惰性（R79 原要求"首次绘制之前跑完，否则边缘亮带闪一下"）。
     该要求在 R80 已失去前提：views.css 删掉两条 `html[data-optics="displace"]` 规则后，
     全库已无选择器消费 html[data-optics]，位移图不参与任何首帧绘制 ⇒ 不存在"回落态跳位移态"的闪烁。
     现在 init() 只声明 data-optics="displace"，真实探测推迟到 __Optics.report() 首次调用。
     __Optics 单独挂在 window 上（而不是塞进 __R77）：它是 R79 新增的可观测面，
     与 R77 快照的字段无关，验收脚本按 __Optics.report() 逐项取证。 */
  try {
    OpticsLens.init();
  } catch (e) {
    /* 探测本身炸了也只能回落 —— 回落是安全方向，绝不因为探测失败而白屏 */
    document.documentElement.setAttribute('data-optics', 'blur');
  }
  window.__Optics = OpticsLens;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
