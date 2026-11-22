/**
 * LIGHTWELL R90 · 皮肤与工作台静态门禁（离线可跑，无浏览器依赖）
 *
 * 运行：node server/test/lightwell-skin-gate.mjs
 *
 * 设计原则（沿用本仓判据工程教训）：
 *   1. 每条断言都必须**可失败** —— 不允许 `includes(x) === true` 之类恒真式；
 *   2. 关键约束配反例意识：先确认"该出现的必须出现"，再确认"不该出现的一个都不许有"；
 *   3. 路径一律由 import.meta.url 派生，不依赖 cwd（否则从别处调用会静默跳过）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintLightwellSkinSpecificity } from '../../deliverables/design/liquid-glass/scripts/css-lint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ── R98 决策值（2026-11-18 产品裁定）──────────────────────────────────────────
 * 明档 opacity .62 / 暗档 opacity .65。
 * 纪律：这两个数**只在本行出现一次**，断言与变异一律引用常量，不许再写数值字面量
 * （`grep -c` 该数值的「带前导零写法」在全文应为 1 行，正好是下面那行常量）。
 * 调整流程：① 改这里的数值 → ② 在本注释补一行「YYYY-MM-DD 由 X 改为 Y，理由」→
 *          ③ 重跑本门禁与 qa/r98/probe-r98-wallpaper-lock.mjs（运行期计算值口径）。
 * 这样做的好处：误改会当场变红，有意调参只改一行、不会变成又一个 `.18/.12` 式硬钉。
 */
const R98_WP_OPACITY = { light: 0.62, dark: 0.65 };

/* ── R100 决策（原生实时透色门禁升级）──────────────────────────────────────────
 * 原生引擎（M3 起由原生侧把 `data-glass-engine="native"` 写到 <html>）接管模糊与壁纸后，
 * CSS 侧必须让位：模糊归零 + 静态壁纸隐藏 —— 否则与 D3D11 HLSL 叠成二次模糊（掉帧又糊），
 * 且静态壁纸会盖住真透色窗口。属性缺失（Win10 低版 / RDP / 无原生插件）时隔离层零命中，
 * 完整回退 R98 档，M1–M6 继续守卫壁纸层。
 * 纪律：判据一律引用下面两个常量，不写选择器字面量（同 R98_WP_OPACITY 的单点纪律）。
 */
const R100_NATIVE_ATTR = '[data-glass-engine="native"]';
const R100_HOSTS = ['header.header', '#mainStage', '#observerWindow', '#glass-ribbon'];

const responsiveCss = read('frontend/styles/responsive.css');
const templateHtml = read('frontend/index.template.html');
const shellJs = read('frontend/skin/lightwellShell.js');
const manifest = JSON.parse(read('frontend/manifest.json'));

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, msg: err.message });
  }
}

/* ── 1. 皮肤段选择器前缀（防被 island 注入样式压掉） ─────────────────────── */
check('皮肤段所有选择器带 [data-skin="lightwell"] 前缀', () => {
  const r = lintLightwellSkinSpecificity(responsiveCss);
  assert.ok(r.checkedSelectors > 0, '未识别到皮肤段（标记 LIGHTWELL R90 缺失）');
  assert.equal(r.violations.length, 0,
    `发现 ${r.violations.length} 条缺前缀选择器：${r.violations.join(' | ')}`);
  assert.ok(r.checkedSelectors >= 40,
    `皮肤段有效选择器仅 ${r.checkedSelectors} 条，疑似被截断`);
});

/* ── 2. 四宿主契约：恰好 4 个，且不是「5 个里挑 4 个」 ────────────────────── */
check('毛玻璃宿主恰好 4 个：header.header / #mainStage / #observerWindow / #glass-ribbon', () => {
  const re = /([^{}]+)\{[^{}]*backdrop-filter:\s*blur\(/g;
  const blocks = [];
  let m = re.exec(responsiveCss);
  while (m !== null) {
    blocks.push(m[1].split(',').map(s => s.trim()).filter(Boolean));
    m = re.exec(responsiveCss);
  }
  assert.equal(blocks.length, 1, `应只有 1 条 blur 规则块，实为 ${blocks.length} 条（嵌套模糊会掉帧）`);
  const sels = blocks[0];
  assert.equal(sels.length, 4, `宿主应恰好 4 个，实为 ${sels.length}：${sels.join(' | ')}`);
  for (const need of ['header.header', '#mainStage', '#observerWindow', '#glass-ribbon']) {
    assert.ok(sels.some(s => s.includes(need)), `宿主组缺少 ${need}`);
  }
});

check('禁止 .main 自身成为宿主（否则 header 被套进模糊容器 → 嵌套）', () => {
  const re = /([^{}]+)\{[^{}]*backdrop-filter:\s*blur\(/g;
  const m = re.exec(responsiveCss);
  const header = m ? m[1] : '';
  assert.ok(!/[^.#\w]\.main\s*,/.test(header) && !/\]\s+\.main\s*\{/.test(header),
    '.main 不得出现在宿主组');
});

check('宿主内部子元素统一禁模糊（不嵌套）', () => {
  assert.ok(/html\[data-skin="lightwell"\]\s+#mainStage\s+\*[\s\S]{0,400}?backdrop-filter:\s*none/
    .test(responsiveCss), '缺少「宿主内部禁 backdrop-filter」规则');
});

/* ── 3. 死选择器黑名单（照抄文档会带进来的、实际不存在的 id/类） ─────────── */
check('不得出现不存在的选择器：#glass-top / header.topbar / #newChatBtn', () => {
  const dead = ['#glass-top', 'header.topbar', '#newChatBtn'];
  for (const d of dead) {
    assert.ok(!responsiveCss.includes(d), `皮肤段出现死选择器 ${d}（应用中不存在该节点）`);
    assert.ok(!shellJs.includes(d), `shell 中出现死选择器 ${d}`);
  }
});

/* ── 4. 明暗双档令牌 ──────────────────────────────────────────────────────── */
check('明档：主按钮 on-accent 为深墨 #141413（白字仅 3.12:1，禁用）', () => {
  assert.ok(/html\[data-skin="lightwell"\]\s*\{[\s\S]*?--on-accent:\s*#141413/.test(responsiveCss),
    '明档 --on-accent 不是 #141413');
  assert.ok(/--primary:\s*#D97757/.test(responsiveCss), '明档 --primary 不是 #D97757');
  assert.ok(/--accent:\s*#A84424/.test(responsiveCss), '明档 --accent 不是 #A84424');
});

check('暗档：强调色 #E88B6B + 四阶海拔（#141413/#1C1B19/#242320/#2E2C28）', () => {
  // 必须锚定带皮肤前缀的那一段：responsive.css 前半部分还有默认态 body.dark{…}，
  // 用裸 indexOf('body.dark{') 会命中默认态，判出来的东西与皮肤无关。
  const darkStart = responsiveCss.indexOf('html[data-skin="lightwell"] body.dark{');
  assert.ok(darkStart > 0, '未找到皮肤层暗档令牌块');
  const dark = responsiveCss.slice(darkStart, darkStart + 2600);
  assert.ok(dark.includes('--accent:#E88B6B'), '暗档 --accent 不是 #E88B6B');
  for (const step of ['#141413', '#1C1B19', '#242320', '#2E2C28']) {
    assert.ok(dark.includes(step), `暗档缺少海拔色 ${step}`);
  }
});

/* ── 5. 默认态隔离 ────────────────────────────────────────────────────────── */
// 提前拦住「注释里写出完整样式字面量」这一类坑：
// 本仓多条判据对全仓 CSS 做**子串计数**（不是解析 AST），注释里写一遍就等价于
// 多了一条规则。R90 实际踩了两次 —— 一次是 id 属性字面量（contract_diff 的
// dom_ids 多出一个 id），一次是焦点环描边字面量（test_r30_upgrades.py:67 计数 3≠2）。
check('皮肤段注释不得引入会被子串计数的样式字面量', () => {
  // 皮肤层自身必须 0 处：全仓那 2 处 cn-flash 在 legacy.css，由 pytest 守；
  // 这里只保证 responsive.css 不再新增，包括不要在注释里写一遍。
  const n = (responsiveCss.match(/outline:2px solid var\(--primary/g) || []).length;
  assert.equal(n, 0, `responsive.css 中「以 --primary 作焦点环描边」应为 0 处，实为 ${n} 处（含注释）`);
  const ids = responsiveCss.match(/\bid=["'][A-Za-z][A-Za-z0-9_-]*["']/g) || [];
  assert.equal(ids.length, 0, `responsive.css 中不得出现 id 属性字面量（会污染 contract_diff 的 dom_ids）：${ids.join(', ')}`);
});

// R91 · 默认转正后本条语义反转：原判「默认不带 data-skin」的前提是「默认=经典态」，
// 转正后该前提不成立。判据改为三件事，每条都可失败：
//   ① 开关脚本里存在「非 classic 即光井」的判定（否则显式退出档失效）；
//   ② 运行期确实写 data-skin=lightwell（否则默认进不了光井）；
//   ③ 静态标签仍不得写死该属性（否则运行期判定形同虚设）。
check('模板默认即光井、classic 需显式，且静态标签不写死 data-skin', () => {
  assert.ok(/s\s*!==\s*'classic'/.test(templateHtml),
    '模板缺少「非 classic 即光井」判定，显式退出档失效');
  assert.ok(/setAttribute\(\s*'data-skin'\s*,\s*'lightwell'\s*\)/.test(templateHtml),
    '模板缺少运行期写 data-skin 的语句');
  assert.ok(!/^\s*<html[^>]*data-skin=/m.test(templateHtml),
    '模板静态写了 data-skin，运行期开关将失效');
});

check('壳层首屏即判皮肤，非 lightwell 直接 return（不碰 DOM）', () => {
  assert.ok(/getAttribute\('data-skin'\) !== 'lightwell'\)\s*return/.test(shellJs),
    'shell 缺少默认态早退保护');
});

/* ── 6. 壳层必须可被内联：classic script，无模块语法 ──────────────────────── */
check('壳层是 classic script：无顶层 export / import', () => {
  assert.ok(!/^\s*export\s/m.test(shellJs), 'shell 含 export —— build.js 的 new Function 会 SyntaxError');
  assert.ok(!/^\s*import\s/m.test(shellJs), 'shell 含 import —— 同上');
});

check('壳层走 manifest.prebuilt 内联，不占 scripts 名额', () => {
  const pre = (manifest.prebuilt || []).map(e => e.path);
  assert.ok(pre.includes('frontend/skin/lightwellShell.js'),
    'manifest.prebuilt 未登记 lightwellShell.js');
  // 2026-11-23：原断言是 `scripts.length === 117`。那是个**代理值**，不是意图本身——
  // 意图是「壳层不进 scripts，否则会被当普通模块重复内联」。
  // T03 新增两个真实模块（execution-trace / context-dock）后 scripts 变成 119，
  // 该断言红在数字上而非意图上。故改为直接验意图：壳层不得出现在 scripts 路径里。
  // 保留 styles === 14 的数值锁（样式数确实应稳定；变动时需要显式评审）。
  assert.ok(!manifest.scripts.some(e => String(e.path).endsWith('skin/lightwellShell.js')),
    'lightwellShell.js 不应出现在 manifest.scripts（应只走 prebuilt）');
  assert.ok(manifest.scripts.length > 0, 'manifest.scripts 不应为空');
  assert.equal(manifest.styles.length, 14, `manifest.styles 应为 14，实为 ${manifest.styles.length}`);
});

/* ── 7. 九大原型视图 + callApi 遥测 ───────────────────────────────────────── */
check('九大原型视图齐备', () => {
  const views = ['plinth-chart', 'stair-gate', 'rack-tabs', 'retrieval-well',
    'lane-timeline', 'topology-ring', 'drawer-cabinet', 'form-stack', 'flow-track'];
  for (const v of views) {
    assert.ok(shellJs.includes(`'${v}'`), `缺少原型视图 ${v}`);
  }
  assert.equal((shellJs.match(/id: '[a-z-]+', label:/g) || []).length, 9,
    'PROTOTYPE_VIEWS 条目数不是 9');
});

/* ── 7b. R100 生产态收口：observerWindow 默认折叠 ─────────────────────────────
 * 为什么不能只写 /observerOpen\s*:\s*false/ 了事：
 *   ① 只判「存在 false」时，注释里留一句 observerOpen: false、代码里仍写 true，照样全绿；
 *   ② 壳层里 `state.observerOpen = !state.observerOpen`（toggle）、
 *      `state.observerOpen = false/true`（尺寸同步）、
 *      `observerOpen: state.observerOpen`（遥测快照）都含 observerOpen 字样，
 *      用宽正则会被这些合法行误伤 → 假红（工程师会去改本来就正确的代码）。
 * 故判据落在**解析出的 state 对象字面量**上：剥注释 → 截出 `var state = {` 的配平块 →
 * 要求 `observerOpen:` 在该块内恰好 1 次且取值恰为 `false`。
 */
const stripJsComments = js => String(js)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** 从 openIdx 处的 `{` 起按花括号配平截出对象体（注释已剥，故不含伪装的花括号） */
function sliceBalancedObject(js, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < js.length; i += 1) {
    if (js[i] === '{') depth += 1;
    else if (js[i] === '}') {
      depth -= 1;
      if (depth === 0) return js.slice(openIdx + 1, i);
    }
  }
  return null;
}

/**
 * 生产态折叠判据（纯函数：喂任意 JS 文本 → 违规清单，正样本与变异负控共用同一份逻辑）。
 * @param {string} jsText 壳层 JS 全文
 * @returns {string[]} 违规消息（空数组 = 合规）
 */
function checkR100FoldGate(jsText) {
  const out = [];
  const text = stripJsComments(jsText);
  const at = text.indexOf('var state = {');
  if (at < 0) {
    out.push('未找到 `var state = {` 初始状态字面量 —— 壳层结构被改，判据无从下手');
    return out;
  }
  const openIdx = text.indexOf('{', at);
  const body = openIdx < 0 ? null : sliceBalancedObject(text, openIdx);
  if (body === null) {
    out.push('`var state = {` 的花括号未配平，无法截出初始状态字面量');
    return out;
  }
  // ① 主判据：字面量内 observerOpen 恰好 1 条、取值恰为 false
  const decls = [];
  const declRe = /(?:^|,)\s*observerOpen\s*:\s*([^,}]+)/g;
  let m = declRe.exec(body);
  while (m !== null) {
    decls.push(m[1].trim());
    m = declRe.exec(body);
  }
  if (decls.length !== 1) {
    out.push(`state 字面量里 observerOpen 应恰好声明 1 次，实为 ${decls.length} 次`
      + '（重复键后者覆盖前者，只判「存在 false」会假绿）');
  } else if (decls[0] !== 'false') {
    out.push(`state.observerOpen 默认值必须是 false（生产态折叠，释放 360px 主舞台），实为 ${decls[0]}`);
  }
  // ② 全文不得再出现「对象字面量形态」的 observerOpen: true —— 堵「另起一个对象把它盖回去」
  const objTrue = text.match(/\bobserverOpen\s*:\s*true\b/g) || [];
  if (objTrue.length > 0) {
    out.push(`全文出现 ${objTrue.length} 处 observerOpen: true（对象字面量形态），默认折叠可被覆盖`);
  }
  // ③ 任何 state.observerOpen = true 赋值都不得早于窗口宽度逻辑 —— 堵「初始化后立刻改回展开」
  const anchor = text.indexOf('var NARROW_MAX_WIDTH');
  const asgRe = /state\.observerOpen\s*=\s*true\b/g;
  let a = asgRe.exec(text);
  while (a !== null) {
    if (anchor < 0 || a.index < anchor) {
      out.push('state.observerOpen = true 出现在「窗口宽度逻辑（NARROW_MAX_WIDTH）」之前，'
        + '等于初始化后立刻改回展开，生产态并未收口');
      break;
    }
    a = asgRe.exec(text);
  }
  return out;
}

check('R100 生产态收口：observerWindow 默认折叠（state.observerOpen 默认值为 false）', () => {
  const v = checkR100FoldGate(shellJs);
  assert.equal(v.length, 0, v.join(' | '));
});

check('callApi 遥测带重试，不是「找不到就放弃」', () => {
  assert.ok(/hookCallApiTelemetry\(n \+ 1\)|hookCallApiTelemetry\(attempt \+ 1\)/.test(shellJs),
    '缺少 callApi 未就绪时的重试逻辑');
  assert.ok(shellJs.includes('__lwWrapped'), '缺少重复包裹保护');
});

check('遥测口径标注为粗估（EST，非计费）', () => {
  assert.ok(/粗估|EST_TOKENS/.test(shellJs), '缺少估算口径说明');
});

/* ── 8. fx-off 降级 ───────────────────────────────────────────────────────── */
check('fx-off 下四个宿主全部关闭 blur', () => {
  // 同样必须锚定皮肤前缀：文件上半部有默认态的 body.fx-off * 兜底规则。
  const idx = responsiveCss.indexOf('html[data-skin="lightwell"] body.fx-off');
  assert.ok(idx > 0, '缺少皮肤层 fx-off 规则');
  const seg = responsiveCss.slice(idx, idx + 900);
  for (const host of ['header.header', '#mainStage', '#observerWindow', '#glass-ribbon']) {
    assert.ok(seg.includes(host), `fx-off 未覆盖宿主 ${host}`);
  }
  assert.ok(/backdrop-filter:\s*none/.test(seg), 'fx-off 未关闭 backdrop-filter');
});

/* ── 9. 产物级：压缩器不许 rename 标识符 ─────────────────────────────────────
 * 背景（R95，QA 指出）：光有「某名字不在产物里」这类**缺席断言**拦不住改名 ——
 * 改名以后它本来就不在，断言依然绿。而 legacy 全局靠**名字**互调（prebuilt 壳层
 * 调 callApi / buildAnalyticsSnapshot 是运行期解析），一旦被 rename，静态判据全绿、
 * 运行期 ReferenceError。所以这里改成**出现次数**断言：这些定义形态必须恰好 1 次。 */
check('产物里 legacy 全局标识符各出现恰好 1 次（压缩器不得 rename）', () => {
  const bundle = read('harbor.html');
  const once = (needle, label) => {
    const n = bundle.split(needle).length - 1;
    assert.equal(n, 1, `${label} "${needle}" 出现 ${n} 次（要求恰好 1 次）—— 压缩器疑似改了标识符`);
  };
  once('function renderPrototypeContent(', '壳层渲染入口定义');
  once('function callApi(', '桥接入口定义');
  once('function buildAnalyticsSnapshot(', '分析快照入口定义');
  once('function aggregateSessions(', '会话聚合入口定义');
  once('__LIGHTWELL_SHELL__', '壳层导出名');
});

/* ── 10. 壁纸层（R98 决策锁，2026-11-18 产品裁定）─────────────────────────────
 * 立此段的原因（R98 事故复盘）：css-lint / 本 gate / skin-probe / liquid-switch-probe
 * 四条门禁对壁纸层的 `opacity` 与 `background-blend-mode` 断言数均为 **0**，
 * 导致「明档 .62」与「明档 lighten」两版都能全绿 —— 门禁对该设计选择全盲，
 * 一轮评审在「哪版更好」上空转。此处把**结构**钉死（不钉数值），让 lighten 回潮/门控被删
 * 在 CI 里当场变红。
 *
 * 决策依据（勿误读为「lighten 对比度更差」——事实相反）：
 *   lighten 逐通道取 max，使「次级对比度不低于基线」由构造成立（实测 Δ=0.00），
 *   但那正是恒真式：它成立的代价是把被测量的对象（壁纸）抹成纸色 —— 深色桌面壁纸
 *   （本机深绿海面）在 lighten 下几乎不可见，等于「透色」功能没做，故否决；
 *   改锁 .62 alpha 合成，用次级对比度 3.93→2.65 的劣化换「壁纸真的看得见」。
 *
 * 分工：本段守**静态结构**（毫秒级、进 CI）；计算值由 qa/r98/probe-r98-wallpaper-lock.mjs
 * 在真实浏览器里守（两者互补，缺一不可 —— 见下面负控里「computed 无法区分有/无声明」）。
 *
 * 判据口径：
 *   ① 凡**消费壁纸**的规则（body 里出现 var(--wp-url)）必须带 [data-wp="ready"] 门控；
 *      门控被删 ⇒ data-wp 缺失时壁纸也上屏 ⇒ 回退路径当场破，而原有四条门禁全不报。
 *   ② 明档规则必须声明 opacity，且**不得**声明 background-blend-mode（防 lighten 回潮）。
 *   ③ 暗档规则必须显式声明 background-blend-mode 且 normal 出现 4 次（防明档声明被继承）。
 *   ④ 两档 opacity 数值必须等于顶部 R98_WP_OPACITY 常量（**锁决策、不锁字面量**：
 *      数值只在常量区出现一次，调参改一行；运行期计算值口径另由 probe 守）。
 *
 * 为什么数值断言必须走「静态文本」，不能走 getComputedStyle：
 *   `normal` 与 `1` 都是 CSS 默认值 —— 整块删掉暗档那条 background-blend-mode 声明，
 *   computed 仍返回 `normal,normal,normal,normal`；删掉 opacity 声明，computed 仍返回 `1`。
 *   即「computed 断言无法区分『有声明』与『无声明』」，只有源码文本能抓（R98 实测自证）。 */

/** 剥掉注释（变异与解析都用它，保证「变异打不到注释上」） */
const stripComments = cssText => String(cssText).replace(/\/\*[\s\S]*?\*\//g, '');

/** 取「选择器 → 声明块」对；剥注释、跳过 @ 规则。 */
function ruleBlocks(cssText) {
  const text = stripComments(cssText);
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m = re.exec(text);
  while (m !== null) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    if (selector && !selector.startsWith('@')) out.push({ selector, body: m[2] });
    m = re.exec(text);
  }
  return out;
}
const hasDecl = (body, prop) => new RegExp('(?:^|;)\\s*' + prop + '\\s*:', 'i').test(body);
const declVal = (body, prop) => {
  const m = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;}]+)', 'i').exec(body);
  return m ? m[1].trim() : null;
};
/** 同一声明在块里出现几次（防「前面写了合规值，后面又被覆盖」这类假绿 —— 
 *  declVal 只取第一处，浏览器取最后一处，两者不一致就是断言的盲区） */
const countDecl = (body, prop) =>
  (body.match(new RegExp('(?:^|;)\\s*' + prop + '\\s*:', 'gi')) || []).length;
/** CSS 数值比对（源文本有省略前导零 / 带前导零 / 百分比等写法，统一 parseFloat 后带容差比） */
const numIs = (raw, expect) => {
  const v = parseFloat(String(raw));
  return Number.isFinite(v) && Math.abs(v - expect) < 1e-6;
};

/**
 * 收集壁纸相关规则并分组（纯函数；正样本与变异负控共用同一份定位逻辑，
 * 保证「判据看的那条规则」与「变异改的那条规则」永远是同一条）。
 * 消费者以 `var(--wp-url` + 边界符判定，不用 background-image ——
 * 基础规则也有 background-image（三层渐变兜底），用它会误伤回退路径本身。
 */
function findWall(cssText) {
  const wall = ruleBlocks(cssText).filter(b => b.selector.includes('#lw-ambient-wallpaper'));
  return {
    wall,
    consumers: wall.filter(b => /var\(\s*--wp-url\s*[,)]/.test(b.body)),
    light: wall.filter(b => b.selector.includes('[data-wp="ready"]') && !b.selector.includes('body.dark')),
    dark: wall.filter(b => b.selector.includes('[data-wp="ready"]') && b.selector.includes('body.dark')),
  };
}

/**
 * 壁纸层结构判据（纯函数：喂任意 CSS 文本 → 违规清单，供正样本与变异负控复用）。
 * 返回 { gate, light, dark, consumerCount }，每个 bucket 是违规消息数组。
 */
function checkWallpaperGate(cssText) {
  const { consumers, light, dark } = findWall(cssText);
  const gate = [];
  const lightViolations = [];
  const darkViolations = [];

  if (consumers.length === 0) gate.push('未找到任何消费 var(--wp-url) 的壁纸规则（壁纸可能整体失效）');
  for (const b of consumers) {
    if (!b.selector.includes('[data-wp="ready"]')) {
      gate.push('消费壁纸但缺 [data-wp="ready"] 门控 → ' + b.selector);
    }
  }

  // ② / ③ 明档、暗档各必须**恰好一条**（防「后面又复制一条覆盖规则」这类回退）
  if (light.length !== 1) lightViolations.push(`明档壁纸规则应恰好 1 条，实为 ${light.length} 条`);
  if (dark.length !== 1) darkViolations.push(`暗档壁纸规则应恰好 1 条，实为 ${dark.length} 条`);

  if (light.length === 1) {
    const b = light[0];
    const op = declVal(b.body, 'opacity');
    if (op === null) {
      lightViolations.push('明档未声明 opacity');
    } else if (!numIs(op, R98_WP_OPACITY.light)) {
      lightViolations.push(`明档 opacity 应为 R98 决策值 ${R98_WP_OPACITY.light}，实为 ${op}`);
    }
    // 防「合规值在前、覆盖值在后」：declVal 取第一处，浏览器取最后一处
    const opN = countDecl(b.body, 'opacity');
    if (opN !== 1) lightViolations.push(`明档 opacity 声明应恰好 1 处，实为 ${opN} 处（后面的会覆盖前面的，判据会假绿）`);
    if (hasDecl(b.body, 'background-blend-mode')) {
      lightViolations.push('明档声明了 background-blend-mode（lighten 回潮）：' + declVal(b.body, 'background-blend-mode'));
    }
  }
  if (dark.length === 1) {
    const b = dark[0];
    const op = declVal(b.body, 'opacity');
    if (op === null) {
      darkViolations.push('暗档未声明 opacity');
    } else if (!numIs(op, R98_WP_OPACITY.dark)) {
      darkViolations.push(`暗档 opacity 应为 R98 决策值 ${R98_WP_OPACITY.dark}，实为 ${op}`);
    }
    const opN = countDecl(b.body, 'opacity');
    if (opN !== 1) darkViolations.push(`暗档 opacity 声明应恰好 1 处，实为 ${opN} 处`);
    const blendN = countDecl(b.body, 'background-blend-mode');
    if (blendN > 1) darkViolations.push(`暗档 background-blend-mode 声明应恰好 1 处，实为 ${blendN} 处`);
    const blend = declVal(b.body, 'background-blend-mode');
    if (!blend) {
      darkViolations.push('暗档未显式声明 background-blend-mode（明档声明会被继承）');
    } else {
      const normals = blend.split(',').map(s => s.trim().toLowerCase()).filter(s => s === 'normal').length;
      if (normals !== 4) darkViolations.push(`暗档 blend 的 normal 应出现 4 次，实为 ${normals}（值：${blend}）`);
    }
  }
  return { gate, light: lightViolations, dark: darkViolations, consumerCount: consumers.length };
}

check('壁纸层门控：[data-wp="ready"] 必须存在于所有消费 var(--wp-url) 的规则上', () => {
  const r = checkWallpaperGate(responsiveCss);
  assert.equal(r.gate.length, 0, r.gate.join(' | '));
});

check('壁纸层明档：必须声明 opacity=R98 决策值，且不得声明 background-blend-mode（防 lighten 回潮）', () => {
  const r = checkWallpaperGate(responsiveCss);
  assert.equal(r.light.length, 0, r.light.join(' | '));
});

check('壁纸层暗档：必须声明 opacity=R98 决策值，且显式声明 background-blend-mode normal×4（防明档声明被继承）', () => {
  const r = checkWallpaperGate(responsiveCss);
  assert.equal(r.dark.length, 0, r.dark.join(' | '));
});

/* ── 11. R100 原生实时透色双态隔离层（惰性 CSS：属性存在才生效）─────────────────
 * 前提（必须写进验收说明，否则会被误判「功能没生效」）：全仓目前**无任何地方**写
 * `data-glass-engine`（grep 0 命中）。本段守的是「当 M3 把属性挂上时，CSS 必须已经让位」
 * 这一**静态承诺**，不是运行时效果；真透色在 M3 验。
 *
 * 判据口径（每条都可失败）：
 *   ① 必须存在选择器含 R100_NATIVE_ATTR 的规则块 —— 缺失即报「G02-A 未落盘」，
 *      **不 SKIP**（SKIP 在汇总里就是绿，等于假绿）；
 *   ② 原生模式下静态壁纸必须隐藏：存在**选择器段以 #lw-ambient-wallpaper 收尾**的
 *      native 规则块，其 body 的 display 恰 1 处且为 none[!important]；
 *   ③ 原生模式下四宿主 CSS 模糊必须归零：存在**四段选择器分别以 4 个宿主收尾**的
 *      native 规则块，其 body 的 backdrop-filter 恰 1 处且为 none；
 *      且任何 native 规则块内都不得出现非 none 的 backdrop-filter（防后面补一条盖回来）。
 *
 * 为什么用「选择器段 endsWith 宿主」而不是 includes：
 *   既有「宿主内部禁模糊」规则写的是 `#mainStage *` 这类后代选择器，也含 #mainStage；
 *   用 includes 会把「只管后代、不管宿主本身」的规则误认成「宿主已归零」→ 判据当场假绿。
 *
 * 为什么还要 countDecl === 1（与壁纸层 M6 同源教训）：
 *   declVal 取第一处、浏览器取最后一处；`backdrop-filter:none; backdrop-filter:blur(30px)`
 *   在只读第一处的判据下是绿的。
 */
const r100SelSegments = selector => selector.split(',').map(x => x.trim()).filter(Boolean);
const r100SelEndsWith = (selector, tail) => r100SelSegments(selector).some(x => x.endsWith(tail));
const r100DisplayIsNone = body => {
  const v = declVal(body, 'display');
  return v !== null && /^none\s*(!\s*important)?$/i.test(v);
};
const r100BlurIsNone = body => {
  const v = declVal(body, 'backdrop-filter');
  return v !== null && v.toLowerCase() === 'none';
};
/** 返回第一条「非 none 的 backdrop-filter」取值文本；没有则 null */
const r100BlurRevived = body => {
  const m = /backdrop-filter\s*:\s*((?!none\b)[^;}]+)/i.exec(body);
  return m ? m[1].trim() : null;
};

/**
 * 原生隔离层判据（纯函数：喂任意 CSS 文本 → 分桶违规清单，正样本与变异负控共用）。
 * @param {string} cssText 完整 CSS 文本
 * @returns {{presence: string[], wall: string[], blur: string[]}}
 */
function checkR100NativeGate(cssText) {
  const out = { presence: [], wall: [], blur: [] };
  const native = ruleBlocks(stripComments(cssText))
    .filter(b => b.selector.includes(R100_NATIVE_ATTR));
  if (native.length === 0) {
    const msg = `CSS 中没有任何选择器含 ${R100_NATIVE_ATTR} 的规则块 —— G02-A 原生隔离层未落盘`;
    out.presence.push(msg);
    // 不许 SKIP：没落盘时下面两条也必须各自红，且消息直指 G02-A
    out.wall.push('原生模式下必须有隐藏静态壁纸的规则（选择器段以 #lw-ambient-wallpaper 收尾 + display:none）；' + msg);
    out.blur.push('原生模式下必须有四宿主模糊归零的规则（四段选择器各以宿主收尾 + backdrop-filter:none）；' + msg);
    return out;
  }
  // ② 静态壁纸必须隐藏
  const wallRules = native.filter(b => r100SelEndsWith(b.selector, '#lw-ambient-wallpaper'));
  if (wallRules.length === 0) {
    out.wall.push(`原生模式下缺少隐藏静态壁纸的规则：需存在选择器同时含 ${R100_NATIVE_ATTR} 与 #lw-ambient-wallpaper 的规则块`);
  }
  for (const b of wallRules) {
    if (!r100DisplayIsNone(b.body)) {
      out.wall.push('原生模式壁纸规则未声明 display:none → ' + b.selector);
    } else if (countDecl(b.body, 'display') !== 1) {
      out.wall.push(`原生模式壁纸规则 display 声明应恰好 1 处，实为 ${countDecl(b.body, 'display')} 处（后面的会覆盖前面的）`);
    }
  }
  // ③ 四宿主模糊归零
  const hostKiller = native.filter(b => R100_HOSTS.every(h => r100SelEndsWith(b.selector, h)));
  if (hostKiller.length === 0) {
    out.blur.push('原生模式下缺少「四宿主模糊归零」规则：需存在选择器覆盖 '
      + R100_HOSTS.join(' / ') + ` 且带 ${R100_NATIVE_ATTR} 的规则块`);
  }
  for (const b of hostKiller) {
    if (!r100BlurIsNone(b.body)) {
      out.blur.push('原生模式下四宿主仍声明了非 none 的 backdrop-filter（'
        + declVal(b.body, 'backdrop-filter') + '）—— 会与原生 HLSL 叠成二次模糊 → ' + b.selector);
    } else if (countDecl(b.body, 'backdrop-filter') !== 1) {
      out.blur.push('原生模式四宿主 backdrop-filter 声明应恰好 1 处，实为 '
        + countDecl(b.body, 'backdrop-filter') + ' 处（declVal 读第一处、浏览器取最后一处）');
    }
  }
  for (const b of native) {
    const revived = r100BlurRevived(b.body);
    if (revived !== null) {
      out.blur.push(`原生模式规则块内出现非 none 的 backdrop-filter（${revived}）→ ${b.selector}`);
    }
  }
  return out;
}

check('R100 原生模式：必须隐藏静态壁纸 #lw-ambient-wallpaper（display:none，防静态壁纸盖住真透色背板）', () => {
  const r = checkR100NativeGate(responsiveCss);
  assert.equal(r.wall.length, 0, r.wall.join(' | '));
});

check('R100 原生模式：四宿主 CSS 模糊必须归零（backdrop-filter:none，防与原生 HLSL 叠成二次模糊）', () => {
  const r = checkR100NativeGate(responsiveCss);
  assert.equal(r.blur.length, 0, r.blur.join(' | '));
});

/* 变异负控 —— 证明上面三条**真的会红**，而不是恒真式。
 * 纪律（沿用本文件第 5 段教训）：
 *   1. 变异一律**单点最小改动**，每条只动一处，对应「有人只改了明档」这种真实失误；
 *      全局 /g 替换会让两条规则同时失效，红了也证明不了判据能抓单条失误。
 *   2. 锚点**一律取自 findWall() 解析出来的选择器/规则体**，不写任何字面量。
 *      R98 教训（工程师交叉验证 C8 实测）：早先版本用 `css.replace('opacity:.62;', …)`
 *      这类字面量做锚点，结果「改个值 / 加个空格 / 补个前导零」就让锚点失配，
 *      负控红在「变异脚本已失效」上 —— 失败信息指向测试脚本而不是产品，
 *      值班的人会白烧一轮。锚点取自解析结果后，值/格式怎么改都不会误伤负控。
 *   3. 变异作用在**剥注释后的文本**上（stripComments），消掉「打偏到注释」的隐患。 */
const mutationLog = [];
const CSS_NC = stripComments(responsiveCss);
const WALL_NC = findWall(CSS_NC);
const LIGHT_BODY = WALL_NC.light.length === 1 ? WALL_NC.light[0].body : null;
const DARK_BODY = WALL_NC.dark.length === 1 ? WALL_NC.dark[0].body : null;
const LIGHT_SEL = WALL_NC.light.length === 1 ? WALL_NC.light[0].selector : null;

/** 在文本中把「某条规则的 body」换掉（只动第一处；body 取自解析结果，不是字面量） */
const swapBody = (css, body, next) => {
  const at = body ? css.indexOf(body) : -1;
  return at < 0 ? null : css.slice(0, at) + next + css.slice(at + body.length);
};
/** 只在该条规则的**选择器文本内部**摘掉门控，不碰文件里其他任何位置 */
const dropGateFromSelector = (css, selector) => {
  const at = selector ? css.indexOf(selector) : -1;
  return at < 0 ? null : css.slice(0, at) + selector.replace('[data-wp="ready"]', '') + css.slice(at + selector.length);
};
const OPACITY_DECL_RE = /opacity\s*:\s*[^;}]+;?/i;
const BLEND_DECL_RE = /background-blend-mode\s*:\s*[^;}]+;?/i;

const MUTATIONS = [
  {
    id: 'M1', label: '摘掉明档选择器里的 [data-wp="ready"]（模拟「只想让明档常显」）',
    anchor: '明档选择器文本里的 [data-wp="ready"]',
    mutate: css => dropGateFromSelector(css, LIGHT_SEL),
    expect: 'gate',
  },
  {
    id: 'M2', label: '在明档规则体内插入 background-blend-mode:lighten,…（lighten 回潮）',
    anchor: '明档规则体',
    mutate: css => swapBody(css, LIGHT_BODY,
      LIGHT_BODY && LIGHT_BODY + 'background-blend-mode:lighten,normal,normal,normal;'),
    expect: 'light',
  },
  {
    id: 'M3', label: '删掉明档规则体里的 opacity 声明',
    anchor: '明档规则体里的 opacity 声明',
    mutate: css => swapBody(css, LIGHT_BODY,
      LIGHT_BODY && LIGHT_BODY.replace(OPACITY_DECL_RE, '')),
    expect: 'light',
  },
  {
    id: 'M4', label: '删掉暗档规则体里的 background-blend-mode 声明（→ 明档/默认值可被继承）',
    anchor: '暗档规则体里的 background-blend-mode 声明',
    // 这条专治「W4 假强」：走 computed 会读到默认值 normal×4 而假绿，只有静态声明路径会红
    mutate: css => swapBody(css, DARK_BODY,
      DARK_BODY && DARK_BODY.replace(BLEND_DECL_RE, '')),
    expect: 'dark',
  },
  {
    id: 'M5', label: '把明档 opacity 悄悄改成 .70（证明数值锁非恒真；不动常量、只动 CSS）',
    anchor: '明档规则体里的 opacity 声明',
    mutate: css => swapBody(css, LIGHT_BODY,
      LIGHT_BODY && LIGHT_BODY.replace(OPACITY_DECL_RE, 'opacity:.70;')),
    expect: 'light',
  },
  {
    id: 'M6', label: '在明档合规声明**之后**再补一行 opacity:.70（前面的读得到、后面的才生效）',
    anchor: '明档规则体（在其末尾追加第二条 opacity）',
    // 专治「声明存在但被后面覆盖」：没有 countDecl 守卫时 declVal 读第一处，断言恒真
    mutate: css => swapBody(css, LIGHT_BODY,
      LIGHT_BODY && LIGHT_BODY + 'opacity:.70;'),
    expect: 'light',
  },
];

check('变异负控：每条单点变异必须各自让对应断言变红（含数值锁、重复声明覆盖各一条，证明判据非恒真）', () => {
  for (const mu of MUTATIONS) {
    const mutated = mu.mutate(CSS_NC);
    // 锚点在现行 CSS 里找不到（产品声明被合法改值/删改）时，别报「测试坏了」——把人引向产品
    assert.ok(mutated !== null && mutated !== CSS_NC,
      `${mu.id} 负控锚点「${mu.anchor}」在现行 CSS 中已找不到：可能是产品声明被合法改值/删改。`
      + '请先看上面 live 断言是否已红——若已红，先修产品；确认产品无误后，'
      + '再确认是否需要同步顶部 R98_WP_OPACITY（调参＝CSS 与常量两处一起改）或更新本负控。');
    const r = checkWallpaperGate(mutated);
    const bucket = r[mu.expect] || [];
    const fired = bucket.length > 0;
    mutationLog.push({ id: mu.id, label: mu.label, anchor: mu.anchor, expect: mu.expect, fired, violations: bucket });
    assert.ok(fired, `${mu.id} 期望 ${mu.expect} 变红，实际仍为绿 —— 该断言是恒真式`);
  }
});

// 变异判定结果落证据（供评审复核；不放 server/test/ 免得污染门禁目录）
try {
  const crypto = await import('node:crypto');
  const evPath = path.join(ROOT, 'qa', 'r98', 'out', 'r98-wallpaper-gate-ci.json');
  fs.mkdirSync(path.dirname(evPath), { recursive: true });
  fs.writeFileSync(evPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    css: {
      path: 'frontend/styles/responsive.css',
      sha256: crypto.createHash('sha256').update(responsiveCss).digest('hex'),
      ruleBlocks: ruleBlocks(responsiveCss).length,
    },
    live: checkWallpaperGate(responsiveCss),
    mutations: mutationLog,
  }, null, 2));
} catch (err) {
  // 证据落盘失败不影响门禁判定，但必须显性可见
  mutationLog.push({ id: 'EVIDENCE', label: '证据 JSON 写盘失败：' + err.message, expect: '-', fired: false, violations: [] });
}

/* R100 原生层变异负控 —— **独立数组 + 独立循环**，理由（勿重构掉）：
 *   · 既有 MUTATIONS 是「mutate 只接 CSS 文本」+ 循环里写死 checkWallpaperGate(mutated) 与
 *     r[mu.expect]。M8 要变异的是 **shellJs**（不是 CSS）；硬塞进同一个数组就得把 M1–M6 的
 *     签名全改一遍，等于动了 r98 的既有断言，违反「只加不改」纪律。
 *   · 故此处每条各带 `pick`（从判据返回值里取哪个桶）与 `stdin`（变异作用的输入文本），
 *     不强求统一签名；两个循环互不干扰，expect 桶名空间也不冲突。
 *   · 锚点纪律沿用上面 M1–M6：一律取自解析结果（R100_HOST_BODY / R100_WALL_BODY），
 *     不写 CSS 字面量；变异作用在剥注释后的文本上。 */
const JS_NC = stripJsComments(shellJs);
const R100_NATIVE_BLOCKS = ruleBlocks(CSS_NC).filter(b => b.selector.includes(R100_NATIVE_ATTR));
const R100_HOST_BODY = (() => {
  const b = R100_NATIVE_BLOCKS.find(x => R100_HOSTS.every(h => r100SelEndsWith(x.selector, h)));
  return b ? b.body : null;
})();
const R100_WALL_BODY = (() => {
  const b = R100_NATIVE_BLOCKS.find(x => r100SelEndsWith(x.selector, '#lw-ambient-wallpaper'));
  return b ? b.body : null;
})();

const NATIVE_MUTATIONS = [
  {
    id: 'M7', expect: 'blur',
    label: '原生模式下擅自把四宿主 CSS 模糊开回来（backdrop-filter:none → blur(20px)）',
    anchor: '原生隔离层里覆盖四宿主那条规则的 body',
    stdin: 'css',
    // (^|;)\s* 锚点：只用裸 /backdrop-filter:\s*none/ 会先命中 -webkit-backdrop-filter 那行，
    // 变异打在带前缀的那条上，主判据（标准属性）不动 —— 负控就成了「测变异脚本」而不是测产品。
    mutate: () => swapBody(CSS_NC, R100_HOST_BODY,
      R100_HOST_BODY && R100_HOST_BODY.replace(
        /(^|;)(\s*)backdrop-filter\s*:\s*none/i, '$1$2backdrop-filter:blur(20px)')),
    gate: checkR100NativeGate,
    pick: r => r.blur,
  },
  {
    id: 'M8', expect: 'fold',
    label: '把 state.observerOpen 改回 true（生产态又占 360px 主舞台）',
    anchor: 'state 字面量里的 observerOpen 默认值',
    stdin: 'js',
    // 这条不走 CSS 路径：变异对象是 shellJs，判据走 checkR100FoldGate
    mutate: () => (JS_NC.includes('observerOpen: false')
      ? JS_NC.replace(/(,\s*)observerOpen\s*:\s*false/, '$1observerOpen: true')
      : null),
    gate: checkR100FoldGate,
    pick: r => r,
  },
  {
    id: 'M9', expect: 'wall',
    label: '原生模式未隐藏静态壁纸（删掉 display:none!important）',
    anchor: '原生隔离层里含 #lw-ambient-wallpaper 那条规则的 body',
    stdin: 'css',
    mutate: () => swapBody(CSS_NC, R100_WALL_BODY,
      R100_WALL_BODY && R100_WALL_BODY.replace(/display\s*:\s*none\s*!important\s*;?/i, '')),
    gate: checkR100NativeGate,
    pick: r => r.wall,
  },
  {
    id: 'M10', expect: 'blur',
    label: '四宿主先写 backdrop-filter:none、后面再补一行 blur(30px)（合规值在前、覆盖值在后）',
    anchor: '原生隔离层四宿主规则的 body（末尾追加第二条 backdrop-filter）',
    stdin: 'css',
    // 与壁纸层 M6 同构：专治「声明存在但被后面覆盖」—— 没有 countDecl 守卫时判据恒真
    mutate: () => swapBody(CSS_NC, R100_HOST_BODY,
      R100_HOST_BODY && R100_HOST_BODY + 'backdrop-filter:blur(30px);'),
    gate: checkR100NativeGate,
    pick: r => r.blur,
  },
];

check('R100 原生层变异负控：M7–M10 每条单点变异必须各自让对应桶变红（证明原生门与折叠门非恒真）', () => {
  for (const mu of NATIVE_MUTATIONS) {
    const base = mu.stdin === 'js' ? JS_NC : CSS_NC;
    const mutated = mu.mutate();
    assert.ok(mutated !== null && mutated !== base,
      `${mu.id} 负控锚点「${mu.anchor}」在现行源码中已找不到：可能是产品声明被合法改值/删改。`
      + '请先看上面 live 断言是否已红——若已红，先修产品；确认产品无误后，再更新本负控锚点。');
    const bucket = mu.pick(mu.gate(mutated));
    const fired = bucket.length > 0;
    mutationLog.push({ id: mu.id, label: mu.label, anchor: mu.anchor, expect: mu.expect, fired, violations: bucket });
    assert.ok(fired, `${mu.id} 期望 ${mu.expect} 变红，实际仍为绿 —— 该断言是恒真式`);
  }
});

/* ── 汇总 ─────────────────────────────────────────────────────────────────── */
if (mutationLog.length) {
  console.log('变异负控实跑结果（每条只动一处）：');
  for (const mu of mutationLog) {
    console.log(`  ${mu.fired ? 'RED ✓' : 'GREEN ✗'}  ${mu.id}  期望红=${mu.expect}｜${mu.label}`);
    if (mu.violations.length) console.log('           → ' + mu.violations.join(' | '));
  }
  console.log('');
}

const failed = results.filter(r => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '\n        → ' + r.msg}`);
}
console.log(`\nLIGHTWELL_SKIN_GATE: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${results.length - failed.length}/${results.length})`);
process.exit(failed.length === 0 ? 0 : 1);
