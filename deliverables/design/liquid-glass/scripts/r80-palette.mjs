/* ============================================================================
   R80 第一批 · tokens.css 重写脚本（一次性，幂等：重复跑不会二次插入）
   内容：
     ① 插入 R80 色板（明/暗两套，取自 R80-SPEC.md §3，值一字不改）
     ② 把既有 --color-* 语义令牌**指到**色板（不改选择器、不改调用点）
     ③ 字号 11 档 → 6 档（+代码 1 档），旧名用 var() 别名指过来
     ④ 圆角 7 种 → 4 种，旧名同样用别名
     ⑤ 把旧的苔绿强调色 rgba(122,84,16,·) / 暗档金 rgba(216,169,78,·) 换成
        rgba(var(--accent-rgb),·)，苔绿黑阴影 rgba(72,46,10,·) 换成近中性炭
   为什么用脚本而不是手改：tokens.css 是 CRLF + 983 行 + 注释密度极高，
   手工替换极易漏行；脚本按键名作用域改写，可复核（会打印改写条数）。
   ============================================================================ */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(HERE, '..', 'styles', 'tokens.css');
let src = readFileSync(FILE, 'utf8');
const nl = src.includes('\r\n') ? '\r\n' : '\n';
const lines = src.split(nl);

/* ---------------------------------------------------------------- ① 色板 */
const LIGHT_PALETTE = [
  '  /* ======================================================================',
  '     R80 色板（明档）—— R80-SPEC.md §3，值一字不改',
  '     ----------------------------------------------------------------------',
  '     [对标] 取自 Anthropic 品牌规范：暖中性，never pure white / never pure black /',
  '     never cool grays。三级明度阶梯 canvas > panel > sunken 是分层的唯一手段，',
  '     不靠模糊、不靠投影（见 SPEC §6）。',
  '     [实测] 强调色原值 #D97757 在明档作文字只有 2.96:1 ⇒ 文字必须用 #C0502B（4.51），',
  '     #D97757 只作背景/图形。这两个值是用 WCAG 公式反解出来的，不要自行微调。',
  '     ====================================================================== */',
  '  --bg-canvas: #FAF9F5;    /* 窗口底（一级） */',
  '  --bg-panel: #F0EEE6;     /* 面板 / 侧栏 / 主台面（二级） */',
  '  --bg-sunken: #E8E6DC;    /* 输入框、凹陷区（三级 · 明档里最暗） */',
  '  --line-hair: #D1CFC5;    /* 1px 发丝线（1.34:1，分隔线专用，不得作控件边界） */',
  '  --text-primary: #141413; /* 主文本 17.5 / 15.87 / 14.73 */',
  '  --text-muted: #5E5D59;   /* 次要文本 6.26 / 5.67 / 5.27 */',
  '  --accent-text: #C0502B;  /* 强调色作文字 4.51 */',
  '  --accent-fill: #D97757;  /* 强调色作背景/图形（配 #141413 文字 5.90） */',
  '  --cost-80: #8D6522;      /* 成本 80% 档 4.50 */',
  '  --cost-100: #B53333;     /* 成本 100% 档 5.19 */',
  '  --accent-rgb: 192, 80, 43;  /* = --accent-text 的三元组，供 rgba(var(--accent-rgb), α) */',
  '  --accent-fill-rgb: 217, 119, 87;',
  '  --scrim-rgb: 20, 20, 19;    /* = --text-primary，投影/描边只允许中性炭 */',
];

const DARK_PALETTE = [
  '  /* ---- R80 色板（暗档）----',
  '     明暗两套**不共用**：暗档强调色可以同时作文字与背景（5.90 / 5.34），',
  '     明档不行（#D97757 作文字只有 2.96）—— 这是两套值而不是一套带亮度插值的原因。 */',
  '  --bg-canvas: #141413;',
  '  --bg-panel: #1F1E1C;',
  '  --bg-sunken: #141413;',
  '  --bg-card: #30302E;',
  '  --line-hair: #3A3936;',
  '  --text-primary: #F5F4ED;',
  '  --text-muted: #B0AEA5;',
  '  --accent-text: #D97757;',
  '  --accent-fill: #D97757;',
  '  --cost-80: #C08A2E;',
  '  --cost-100: #D36262;',
  '  --accent-rgb: 217, 119, 87;',
  '  --accent-fill-rgb: 217, 119, 87;',
  '  --scrim-rgb: 8, 8, 8;',
];

/* -------------------------------------------------- ② 语义令牌 → 色板 */
const MAP_LIGHT = {
  '--color-bg': 'var(--bg-canvas)',
  '--color-surface': 'var(--bg-panel)',
  '--color-raised': 'var(--bg-canvas)',
  '--color-code-bg': 'var(--bg-sunken)',
  '--color-text': 'var(--text-primary)',
  '--color-muted': 'var(--text-muted)',
  /* 三级文字在 R80 收敛为两级：faint 直接用 muted（更暗 ⇒ 对比度单向改善） */
  '--color-faint': 'var(--text-muted)',
  '--color-accent': 'var(--accent-text)',
  '--color-accent-ink': 'var(--bg-canvas)',
  '--color-accent-soft': 'var(--bg-sunken)',
  '--color-ok': 'var(--text-muted)',
  '--color-ok-bg': 'var(--bg-sunken)',
  '--color-warn': 'var(--cost-80)',
  '--color-warn-bg': 'var(--bg-sunken)',
  '--color-err': 'var(--cost-100)',
  '--color-err-bg': 'var(--bg-sunken)',
  '--color-run': 'var(--text-muted)',
  '--color-run-bg': 'var(--bg-sunken)',
  '--color-control-border': 'var(--text-muted)',
  '--color-hairline': 'var(--line-hair)',
  '--color-border': 'var(--line-hair)',
  '--color-focus': 'var(--accent-fill)',
};
const MAP_DARK = {
  '--color-bg': 'var(--bg-canvas)',
  '--color-surface': 'var(--bg-panel)',
  '--color-raised': 'var(--bg-card)',
  '--color-code-bg': 'var(--bg-canvas)',
  '--color-text': 'var(--text-primary)',
  '--color-muted': 'var(--text-muted)',
  '--color-faint': 'var(--text-muted)',
  '--color-accent': 'var(--accent-text)',
  '--color-accent-ink': 'var(--bg-canvas)',
  '--color-accent-soft': 'var(--bg-card)',
  '--color-ok': 'var(--text-muted)',
  '--color-ok-bg': 'var(--bg-card)',
  '--color-warn': 'var(--cost-80)',
  '--color-warn-bg': 'var(--bg-card)',
  '--color-err': 'var(--cost-100)',
  '--color-err-bg': 'var(--bg-card)',
  '--color-run': 'var(--text-muted)',
  '--color-run-bg': 'var(--bg-card)',
  '--color-control-border': 'var(--text-muted)',
  '--color-hairline': 'var(--line-hair)',
  '--color-border': 'var(--line-hair)',
  '--color-focus': 'var(--accent-fill)',
};

/* --------------------------------------------- ③④ 字号 / 圆角 新块 */
const FS_BLOCK = [
  '  /* ---- R80 字号：11 档 → 6 档（+ 代码 1 档）----',
  '     只允许 {11, 12.5, 13, 14, 15, 17, 22}；10px 及以下全站 0 处。',
  '     做法：档位令牌只定义一次，旧名一律 var() 指过来 —— 100+ 个调用点一行不改，',
  '     档位收敛是**结构性**的，而不是"记得别用 18px"。 */',
  '  --fs-small: 11px;  --lh-small: 14px;   /* 仅时间戳 / 字数 / 快捷键 */',
  '  --fs-ui: 13px;     --lh-ui: 18px;      /* 按钮、导航、标签、表单 */',
  '  --fs-body: 14px;   --lh-body: 22px;    /* 对话正文、AI 回复 */',
  '  --fs-h3: 15px;     --lh-h3: 20px;',
  '  --fs-h2: 17px;     --lh-h2: 22px;',
  '  --fs-h1: 22px;     --lh-h1: 28px;',
  '  --fs-code: 12.5px; --lh-code: 20px;',
  '  /* 旧名 → 新档（别名只此一处，别再往下写数值） */',
  '  --fs-micro: var(--fs-small);',
  '  --fs-caption: var(--fs-ui);',
  '  --fs-lead: var(--fs-h2);',
  '  --fs-display: var(--fs-h1);',
  '  --fs-flash: var(--fs-h1);',
  '  --fs-stage: var(--fs-h1);',
  '  --lh-tight: 1.12;',
];

const R_BLOCK = [
  '  /* ---- R80 圆角：7 种 → 4 种 ----',
  '     同心公式 r_inner = max(r_outer − inset, 8)：窗口 16 − 4 = 面板 12，面板 12 − 4 = 控件 8。',
  '     删除 2 / 14 / 22 / 30 / 50。`9999` 只能用于高度 ≤36px 的胶囊。 */',
  '  --r-window: 16px;',
  '  --r-panel: 12px;',
  '  --r-control: 8px;',
  '  --r-pill: 9999px;',
  '  /* 旧名 → 新档 */',
  '  --r-sm: var(--r-control);',
  '  --r-md: var(--r-panel);',
  '  --r-lg: var(--r-window);',
  '  --r-xl: var(--r-window);',
  '  /* 主舞台破格缺角：16/16/12/16（原来是 30/30/12/30，30 已删除） */',
  '  --r-asym: var(--r-window) var(--r-window) var(--r-panel) var(--r-window);',
];

/* ================================================================ 执行 */
let scope = 'other';
let counts = { light: 0, dark: 0, fs: 0, r: 0 };
const out = [];
let i = 0;
while (i < lines.length) {
  const line = lines[i];

  if (/^:root\s*\{/.test(line)) { scope = 'light'; out.push(line); i++; continue; }
  if (/^\[data-theme="dark"\]\s*\{/.test(line)) { scope = 'dark'; out.push(line); i++; continue; }
  if (/^\}/.test(line)) {
    if (scope === 'light') { out.push(...LIGHT_PALETTE); counts.light++; }
    if (scope === 'dark') { out.push('', ...DARK_PALETTE); counts.dark++; }
    scope = 'other';
    out.push(line); i++; continue;
  }

  /* 字号块整体替换：从 --fs-micro 起，吃掉旧的 10 行 */
  if (/^\s*--fs-micro:/.test(line)) {
    out.push(...FS_BLOCK);
    counts.fs++;
    let j = i;
    while (j < lines.length && !/^\s*--lh-tight:/.test(lines[j])) j++;
    i = j + 1;              /* 跳过旧的 --lh-tight（新块里已经有一份） */
    continue;
  }
  /* 圆角块整体替换：从 --r-sm 起，吃到 --r-asym */
  if (/^\s*--r-sm:/.test(line)) {
    out.push(...R_BLOCK);
    counts.r++;
    let j = i;
    while (j < lines.length && !/^\s*--r-asym:/.test(lines[j])) j++;
    i = j + 1;
    continue;
  }

  /* 语义令牌改写 */
  const m = line.match(/^(\s*)(--[a-z-]+):\s*(.*)$/);
  if (m && (scope === 'light' || scope === 'dark')) {
    const map = scope === 'light' ? MAP_LIGHT : MAP_DARK;
    if (map[m[2]]) {
      /* ★ 注释必须搬到位：分号要写在注释**之前**，否则分号落进注释里，
         整条声明失效且浏览器零告警（这条注释本身不能在正文里写嵌套的块注释括弧）。 */
      const comment = m[3].includes('/*') ? '  ' + m[3].slice(m[3].indexOf('/*')) : '';
      out.push(m[1] + m[2] + ': ' + map[m[2]] + ';' + comment);
      if (scope === 'light') counts.lightMap = (counts.lightMap || 0) + 1;
      else counts.darkMap = (counts.darkMap || 0) + 1;
      i++; continue;
    }
  }

  out.push(line); i++;
}

let next = out.join(nl);

/* ------------------------------------- ⑤ 旧色相清除（苔绿/金 → 强调色） */
const swaps = [
  ['rgba(122, 84, 16, ', 'rgba(var(--accent-rgb), '],
  ['rgba(216, 169, 78, ', 'rgba(var(--accent-rgb), '],
  ['rgba(72, 46, 10, ', 'rgba(var(--scrim-rgb), '],
  ['rgba(18, 20, 24, ', 'rgba(var(--scrim-rgb), '],
  ['rgba(24, 26, 30, ', 'rgba(var(--scrim-rgb), '],
];
let swapCount = 0;
for (const [a, b] of swaps) {
  const n = next.split(a).length - 1;
  swapCount += n;
  next = next.split(a).join(b);
}

/* 头部注释同步：色值事实源仍是本文件，但"只此一处"现在指的是色板块 */
next = next.replace(
  '色值只在本文件定义一次（:root 明 + [data-theme="dark"] 暗）。',
  '色值只在本文件定义一次：R80 色板块（:root 明 + [data-theme="dark"] 暗），\r\n           其余令牌与所有选择器一律 var()。'
);

writeFileSync(FILE, next);
console.log('改写完成：', JSON.stringify(counts), '旧色相替换', swapCount, '处');
if (counts.light !== 1 || counts.dark !== 1 || counts.fs !== 1 || counts.r !== 1) {
  console.error('⚠ 插入次数异常，请检查锚点');
  process.exitCode = 1;
}
