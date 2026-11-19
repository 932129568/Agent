/* R79 一阶段 · tokens.css 暗档追加菲涅尔/接触线/有序色散令牌。
   tokens.css 是 CRLF 文件 —— 锚点不带换行，插入时显式补 \r\n（R79 上一轮踩过这个坑）。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(HERE, '..', 'styles', 'tokens.css');
let src = readFileSync(FILE, 'utf8');
const CRLF = src.includes('\r\n');
const nl = CRLF ? '\r\n' : '\n';

const anchor = ['  --lg-fringe-w-l: 1.5px;', '  --lg-fringe-w-r: 2px;'].join(nl);
if (src.indexOf(anchor) < 0) { console.error('锚点未命中'); process.exit(1); }

const lines = [
  '',
  '  /* ---- R79 一阶段 · 暗档菲涅尔剖面 ----',
  '     只压 alpha，剖面形状（四档的落点）与明档**同一份** —— 形状是物理，亮度是环境。',
  '     夜间边缘荧光（B03 同源问题）比"看不见"更难修，所以贴边那档从 .96 收到 .62，',
  '     而不是靠改宽度或加 blur 糊过去。 */',
  '  --lg-fres-1: rgba(255, 255, 255, .62);',
  '  --lg-fres-2: rgba(255, 255, 255, .30);',
  '  --lg-fres-3: rgba(255, 255, 255, .14);',
  '  --lg-fres-4: rgba(255, 255, 255, .04);',
  '  /* 上下沿比 .20 / .07 = 2.86:1 —— 落在 2.5–3.5 窗口内，且下沿不为 0。 */',
  '  --lg-fres-top: rgba(255, 255, 255, .20);',
  '  --lg-fres-bottom: rgba(255, 255, 255, .07);',
  '  --lg-contact-hl: rgba(255, 255, 255, .30);',
  '  --lg-contact-sh: rgba(0, 0, 0, .30);',
  '  /* 有序色散在暗档同样保留顺序，只压亮度：暖 .30 / 冷 .34（冷侧略强，',
  '     因为暗底上短波更容易被读成"冷光"而不是"脏"）。 */',
  '  --lg-disp-warm: rgba(var(--disp-a-rgb, 238, 204, 140), .30);',
  '  --lg-disp-cool: rgba(var(--disp-b-rgb, 112, 156, 255), .34);',
];

src = src.replace(anchor, anchor + nl + lines.join(nl));
writeFileSync(FILE, src);
console.log('已插入暗档菲涅尔令牌；文件 CRLF =', CRLF);
