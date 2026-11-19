/**
 * LIGHTWELL R90 · 原子化三步构建链 + 产物特征校验
 *
 * 存在理由：R90-WP1 踩过一个坑 —— 改完 frontend/styles/tokens.css 只跑
 * `node frontend/build.js`，页面却仍显示旧配色。根因是：
 *   frontend/react/build.mjs:22  loader: {'.css': 'text'}
 *   frontend/react/src/index.jsx:32 import tokensCss from '../../styles/tokens.css'
 *   frontend/react/src/index.jsx:48-49 style.textContent = tokensCss + ...; head.appendChild(style)
 * 即 tokens.css 被当成**文本编进 island bundle**，运行时追加到 <head> 末尾，
 * 层叠上晚于 harbor.html 的内联 <style>，于是旧副本压过新文件。
 * 三步链缺任何一步，CSS 改动都会「看起来成功、实际没生效」。
 *
 * 用法：node scripts/build-lightwell.mjs
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MANIFEST = path.join(ROOT, 'frontend', 'manifest.json');
const HARBOR = path.join(ROOT, 'harbor.html');
const ISLAND = path.join(ROOT, 'frontend', 'react', 'dist', 'harbor-island.iife.js');

function runStep(label, cmd, args, cwd) {
  console.log(`[BUILD-LIGHTWELL] ${label}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function fail(msg) {
  console.error(`[BUILD-LIGHTWELL] FAIL — ${msg}`);
  process.exitCode = 1;
}

// ── 1/4 三步链 ────────────────────────────────────────────────────────────────
runStep('1/4 html-to-jsx（模板 → JSX 组件树）', process.execPath,
  ['frontend/react/tools/html-to-jsx.mjs'], ROOT);
runStep('2/4 react island（JSX + CSS → IIFE，CSS 以 text loader 内嵌）', process.execPath,
  ['build.mjs'], path.join(ROOT, 'frontend', 'react'));
runStep('3/4 build.js（内联全部资源 → harbor.html）', process.execPath,
  ['frontend/build.js'], ROOT);

// ── 2/4 契约面闸门：模块数必须仍是 117 ───────────────────────────────────────
// 壳层走 manifest.prebuilt，不占 scripts 名额；若有人为了塞脚本去加 scripts 条目，
// check_contract（117 JS）会红 —— 这里提前拦，并给出原因。
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
if (manifest.scripts.length !== 117) {
  fail(`manifest.scripts 必须为 117（实为 ${manifest.scripts.length}）。新增脚本请走 prebuilt。`);
}
if (manifest.styles.length !== 14) {
  fail(`manifest.styles 必须为 14（实为 ${manifest.styles.length}）。皮肤样式只能追加到末位 responsive.css。`);
}
const prebuiltPaths = (manifest.prebuilt || []).map(e => e.path);
if (!prebuiltPaths.includes('frontend/skin/lightwellShell.js')) {
  fail('manifest.prebuilt 缺少 frontend/skin/lightwellShell.js —— 壳层不会被内联，整层空转。');
}

// ── 3/4 产物特征校验（每条都可失败，不是恒真） ───────────────────────────────
const harborHtml = fs.readFileSync(HARBOR, 'utf8');
const islandBundle = fs.readFileSync(ISLAND, 'utf8');

const requiredInHarbor = [
  '[data-skin="lightwell"]',   // 皮肤层确实进了产物
  '#F0EEE6',                   // 明档画布
  '#D97757',                   // 赤陶主色
  '#E88B6B',                   // 暗档强调
  '__LIGHTWELL_SHELL__',       // 壳层脚本确实被内联（prebuilt 生效）
  'lw-ambient-wallpaper',      // 壁纸节点创建逻辑在产物里
  'lw-proto-chip',             // 9 视图 chip 样式
];
for (const token of requiredInHarbor) {
  if (!harborHtml.includes(token)) fail(`harbor.html 缺少特征「${token}」`);
}

// 反证：island 内嵌的必须仍是**默认** tokens（#F5F5F7），说明皮肤没污染默认态。
if (!islandBundle.includes('#F5F5F7')) {
  fail('island bundle 不含默认态令牌 #F5F5F7 —— tokens.css 可能被误改，默认态视觉将漂移。');
}
// 反证：皮肤色不得进 island（否则证明有人把皮肤写进了 tokens.css 而非 responsive.css）
if (islandBundle.includes('#F0EEE6')) {
  fail('island bundle 含皮肤色 #F0EEE6 —— 皮肤被写进了 tokens.css，默认态已污染。');
}

// prebuilt 条数必须与 manifest 一致（防止拼接漏项）
const prebuiltMarks = (harborHtml.match(/\(prebuilt\) ===== \*\//g) || []).length;
if (prebuiltMarks !== (manifest.prebuilt || []).length) {
  fail(`harbor.html 中 prebuilt 段数 ${prebuiltMarks} 与 manifest 的 ${(manifest.prebuilt || []).length} 不符`);
}

// ── 4/4 报告 ──────────────────────────────────────────────────────────────────
if (process.exitCode === 1) process.exit(1);

const lines = harborHtml.split('\n').length;
console.log(`[BUILD-LIGHTWELL] PASS — 117 模块 / 14 样式 / ${(manifest.prebuilt || []).length} prebuilt，harbor.html ${lines} 行`);
console.log('[BUILD-LIGHTWELL] 产物特征 7 项齐备；默认态令牌未污染（island 仍为 #F5F5F7）。');
