/* ============================================================================
   R80 第一批 · views.css / base.css 结构手术（一次性脚本）
     ① .atmosphere 光学层清空（5 处彩色光斑 + 24h 光照 brightness）
     ② .stage 内部三团液团 + caustic + halo 层删除
     ③ #observerWindow / #glass-ribbon 关掉 glass（#mainStage 保留）
     ④ L1 边缘栈换成 R80-SPEC §2.3 的五档（原文给定值，不是我的判断）
     ⑤ 删除 R79 的 `html[data-optics="displace"]` 两条规则（R79 折射规格作废）
     ⑥ .msg 结构分层：容器层承担材质 / 内容层永不带 filter
   行号手术 + 唯一性断言：任何一处对不上就整体不写盘。
   ============================================================================ */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWS = resolve(HERE, '..', 'styles', 'views.css');
const TOKENS = resolve(HERE, '..', 'styles', 'tokens.css');

function load(p) {
  const raw = readFileSync(p, 'utf8');
  const crlf = raw.includes('\r\n');
  return { raw, crlf, text: crlf ? raw.replace(/\r\n/g, '\n') : raw, lines: (crlf ? raw.replace(/\r\n/g, '\n') : raw).split('\n') };
}
function save(p, text, crlf) {
  writeFileSync(p, crlf ? text.replace(/\n/g, '\r\n') : text);
}
const assert = (cond, msg) => { if (!cond) { console.error('✗ ' + msg); process.exit(1); } };

/* ============================================================ views.css */
let V = load(VIEWS);
let L = V.lines;

/* 行号手术（从下往上，避免位移） */
const cuts = [
  { a: 950, b: 981, first: '    /* R79 · 台面上的折射光斑', last: '      var(--liquid-8) 0 44%, transparent 74%),' },
  { a: 785, b: 799, first: '.atmosphere::after {', last: '}' },
  { a: 712, b: 784, first: '.atmosphere::before {', last: '}' },
  { a: 707, b: 711, first: '.atmosphere {', last: '}' },
];
for (const c of cuts) {
  assert(L[c.a - 1].trim().startsWith(c.first.trim()), `行 ${c.a} 首行不符：${L[c.a - 1].slice(0, 60)}`);
  assert(L[c.b - 1].trim() === c.last.trim(), `行 ${c.b} 末行不符：${L[c.b - 1].slice(0, 60)}`);
}

const ATMOS = `/* ---------------------------------------------------------------------------
   R80 · 背景：一片实心纸面（原来这里有 5 处彩色光斑，全部删除）
   ---------------------------------------------------------------------------
   删掉的东西：.atmosphere::before 的三团大液团 + 两滴小液滴 + caustic 光斑 +
   halo 光环；.atmosphere::after 的 5 团天色斑；.stage 内部的 3 团台面液团；
   再加上 --liquid-* / --caustic-* / --halo-* 的全部引用。

   依据是硬数据不是审美：6 个桌面 AI 产品（ChatGPT / Claude / Cursor / Warp /
   Linear / Raycast）主窗口 UI 内的装饰光斑 = 0 个；Linear 明文「There are no
   gradient tokens」，Raycast 的彩色条纹限定 once per page 且只在营销页。
   5 处同屏是数量级偏离。暖底 + 多色 = 脏；暖底 + 单色 = 高级。

   filter 也一并归零：brightness(--sun-exposure) saturate(--sun-warm) 是 24 小时
   光照模型的产物，那个模型已作废（同一个界面在一天里换 4 种主色，与「一个强调色」
   直接冲突）。★ 令牌与 sun.js 全部保留（只增不删），只是不再被消费。

   元素本身不删：.atmosphere 同时是 [data-ambient] 与 .reveal，删掉会让既有判据
   失去锚点。grain 纹理仍由 base.css 的 .grain::after 提供（原来被本文件的
   .atmosphere::after 覆盖掉了，现在恢复）。
   --------------------------------------------------------------------------- */
.atmosphere {
  filter: none;
}
.atmosphere::before {
  /* 显式写 none：证明"这里确实被清空了"，而不是"忘了写一层"。 */
  background: none;
}`;

L.splice(949, 981 - 950 + 1);                 /* ③ 台面液团/caustic/halo */
L.splice(784, 799 - 785 + 1);                 /* .atmosphere::after */
L.splice(711, 784 - 712 + 1, ...ATMOS.split('\n'));  /* .atmosphere::before */
L.splice(706, 711 - 707 + 1);                 /* .atmosphere 本体 */

let T = L.join('\n');

/* ---- ④ L1 边缘栈：R80-SPEC §2.3 五档（原文值） ---- */
const OLD_SHADOW_START = '  box-shadow:\n    /* ① 贴边镜面环 N≈1.00';
const i0 = T.indexOf(OLD_SHADOW_START);
assert(i0 > 0, '未找到 L1 box-shadow 段首');
const i1 = T.indexOf('  backdrop-filter: blur(13px) saturate(160%);', i0);
assert(i1 > i0, '未找到 L1 backdrop-filter');
const NEW_SHADOW = `  /* ★ R80-SPEC §2.3：菲涅尔五档（值取自规范原文，不是本轮的判断）。
     内侧 14px 过渡带，从内到外逐档提升亮度：14/9/5/2/1px 五道 0-blur 环。
     和改前的区别不是"更好看"，而是**形状对**：高斯内阴影把亮度摊平在 26px 里，
     而物理上法线在 d=r/8 以内就吃掉 90% 的反射变化（θ=arccos(d/r)）。
     层序 = 绘制顺序，第一道在最上 ⇒ 1px 那道必须是最后写、最亮的 .32。 */
  box-shadow:
    inset 0 0 0 14px var(--lg-fres-5),
    inset 0 0 0 9px var(--lg-fres-4),
    inset 0 0 0 5px var(--lg-fres-3),
    inset 0 0 0 2px var(--lg-fres-2),
    inset 0 0 0 1px var(--lg-fres-1),
    /* 顶部高光（WWDC26 方向：光从正上方来，不是左上角） */
    inset 0 1px 0 var(--lg-top-hl),
    /* 侧边压暗：玻璃两侧是"厚度"最厚的地方，压一道极窄的暗边才立得起来 */
    inset 1px 0 0 var(--lg-side-dark),
    inset -1px 0 0 var(--lg-side-dark),
    /* 1px 内描边 */
    inset 0 0 0 1px var(--lg-inner-line),
    0 20px 44px -18px var(--lg-l1-shadow);
`;
T = T.slice(0, i0) + NEW_SHADOW + T.slice(i1);

/* ---- ⑤ 删除 R79 的位移规则（折射规格作废，OpticsLens 代码保留但不落地） ---- */
const dStart = T.indexOf('/* ---------------------------------------------------------------------------\n   3.1 R79 一阶段 · 位移层（真实折射）');
assert(dStart > 0, '未找到 3.1 位移层段首');
const dEnd = T.indexOf('/* ---------------------------------------------------------------------------\n   4. 控件', dStart);
assert(dEnd > dStart, '未找到 3.1 之后的分节锚点');
T = T.slice(0, dStart) + `/* ---------------------------------------------------------------------------
   3.1 R79 位移层 —— @deprecated R79
   ---------------------------------------------------------------------------
   这里原来有两条 \`html[data-optics="displace"] .rail-left.glass\` 规则，给左栏与
   成本光带叠加 \`url(#lg-lens)\` 做真实折射位移。**R79 的折射规格已作废**（玻璃只剩
   一处、做法换了），所以两条规则删除，位移不再落地。
   scripts/main.js 里的 OpticsLens（位移图生成 + 运行时像素探测）与 index.html 里的
   内联 <filter id="lg-lens"> **保留不删** —— 只增不删是项目铁律，而且第二批重做
   左栏玻璃时大概率还要用它。它现在只做一件无害的事：探测能力并写
   html[data-optics]，没有任何选择器消费这个属性。
   --------------------------------------------------------------------------- */

` + T.slice(dEnd);

/* ---- ③ 右栏 / 底条关玻璃 ---- */
const SPLIT_ANCHOR = `/* ---------------------------------------------------------------------------
   4. 控件`;
const SOLID_RULES = `/* ---------------------------------------------------------------------------
   3.2 R80 第一步 · 关掉两处玻璃（SPEC §2.1「必须关闭玻璃的三个元素」）
   ---------------------------------------------------------------------------
   #observerWindow：右栏是"高度半透明的密集持久数据"——微软明令禁止的组合，
     而且它是 320px 宽的检视器，让背后的东西透过来只会让读数更难读。
   #glass-ribbon：底部成本光带是常驻读数，同属密集数据 ⇒ 实心。
   ★ #mainStage 本轮**保持玻璃**：用户新要求是「液态厚玻璃磨砂 + 透色桌面」，
     参数等第二批。所以这里刻意只列这两个选择器，不要顺手把 .stage 一起关掉。
   特异性：\`.observer-window.enamel\`(0,2,0) 压过 \`.stage, .observer-window.enamel\`(0,1,0)；
   暗档那条 (0,3,0) 与既有暗档规则同权但在这之后 ⇒ 后写者胜。
   --------------------------------------------------------------------------- */
.observer-window.enamel,
[data-theme="dark"] .observer-window.enamel {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  background-color: var(--color-surface);
}
.cost-dock.glass,
[data-theme="dark"] .cost-dock.glass {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  background-color: var(--color-surface);
  background-image: none;
}

`;
T = T.replace(SPLIT_ANCHOR, SOLID_RULES + SPLIT_ANCHOR);

/* ---- ⑥ .msg 结构分层 ---- */
const MSG_ANCHOR = `.msg {
  /* 只允许"放不下时断词"，**不能用 \`anywhere\`**。`;
assert(T.indexOf(MSG_ANCHOR) > 0, '未找到 .msg 断词规则锚点');
const MSG_LAYER = `/* ---------------------------------------------------------------------------
   R80 · .msg 结构分层（为第二批的材质参数预留接缝）
   ---------------------------------------------------------------------------
   用户要求对话气泡「跟导航栏一样的液态玻璃」，同时「文字以深黑色显示」。
   这两条能同时成立的前提是**层分离**：
     容器层 .msg      ← 唯一承担材质（背景 / 描边 / 投影 / 将来的 backdrop-filter）
     内容层 .msg > *  ← 纯文字与结构，**永远不带 filter / backdrop-filter / blend**
   为什么写死：filter 会创建 containing block 并把子元素一起放进同一张离屏位图，
   文字一旦落进去就会被一起模糊或位移 —— 这正是上一版"正文发虚"的根因。
   \`isolation: isolate\` 让容器自成一个层叠上下文，将来加 backdrop-filter 时
   不会把台面的背景采样串到兄弟节点上。
   材质参数的**唯一入口**是下面四个自定义属性：第二批只改令牌，选择器一行不动。
   --------------------------------------------------------------------------- */
.msg {
  position: relative;
  isolation: isolate;
  --msg-material-fill: var(--lg-l3-fill-on-l2);
  --msg-material-blur: 0px;
  --msg-material-sat: 100%;
  --msg-material-edge: var(--lg-l3-topline);
  color: var(--text-primary);
  /* 本批不加材质：blur(0px) 会让计算值不再是 'none'，LG-01「卡片层零 blur」立刻翻红。 */
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
.msg > * {
  /* 内容层：这四条是硬约束，不是优化。任何一条被改都会让文字参与材质的离屏位图。 */
  filter: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  mix-blend-mode: normal;
}

`;
T = T.replace(MSG_ANCHOR, MSG_LAYER + MSG_ANCHOR);

save(VIEWS, T, V.crlf);
console.log('views.css 改写完成');

/* ============================================================ tokens.css */
let K = load(TOKENS);
let KX = K.text;

/* 五档菲涅尔 + 顶部高光 + 侧边压暗 + 内描边 → SPEC §2.3 的值 */
const tokSwaps = [
  ['  --lg-fres-1: rgba(255, 255, 255, .96);', '  --lg-fres-1: rgba(255, 255, 255, .32);'],
  ['  --lg-fres-2: rgba(255, 255, 255, .52);', '  --lg-fres-2: rgba(255, 255, 255, .15);'],
  ['  --lg-fres-3: rgba(255, 255, 255, .25);', '  --lg-fres-3: rgba(255, 255, 255, .072);'],
  ['  --lg-fres-4: rgba(255, 255, 255, .07);', '  --lg-fres-4: rgba(255, 255, 255, .030);'],
  ['  --lg-fres-1: rgba(255, 255, 255, .62);', '  --lg-fres-1: rgba(255, 255, 255, .20);'],
  ['  --lg-fres-2: rgba(255, 255, 255, .30);', '  --lg-fres-2: rgba(255, 255, 255, .10);'],
  ['  --lg-fres-3: rgba(255, 255, 255, .14);', '  --lg-fres-3: rgba(255, 255, 255, .048);'],
  ['  --lg-fres-4: rgba(255, 255, 255, .04);', '  --lg-fres-4: rgba(255, 255, 255, .020);'],
];
for (const [a, b] of tokSwaps) {
  assert(KX.split(a).length - 1 === 1, '令牌替换命中数不为 1：' + a.trim());
  KX = KX.replace(a, b);
}
/* 明档追加第 5 档 + 三个方向令牌（暗档各一份） */
KX = KX.replace(
  '  --lg-fres-top: rgba(255, 255, 255, .34);',
  '  --lg-fres-5: rgba(255, 255, 255, .012);  /* d≈14px · SPEC §2.3 最外一档 */\n' +
  '  --lg-top-hl: rgba(255, 255, 255, .42);   /* 顶部高光 .42 / 失焦 .18（§2.4） */\n' +
  '  --lg-side-dark: rgba(0, 0, 0, .10);      /* 侧边压暗：厚度最厚的地方 */\n' +
  '  --lg-inner-line: rgba(0, 0, 0, .10);     /* 1px 内描边（明档黑描边） */\n' +
  '  --lg-fres-top: rgba(255, 255, 255, .34);'
);
KX = KX.replace(
  '  --lg-fres-top: rgba(255, 255, 255, .20);',
  '  --lg-fres-5: rgba(255, 255, 255, .010);\n' +
  '  --lg-top-hl: rgba(255, 255, 255, .18);\n' +
  '  --lg-side-dark: rgba(0, 0, 0, .18);\n' +
  '  --lg-inner-line: rgba(255, 255, 255, .12);  /* 暗档内描边转白 */\n' +
  '  --lg-fres-top: rgba(255, 255, 255, .20);'
);
save(TOKENS, KX, K.crlf);
console.log('tokens.css 改写完成');
