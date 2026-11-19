/* R80 第一批 · 把台面/玻璃填充从「24h 光照插值」换成 R80 固定色
   （sun.js 的通道不再被消费；多行 calc 声明没法用单行锚点替换，故用区间手术） */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(HERE, '..', 'styles', 'tokens.css');
const raw = readFileSync(FILE, 'utf8');
const crlf = raw.includes('\r\n');
const lines = (crlf ? raw.replace(/\r\n/g, '\n') : raw).split('\n');

const assert = (c, m) => { if (!c) { console.error('✗ ' + m); process.exit(1); } };

/* 找到每个区间：从锚点行开始，向下找到第一条以 `));` 或 `;` 结尾且以 `/ calc(` 或数值结束的行 */
function block(startAnchor, out) {
  const i = lines.findIndex((l, k) => k > (block.cursor || 0) && l.trim().startsWith(startAnchor));
  assert(i >= 0, '未找到锚点：' + startAnchor);
  let j = i;
  while (j < lines.length && !/^[^\/]*\)\);\s*$|^\s*\.\.\.|^\s*\/ calc\(.*\)\);\s*$/.test(lines[j])) j++;
  assert(j < lines.length, '未找到区间结尾：' + startAnchor);
  block.cursor = j;
  return [i, j];
}

block.cursor = 0;
const r1 = block('--lg-l1-fill: rgb(');
const r2 = block('--lg-l2-fill: rgb(');
/* 暗档两个：暗档的 l1 是单行 rgba，单独处理 */
const darkL1 = lines.findIndex((l, k) => k > r2[1] && l.trim().startsWith('--lg-l1-fill: rgba('));
assert(darkL1 > 0, '未找到暗档 --lg-l1-fill');
const darkL2Start = lines.findIndex((l, k) => k > darkL1 && l.trim().startsWith('--lg-l2-fill: rgb('));
assert(darkL2Start > 0, '未找到暗档 --lg-l2-fill');
let darkL2End = darkL2Start;
while (darkL2End < lines.length && !/\/ calc\(.*\)\);\s*$/.test(lines[darkL2End])) darkL2End++;
assert(darkL2End > darkL2Start, '未找到暗档 --lg-l2-fill 结尾');

const L1 = [
  '  /* ---- R80 · 左栏玻璃填充（SPEC §2.1：明 rgba(250,249,245,.82)）----',
  '     原来这里是三条 calc 通道（R/G/B 各自随太阳高度插值），是 24 小时光照模型的产物。',
  '     模型作废后改成固定值；"温度感"改由色板本身承担 —— #FAF9F5 是暖白而不是冷白。',
  '     ★ 与窗口的关系：贴左、上、下三边（不贴右），这是 SPEC §2.1 的硬要求。 */',
  '  --lg-l1-fill: rgba(250, 249, 245, .82);',
];

const L2 = [
  '  /* ---- R80 · 中栏/右栏台面填充 ----',
  '     用户要求中栏「液态厚玻璃磨砂 + 透色桌面」，所以保留 .90 这个"厚釉"alpha：',
  '     既不是实心（那就不透色了），也不降到会透出字的程度。',
  '     右栏 #observerWindow 已单独改成实心 --color-surface（views.css §3.2）——',
  '     一个窗口只能有一个 backdrop 面，右栏是密集读数，不参与玻璃叙事。 */',
  '  --lg-l2-fill: rgba(240, 238, 230, .90);',
];

/* 从下往上替换，避免行号位移 */
lines.splice(darkL2Start, darkL2End - darkL2Start + 1,
  '  /* R80 暗档台面填充：暖黑（never pure black）#1F1E1C，厚釉 .86 */',
  '  --lg-l2-fill: rgba(31, 30, 28, .86);');
lines.splice(darkL1, 1, '  /* R80 暗档左栏玻璃填充（SPEC §2.1：暗 rgba(20,20,19,.78)） */', '  --lg-l1-fill: rgba(20, 20, 19, .78);');
lines.splice(r2[0], r2[1] - r2[0] + 1, ...L2);
lines.splice(r1[0], r1[1] - r1[0] + 1, ...L1);

writeFileSync(FILE, lines.join(crlf ? '\r\n' : '\n'));
console.log('填充令牌改写完成');
