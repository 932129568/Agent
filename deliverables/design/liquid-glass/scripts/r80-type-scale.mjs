/* R80 第一批 · 字号/圆角收口（把漏网的 12px / 10px / 2px 圆角收进 6 档 / 4 种） */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const P = n => resolve(HERE, '..', 'styles', n);
const assert = (c, m) => { if (!c) { console.error('✗ ' + m); process.exit(1); } };
const load = f => { const raw = readFileSync(P(f), 'utf8'); return { crlf: raw.includes('\r\n'), t: raw.includes('\r\n') ? raw.replace(/\r\n/g, '\n') : raw }; };
const save = (f, t, crlf) => writeFileSync(P(f), crlf ? t.replace(/\n/g, '\r\n') : t);

/* ---- tokens.css：--fs-micro 默认收敛到 UI 档，另开 --fs-meta 显式申请 11px ---- */
let K = load('tokens.css');
const a = '  --fs-micro: var(--fs-small);';
assert(K.t.includes(a), '--fs-micro 别名未命中');
K.t = K.t.replace(a,
  '  /* R80 · 默认值收敛：--fs-micro 现在指向 **UI 档 13px**。\n' +
  '     原因：58 个 11px 里绝大多数是分组名 / 标签 / 开关文字，按 SPEC §4 它们\n' +
  '     属于 UI 档；11px 只留给时间戳 / 字数 / 快捷键。\n' +
  '     需要 11px 的地方必须显式写 --fs-meta（views.css 末尾有白名单）。 */\n' +
  '  --fs-micro: var(--fs-ui);\n' +
  '  --fs-meta: var(--fs-small);');
save('tokens.css', K.t, K.crlf);

/* ---- components.css：12px → 代码档 12.5；两处 2px 圆角 → pill ---- */
let C = load('components.css');
const cEdits = [
  ['.chart-slab .value-label { fill: var(--color-text); font-family: var(--font-data); font-size: 12px; }',
    '.chart-slab .value-label { fill: var(--color-text); font-family: var(--font-data); font-size: var(--fs-code); }'],
  ['  width: 6px; height: 2px; border-radius: 2px;',
    '  width: 6px; height: 2px; border-radius: var(--r-pill);  /* 6×2 的刻度块：高度 2 ≤ 36，走胶囊 */'],
  ['  border-radius: 2px 2px 0 0;',
    '  border-radius: var(--r-pill) var(--r-pill) 0 0;  /* 时序条：高度 34%~100% 的 26px，走胶囊 */'],
];
for (const [x, y] of cEdits) { assert(C.t.includes(x), 'components 锚点未命中：' + x.slice(0, 40)); C.t = C.t.replace(x, y); }
save('components.css', C.t, C.crlf);

/* ---- views.css：10px → Small 档；竖标记 2px → pill；末尾追加 11px 白名单 ---- */
let V = load('views.css');
const vEdits = [
  ['.budget-ring .ring-caption { fill: var(--color-faint); font-family: var(--font-data); font-size: 10px; }',
    '.budget-ring .ring-caption { fill: var(--color-faint); font-family: var(--font-data); font-size: var(--fs-small); }'],
  ['  width: 3px;\n  border-radius: 2px;\n  background: var(--color-control-border);',
    '  width: 3px;\n  border-radius: var(--r-pill);\n  background: var(--color-control-border);'],
];
for (const [x, y] of vEdits) { assert(V.t.includes(x), 'views 锚点未命中：' + x.slice(0, 40)); V.t = V.t.replace(x, y); }

V.t += `

/* ============================================================================
   R80 · 11px（Small 档）的**唯一合法去处**
   ----------------------------------------------------------------------------
   SPEC §4：11px 只允许出现在时间戳、字数、快捷键提示；**不允许**出现在任何
   可点击控件或消息正文。实测改前全站 58 个 11px 元素里，多数是分组名 / 标签 /
   开关文字 —— 它们属于 UI 档，所以 --fs-micro 已整体收敛到 13px。
   只有下面这几类显式回落到 11px。
   ★ 为什么用白名单而不是逐个改 58 处：默认值收敛之后，"想用 11px"必须显式申请，
     下一个人加 11px 时会先撞到这行注释，而不是顺手抄一个 --fs-micro。
   ★ 放在 views.css 末尾（最后加载）：.msg-meta / .tok 在 components.css 里
     有同特异性的 font-size，只有在这里声明才能按文件顺序压过它们。
   ============================================================================ */
time,
.msg-meta,
.msg-meta *,
.tok,
#tokenValue,
#sheetTokens,
.ribbon-readout .tok,
kbd,
.kbd { font-size: var(--fs-small); }
`;
save('views.css', V.t, V.crlf);
console.log('字号 / 圆角收口完成');
