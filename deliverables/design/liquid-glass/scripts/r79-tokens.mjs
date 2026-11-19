/* R79：把"色散 / 氛围"这一类令牌从写死色改为**光驱动**（引用 sun.js 写的 *-rgb 三元组），
   并为 24h 光模型补上带静态兜底的通道令牌。alpha 仍留在 CSS（明暗两档不同），
   RGB 交给光 —— 这样"黄昏变琥珀、夜里变银蓝"不需要在 CSS 里写任何 if。 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'C:/Users/陈/Desktop/GLM-Chat-v1.0.0-完整开发包/deliverables/design/liquid-glass/styles/tokens.css';
let s = readFileSync(FILE, 'utf8');

/* 1. 色散类：RGB 交给光，alpha 留在主题里 */
const PAIRS = [
  ['  --atmo-1: rgba(226, 196, 150, calc(.44 * (1 - var(--sun-warm, 0) * .72)));  /* 苔绿 ~154° */',
    '  --atmo-1: rgba(var(--atmo-1-rgb, 226, 196, 150), calc(.44 * (1 - var(--sun-warm, 0) * .72)));  /* 主光色（随时刻） */'],
  ['  --atmo-2: rgba(255, 168, 92, calc(.30 + var(--sun-warm, 0) * .26));         /* 琥珀 ~32°，随晨昏升起 */',
    '  --atmo-2: rgba(var(--atmo-2-rgb, 255, 168, 92), calc(.30 + var(--sun-warm, 0) * .26));         /* 暖侧（晨昏升起） */'],
  ['  --atmo-3: rgba(216, 218, 220, calc(.34 * (1 - var(--sun-warm, 0) * .55))); /* 中性雾白 */',
    '  --atmo-3: rgba(var(--atmo-3-rgb, 216, 218, 220), calc(.34 * (1 - var(--sun-warm, 0) * .55))); /* 中性底雾（不染色） */'],
  ['  --lg-fringe-l: rgba(236, 200, 132, .74);    /* 左壁色散带（青） */',
    '  --lg-fringe-l: rgba(var(--disp-a-rgb, 236, 200, 132), .74);   /* 左壁色散带（暖侧，随光温变） */'],
  ['  --lg-fringe-r: rgba(112, 156, 255, .70);   /* 右壁色散带（蓝） */',
    '  --lg-fringe-r: rgba(var(--disp-b-rgb, 112, 156, 255), .70);  /* 右壁色散带（冷侧，随月光变） */'],
  ['  --lg-rim-cyan: rgba(238, 204, 140, .58);  /* 色散·青（左上内侧 1px 环） */',
    '  --lg-rim-cyan: rgba(var(--disp-a-rgb, 238, 204, 140), .58);  /* 色散·暖侧（左上内侧 1px 环） */'],
  ['  --lg-rim-blue: rgba(132, 176, 255, .50);  /* 色散·蓝（右下内侧 1px 环） */',
    '  --lg-rim-blue: rgba(var(--disp-b-rgb, 132, 176, 255), .50);  /* 色散·冷侧（右下内侧 1px 环） */'],
  ['  --lg-l1-caustic-a: rgba(246, 214, 150, .60);     /* 折射色散·青（左） */',
    '  --lg-l1-caustic-a: rgba(var(--disp-a-rgb, 246, 214, 150), .60);     /* 折射色散·暖侧（左） */'],
  ['  --lg-l1-caustic-b: rgba(148, 190, 255, .55);     /* 折射色散·蓝（右） */',
    '  --lg-l1-caustic-b: rgba(var(--disp-b-rgb, 148, 190, 255), .55);     /* 折射色散·冷侧（右） */'],
  ['  --lg-l2-fringe-l: rgba(236, 200, 132, .55);',
    '  --lg-l2-fringe-l: rgba(var(--disp-a-rgb, 236, 200, 132), .55);'],
  ['  --lg-l2-fringe-r: rgba(112, 156, 255, .58);',
    '  --lg-l2-fringe-r: rgba(var(--disp-b-rgb, 112, 156, 255), .58);'],
  /* 暗档：同源，只换 alpha */
  ['  --lg-l1-caustic-a: rgba(240, 196, 120, .22);',
    '  --lg-l1-caustic-a: rgba(var(--disp-a-rgb, 240, 196, 120), .22);'],
  ['  --lg-l1-caustic-b: rgba(120, 170, 255, .20);',
    '  --lg-l1-caustic-b: rgba(var(--disp-b-rgb, 120, 170, 255), .20);'],
  ['  --lg-rim-cyan: rgba(236, 200, 132, .24);',
    '  --lg-rim-cyan: rgba(var(--disp-a-rgb, 236, 200, 132), .24);'],
  ['  --lg-rim-blue: rgba(120, 165, 255, .22);',
    '  --lg-rim-blue: rgba(var(--disp-b-rgb, 120, 165, 255), .22);'],
  ['  --lg-l2-fringe-l: rgba(238, 204, 140, .16);',
    '  --lg-l2-fringe-l: rgba(var(--disp-a-rgb, 238, 204, 140), .16);'],
  ['  --lg-l2-fringe-r: rgba(112, 156, 255, .16);',
    '  --lg-l2-fringe-r: rgba(var(--disp-b-rgb, 112, 156, 255), .16);'],
  ['  --lg-fringe-l: rgba(238, 204, 140, .30);',
    '  --lg-fringe-l: rgba(var(--disp-a-rgb, 238, 204, 140), .30);'],
  ['  --lg-fringe-r: rgba(112, 156, 255, .28);',
    '  --lg-fringe-r: rgba(var(--disp-b-rgb, 112, 156, 255), .28);']
];
const miss = [];
for (const [a, b] of PAIRS) {
  if (!s.includes(a)) { miss.push(a.trim()); continue; }
  s = s.replace(a, b);
}

/* 2. 24h 光模型：通道令牌 + 几何标量（静态兜底 = 正午白金，无 JS 时不崩） */
const LIGHT_MODEL = `
  /* ========================================================================
     R79 · 24 小时自然光模型（Daylight Instrument）
     ------------------------------------------------------------------------
     分层：**界面本体无色相，全部色相只来自光**。
       · 上方 --color-* 是中性石灰白 / 石墨黑，一轮 24h 都不变色；
       · 本段是"光"的通道：太阳色、月亮色、色散双色、光斑与光晕；
       · sun.js 每 500ms 把真实时刻写进这些通道（全是 h 的 C¹ 函数），
         CSS 只负责消费，不写任何 if/else。
     为什么用 *-rgb 三元组而不是整条 rgba()：
       明暗两档的 alpha 不同（夜间的光必须更淡），三元组让 RGB 由光决定、
       alpha 由主题决定，两边各管一段，不需要在暗档重抄一遍色相。
     静态兜底 = 正午白金（最中性的一档）：无 JS / 无 queryHour 时页面不崩。
     ======================================================================== */
  --sun-h: 46; --sun-s: 16; --sun-l: 92;          /* 太阳光色（不透明体） */
  --moon-h: 215; --moon-s: 14; --moon-l: 84;      /* 月光（冷银蓝） */
  --moon-w: 0;                                     /* 月亮权重 0..1 */
  --sun-rgb: 250, 246, 236;
  --moon-rgb: 214, 222, 236;
  --atmo-1-rgb: 226, 196, 150;
  --atmo-2-rgb: 255, 168, 92;
  --atmo-3-rgb: 216, 218, 220;
  --disp-a-h: 48; --disp-a-s: 62; --disp-a-l: 66;  /* 色散暖侧 */
  --disp-b-h: 210; --disp-b-s: 58; --disp-b-l: 70; /* 色散冷侧 */
  --disp-a-rgb: 236, 200, 132;
  --disp-b-rgb: 112, 156, 255;

  /* 折射光斑（caustic）：位置由入射方向反推，长短轴随太阳高度变化 */
  --caustic-x: 52%; --caustic-y: 30%;
  --caustic-w: 26%; --caustic-h: 20%;
  --caustic-a: .16;
  --caustic-rgb: 255, 232, 186;
  --caustic-core: rgba(var(--caustic-rgb, 255, 232, 186), calc(var(--caustic-a, .16) * 1.55));
  --caustic-fade: rgba(var(--caustic-rgb, 255, 232, 186), calc(var(--caustic-a, .16) * .42));

  /* 光晕环（halo）：annulus 而不是实心圆 —— 实心圆是"雾"，环才是"晕" */
  --halo-r: 460px;
  --halo-a: .10;
  --halo-tone-h: 46; --halo-tone-s: 26; --halo-tone-l: 88;
  --halo-rgb: 255, 246, 226;
  --halo-ring: rgba(var(--halo-rgb, 255, 246, 226), calc(var(--halo-a, .10) * 1.5));
  --halo-soft: rgba(var(--halo-rgb, 255, 246, 226), calc(var(--halo-a, .10) * .5));
`;

/* 插到 :root 的 --atmo-3 之后（保持"颜色段落"聚在一起） */
/* 文件是 CRLF：锚点不带换行，插入时显式补 \r\n */
const anchor = '  --atmo-3: rgba(var(--atmo-3-rgb, 216, 218, 220), calc(.34 * (1 - var(--sun-warm, 0) * .55))); /* 中性底雾（不染色） */';
if (!s.includes(anchor)) throw new Error('锚点未命中：atmo-3');
s = s.replace(anchor, anchor + '\r\n' + LIGHT_MODEL.replace(/\n/g, '\r\n'));

/* 3. 暗档：光必须更淡 —— 只覆盖 alpha 与几何，通道/RGB 与明档同源 */
const DARK = `
  /* R79 · 夜间光衰减：色相与明档同一套（都由 sun.js 写），只压 alpha。
     物理依据：同样的月光，落在深色底上的可感知亮度更低（Weber–Fechner）。 */
  --caustic-a: .10;
  --halo-a: .13;
`;
const danchor = '  --lg-fringe-r: rgba(var(--disp-b-rgb, 112, 156, 255), .28);';
if (!s.includes(danchor)) throw new Error('锚点未命中：dark fringe-r');
s = s.replace(danchor, danchor + '\r\n' + DARK.replace(/\n/g, '\r\n'));

writeFileSync(FILE, s);
console.log(miss.length ? '未命中：\n  ' + miss.join('\n  ') : `✓ ${PAIRS.length} 条全部命中，光模型段已插入`);
