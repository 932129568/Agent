#!/usr/bin/env node
/**
 * Manifest-driven, deterministic Harbor frontend build (Node builtins only).
 *
 * R92：产物内联时逐文件压缩（去注释 / 缩进 / 行尾空白 / 空行），harbor.html 从
 * 4.09MB 降到 3.62MB，为后续功能腾出约 476KB 余量。压缩器必须守住三条不变量：
 *   1. 只做空白与注释级别的改动。标识符、字符串、模板字面量、正则体逐字节保留 ——
 *      这些 legacy 模块靠全局名字互相调用，改名会直接断链；
 *   2. 代码区不合并行（只删空行），自动分号插入看到的换行序列与源码完全一致；
 *   3. 不依赖 node_modules。本文件的历史契约是「Node builtins only」，而且
 *      tests/test_generative_registry.py 会把 node_modules 改名成
 *      node_modules.offline-test 之后要求本脚本仍以 0 退出并产出相同字节。
 *      因此压缩器自备，不 spawn 外部二进制（缺工具时既不能静默跳过，也不能硬失败）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_PLACEHOLDER = '/*__APP_SCRIPT__*/';
const STYLE_PLACEHOLDER = '/*__APP_STYLES__*/';
const VERSION_PLACEHOLDER = '__APP_VERSION__';
const REQUIRED_LIBS = ['marked.min.js', 'purify.min.js', 'flate.js', 'highlight.min.js'];
const NO_MINIFY_FLAG = '--no-minify';
const NO_MINIFY_ENV = 'HARBOR_NO_MINIFY';

class BuildError extends Error {}

function fail(message) {
  throw new BuildError(message);
}

function normalizeRelative(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(label + ' 必须是非空相对路径');
  const normalized = value.replace(/\\/g, '/');
  const parsed = path.posix.parse(normalized);
  if (path.isAbsolute(value) || parsed.root || normalized.split('/').includes('..')) {
    fail(label + ' 路径逃逸项目根目录: ' + value);
  }
  return path.posix.normalize(normalized);
}

function loadManifest(root, manifestFile) {
  const filename = manifestFile || path.join(root, 'frontend', 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    fail('无法读取 frontend/manifest.json: ' + error.message);
  }
  if (!manifest || manifest.schemaVersion !== 1) fail('manifest schemaVersion 必须为 1');
  manifest.template = normalizeRelative(manifest.template, 'manifest.template');
  manifest.output = normalizeRelative(manifest.output, 'manifest.output');
  if (!Array.isArray(manifest.scripts) || !manifest.scripts.length) fail('manifest.scripts 不能为空');
  if (!Array.isArray(manifest.styles) || !manifest.styles.length) fail('manifest.styles 不能为空');
  manifest.scripts = manifest.scripts.map((entry, index) => {
    if (!entry || typeof entry !== 'object') fail('scripts[' + index + '] 必须是对象');
    if (!Array.isArray(entry.provides) || !Array.isArray(entry.requires)) {
      fail(entry.path + ' 必须声明 provides/requires 数组');
    }
    return {
      path: normalizeRelative(entry.path, 'scripts[' + index + '].path'),
      provides: entry.provides.slice(),
      requires: entry.requires.slice()
    };
  });
  manifest.styles = manifest.styles.map((entry, index) =>
    normalizeRelative(entry, 'styles[' + index + ']'));
  // 预编译产物（Vue 岛层等）：与手写模块同拼入 harbor.html，但不进
  // frontend/src 的磁盘-清单一致性检查（产物目录由各自构建器管理）。
  const prebuilt = Array.isArray(manifest.prebuilt) ? manifest.prebuilt : [];
  manifest.prebuilt = prebuilt.map((entry, index) => {
    if (!entry || typeof entry !== 'object') fail('prebuilt[' + index + '] 必须是对象');
    return {
      path: normalizeRelative(entry.path, 'prebuilt[' + index + '].path'),
      provides: Array.isArray(entry.provides) ? entry.provides.slice() : []
    };
  });
  return manifest;
}

function listFilesRecursive(directory, extension) {
  if (!fs.existsSync(directory)) return [];
  const result = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(extension)) result.push(absolute);
    }
  }
  visit(directory);
  return result.sort();
}

function assertUniquePaths(entries, label) {
  const seen = new Map();
  for (const entry of entries) {
    if (seen.has(entry.path)) fail(label + ' 重复: ' + entry.path);
    seen.set(entry.path, true);
  }
}

function validateDiskManifest(root, manifest) {
  assertUniquePaths(manifest.scripts, 'manifest scripts');
  assertUniquePaths(manifest.styles.map(pathname => ({ path: pathname })), 'manifest styles');
  const groups = [
    { entries: manifest.scripts, directory: path.join(root, 'frontend', 'src'), extension: '.js', label: 'JS' },
    { entries: manifest.styles.map(pathname => ({ path: pathname })), directory: path.join(root, 'frontend', 'styles'), extension: '.css', label: 'CSS' }
  ];
  for (const group of groups) {
    const declared = new Set(group.entries.map(entry => entry.path));
    for (const pathname of declared) {
      if (!fs.existsSync(path.join(root, pathname))) fail('manifest 幽灵路径: ' + pathname);
    }
    const onDisk = listFilesRecursive(group.directory, group.extension)
      .map(filename => path.relative(root, filename).replace(/\\/g, '/'));
    const missing = onDisk.filter(pathname => !declared.has(pathname));
    if (missing.length) fail(group.label + ' 磁盘文件未列入 manifest: ' + missing.join(', '));
  }
}

/**
 * Mask comments, strings, template literals and regex literals while preserving
 * newlines and code positions. Nested braces/parentheses are masked separately.
 */
function maskJavaScript(source) {
  const masked = source.split('');
  let state = 'code';
  let escaped = false;
  let regexClass = false;
  let previous = '';
  let word = '';
  function blank(index) { if (masked[index] !== '\n' && masked[index] !== '\r') masked[index] = ' '; }
  function regexAllowed() {
    if (!previous) return true;
    if (/[({[=,:;!?&|+\-*%^~<>]/.test(previous)) return true;
    return /^(return|case|throw|typeof|void|delete|in|of|yield|await|else)$/.test(word);
  }
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'lineComment') {
      blank(index);
      if (char === '\n') state = 'code';
      continue;
    }
    if (state === 'blockComment') {
      blank(index);
      if (char === '*' && next === '/') {
        blank(index + 1); index++; state = 'code';
      }
      continue;
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      blank(index);
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if ((state === 'single' && char === "'") || (state === 'double' && char === '"') ||
          (state === 'template' && char === '`')) state = 'code';
      continue;
    }
    if (state === 'regex') {
      blank(index);
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '[') regexClass = true;
      else if (char === ']') regexClass = false;
      else if (char === '/' && !regexClass) state = 'regexFlags';
      continue;
    }
    if (state === 'regexFlags') {
      if (/[a-z]/i.test(char)) { blank(index); continue; }
      state = 'code';
    }
    if (char === '/' && next === '/') {
      blank(index); blank(index + 1); index++; state = 'lineComment'; continue;
    }
    if (char === '/' && next === '*') {
      blank(index); blank(index + 1); index++; state = 'blockComment'; continue;
    }
    if (char === "'") { blank(index); state = 'single'; escaped = false; continue; }
    if (char === '"') { blank(index); state = 'double'; escaped = false; continue; }
    if (char === '`') { blank(index); state = 'template'; escaped = false; continue; }
    if (char === '/' && regexAllowed()) {
      blank(index); state = 'regex'; regexClass = false; escaped = false; continue;
    }
    if (/\s/.test(char)) continue;
    previous = char;
    if (/[A-Za-z0-9_$]/.test(char)) word += char;
    else word = '';
  }
  return masked.join('');
}

function maskNestedScopes(source) {
  const lexical = maskJavaScript(source);
  const output = lexical.split('');
  let braces = 0;
  let parentheses = 0;
  for (let index = 0; index < lexical.length; index++) {
    const char = lexical[index];
    if (char === '{') { braces++; output[index] = ' '; continue; }
    if (char === '}') { braces = Math.max(0, braces - 1); continue; }
    if (char === '(') { parentheses++; output[index] = ' '; continue; }
    if (char === ')') { output[index] = ' '; parentheses = Math.max(0, parentheses - 1); continue; }
    if (braces > 0 || parentheses > 0) output[index] = ' ';
  }
  return output.join('');
}

function isDeclaration(prefix) {
  const tail = prefix.trimEnd();
  return !tail || /[;{}]$/.test(tail) || /(?:^|\s)async$/.test(tail);
}

function scanTopLevelSymbols(source) {
  const top = maskNestedScopes(source);
  const symbols = new Set();
  for (const match of top.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    if (isDeclaration(top.slice(0, match.index))) symbols.add(match[1]);
  }
  for (const match of top.matchAll(/\b(?:let|const|var)\s+([^;]+)/g)) {
    const declaration = match[1];
    for (const part of declaration.split(',')) {
      const binding = /^\s*([A-Za-z_$][\w$]*)\s*(?:=|$)/.exec(part);
      if (binding) symbols.add(binding[1]);
    }
  }
  for (const match of top.matchAll(/\bHarbor\.([A-Za-z_$][\w$]*)\s*=/g)) {
    symbols.add('Harbor.' + match[1]);
  }
  return Array.from(symbols).sort();
}

function validateSymbolsAndOrder(root, manifest) {
  const globals = new Map();
  const available = new Set();
  // 预编译产物先行：其顶层符号（如 HarborVue）对后续手写模块可见，
  // 符号唯一性与 provides 一致性与手写模块同一口径校验。
  for (const entry of (manifest.prebuilt || [])) {
    if (!fs.existsSync(path.join(root, entry.path))) {
      fail('预编译产物缺失: ' + entry.path + '（请先运行该层构建，例如 cd frontend/vue && npm run build）');
    }
    const source = fs.readFileSync(path.join(root, entry.path), 'utf8');
    if (/<\/script/i.test(source)) fail(entry.path + ' 含有 </script> 字面量');
    const actual = scanTopLevelSymbols(source);
    const missing = actual.filter(symbol => !entry.provides.includes(symbol));
    const ghosts = entry.provides.filter(symbol => !actual.includes(symbol));
    if (missing.length || ghosts.length) {
      fail(entry.path + ' provides 与顶层符号不一致; 未声明=[' + missing.join(', ') +
        ']; 幽灵=[' + ghosts.join(', ') + ']');
    }
    for (const symbol of actual) {
      if (globals.has(symbol)) {
        fail('顶层全局符号重复: ' + symbol + ' (' + globals.get(symbol) + ' 与 ' + entry.path + ')');
      }
      globals.set(symbol, entry.path);
      available.add(symbol);
    }
  }
  for (const entry of manifest.scripts) {
    const source = fs.readFileSync(path.join(root, entry.path), 'utf8');
    if (/<\/script/i.test(source)) fail(entry.path + ' 含有 </script> 字面量');
    const actual = scanTopLevelSymbols(source);
    const declared = new Set(entry.provides);
    if (declared.size !== entry.provides.length) fail(entry.path + ' provides 重复');
    const missing = actual.filter(symbol => !declared.has(symbol));
    const ghosts = entry.provides.filter(symbol => !actual.includes(symbol));
    if (missing.length || ghosts.length) {
      fail(entry.path + ' provides 与顶层符号不一致; 未声明=[' + missing.join(', ') +
        ']; 幽灵=[' + ghosts.join(', ') + ']');
    }
    for (const required of entry.requires) {
      if (!available.has(required)) fail(entry.path + ' 顺序依赖未满足: ' + required);
    }
    for (const symbol of actual) {
      if (globals.has(symbol)) {
        fail('顶层全局符号重复: ' + symbol + ' (' + globals.get(symbol) + ' 与 ' + entry.path + ')');
      }
      globals.set(symbol, entry.path);
      available.add(symbol);
    }
  }
}

function countOccurrences(source, token) {
  return source.split(token).length - 1;
}

/* ───────────────────────────── 内联压缩（R92） ─────────────────────────────
 * 只删「浏览器不需要的字节」：注释、行首缩进、行尾空白、空行、代码区的 CR。
 * 代码区一律不合并行 —— 自动分号插入看到的换行序列与源码逐一对应，因此不需要
 * 语义分析就能保证行为不变。字符串 / 模板字面量 / 正则体逐字节复制，包括其内部
 * 的换行与缩进（模板字面量里的缩进是值的一部分，动了就改数据）。
 * 标识符一律保留：本仓 117 个 legacy 模块靠全局名字互相调用，rename 不是空白级变换。
 * ──────────────────────────────────────────────────────────────────────────── */

const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;
const REGEX_PREFIX_CHAR = /[({[=,:;!?&|+\-*%^~<>]/;
const REGEX_PREFIX_WORD = /^(?:return|case|throw|typeof|void|delete|in|of|yield|await|else)$/;

/** 压缩开关：默认开启；--no-minify 或 HARBOR_NO_MINIFY=1 关闭（排障用）。 */
function isMinifyEnabled(argv, env) {
  const args = Array.isArray(argv) ? argv : [];
  if (args.includes(NO_MINIFY_FLAG)) return false;
  const raw = env ? env[NO_MINIFY_ENV] : '';
  if (typeof raw === 'string' && /^(?:1|true|yes|on)$/i.test(raw.trim())) return false;
  return true;
}

/**
 * 去掉一个 JS 文件的注释与空白，保留全部 token。
 *
 * @param {string} source 源码文本
 * @param {string} label 出错时报告的文件名
 * @return {string} 压缩后的等价脚本
 */
function minifyJavaScript(source, label) {
  const name = label || '(anonymous)';
  const output = [];
  const length = source.length;
  const templateDepths = [];  // 模板插值 ${...} 的花括号深度栈
  let index = 0;
  let state = 'code';
  let previous = '';
  let word = '';
  let atLineStart = true;
  let pendingSpace = false;

  function push(char) {
    output.push(char);
    if (char !== '\n') atLineStart = false;
    if (char === ' ' || char === '\t' || char === '\n') return;
    previous = char;
    word = IDENTIFIER_CHAR.test(char) ? word + char : '';
  }
  function trimTrailingBlanks() {
    while (output.length &&
           (output[output.length - 1] === ' ' || output[output.length - 1] === '\t')) output.pop();
  }
  function breakLine() {
    trimTrailingBlanks();
    atLineStart = true;
    previous = '';
    word = '';
    if (!output.length || output[output.length - 1] === '\n') return;  // 连续空行只留一个
    output.push('\n');
  }
  function needsSpace(before, after) {
    if (!before || !after) return false;
    if (IDENTIFIER_CHAR.test(before) && IDENTIFIER_CHAR.test(after)) return true;
    if (before === '+' && after === '+') return true;
    if (before === '-' && after === '-') return true;
    if (before === '/' && (after === '/' || after === '*')) return true;
    if (before === '<' && after === '!') return true;
    if (before === '.' || after === '.') return true;
    return false;
  }
  // 注意：只处理「源码里本来就有空白」的位置，不额外删掉 token 之间的空格。
  // 见文件头 R92 说明 —— 删掉 `x.id = 'y'` 里的空格会让冻结面 dom_ids 从 479 涨到 534。
  function flushPendingSpace(next) {
    if (!pendingSpace) return;
    pendingSpace = false;
    if (!previous) return;
    if (needsSpace(previous, next)) push(' ');
  }
  function regexAllowed() {
    if (!previous) return true;
    if (REGEX_PREFIX_CHAR.test(previous)) return true;
    return REGEX_PREFIX_WORD.test(word);
  }
  function enterLiteral(nextState, char) {
    state = nextState;
    push(char);
    previous = '';  // 字面量内部不参与正则/除号判定
    word = '';
  }
  function leaveLiteral(char) {
    state = 'code';
    previous = char;
    word = '';
  }

  while (index < length) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') {
        index += 2;
        while (index < length && source[index] !== '\n') index++;
        pendingSpace = true;
        continue;
      }
      if (char === '/' && next === '*') {
        index += 2;
        let sawNewline = false;
        while (index < length && !(source[index] === '*' && source[index + 1] === '/')) {
          if (source[index] === '\n') { sawNewline = true; breakLine(); }
          index++;
        }
        if (index >= length) fail(name + ' 块注释未闭合，疑似语法错误；请先修源文件再构建');
        index += 2;
        if (sawNewline) breakLine();
        else pendingSpace = true;
        continue;
      }
      if (char === '\r') { index++; continue; }
      if (char === '\n') { index++; pendingSpace = false; breakLine(); continue; }
      if (atLineStart && (char === ' ' || char === '\t')) { index++; continue; }
      if (char === ' ' || char === '\t') {
        let cursor = index;
        while (cursor < length && (source[cursor] === ' ' || source[cursor] === '\t')) cursor++;
        if (cursor >= length) break;
        if (source[cursor] === '\r' || source[cursor] === '\n') { index = cursor; continue; }
        pendingSpace = false;   // 这里已经写了一个空格，无需再补
        push(' ');
        index = cursor;
        continue;
      }
      flushPendingSpace(char);
      if (char === '"') { enterLiteral('double', char); index++; continue; }
      if (char === "'") { enterLiteral('single', char); index++; continue; }
      if (char === '`') { enterLiteral('template', char); index++; continue; }
      if (char === '/' && regexAllowed()) { enterLiteral('regex', char); index++; continue; }
      if (templateDepths.length) {
        if (char === '{') templateDepths[templateDepths.length - 1] += 1;
        else if (char === '}') {
          if (templateDepths[templateDepths.length - 1] === 0) {
            templateDepths.pop();
            push(char);
            state = 'template';
            index++;
            continue;
          }
          templateDepths[templateDepths.length - 1] -= 1;
        }
      }
      push(char);
      index++;
      continue;
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      if (char === '\\') {
        push(char);
        if (index + 1 < length) push(source[index + 1]);
        index += 2;
        continue;
      }
      if (state === 'template' && char === '$' && next === '{') {
        push(char);
        push(next);
        templateDepths.push(0);
        state = 'code';
        index += 2;
        continue;
      }
      push(char);
      index++;
      if ((state === 'single' && char === "'") || (state === 'double' && char === '"') ||
          (state === 'template' && char === '`')) {
        if (state === 'template' && templateDepths.length) {
          // 模板结束在插值内部：回到插值所在的外层代码上下文
          state = 'code';
          previous = char;
          word = '';
        } else {
          leaveLiteral(char);
        }
      }
      continue;
    }
    // regex
    if (char === '\\') {
      push(char);
      if (index + 1 < length) push(source[index + 1]);
      index += 2;
      continue;
    }
    if (char === '[') {
      push(char);
      index++;
      while (index < length && source[index] !== ']') {
        if (source[index] === '\\') {
          push(source[index]);
          if (index + 1 < length) push(source[index + 1]);
          index += 2;
          continue;
        }
        push(source[index]);
        index++;
      }
      if (index < length) { push(']'); index++; }
      continue;
    }
    push(char);
    index++;
    if (char === '/') {
      state = 'code';
      previous = 'a';   // 正则后紧跟的 / 是除号，不再按正则起始处理
      word = '';
      while (index < length && /[a-z]/i.test(source[index])) { push(source[index]); index++; }
    }
  }
  if (state !== 'code' || templateDepths.length) {
    fail(name + ' 扫描结束时仍处于字面量内部（' + state + '），疑似语法错误；请先修源文件再构建');
  }
  const minified = output.join('');
  try {
    new Function(minified);
  } catch (error) {
    fail(name + ' 压缩后语法校验失败: ' + error.message);
  }
  return minified;
}

/**
 * 去掉一个样式表的注释与空白。选择器、声明、字符串逐字节保留 ——
 * 因此十六进制颜色大小写、属性选择器引号等下游按字面量断言的契约面不受影响。
 *
 * @param {string} source 源码文本
 * @param {string} label 出错时报告的文件名
 * @return {string} 压缩后的等价样式表
 */
function minifyStyleSheet(source, label) {
  const output = [];
  const length = source.length;
  let index = 0;
  let atLineStart = true;
  let previous = '';

  function trimTrailingBlanks() {
    while (output.length &&
           (output[output.length - 1] === ' ' || output[output.length - 1] === '\t')) output.pop();
  }
  function push(char) {
    output.push(char);
    if (char !== '\n') atLineStart = false;
    if (char !== ' ' && char !== '\t' && char !== '\n') previous = char;
  }

  while (index < length) {
    const char = source[index];
    if (char === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') { trimTrailingBlanks(); if (output.length && output[output.length - 1] !== '\n') output.push('\n'); }
        index++;
      }
      if (index >= length) fail((label || '(anonymous)') + ' 注释未闭合；请先修样式表再构建');
      index += 2;
      // 注释可能把两侧 token 隔开，必要时补一个空格
      const nextChar = source[index];
      if (previous && nextChar && IDENTIFIER_CHAR.test(previous) && IDENTIFIER_CHAR.test(nextChar)) push(' ');
      continue;
    }
    if (char === '\r') { index++; continue; }
    if (char === '\n') {
      index++;
      trimTrailingBlanks();
      if (output.length && output[output.length - 1] !== '\n') output.push('\n');
      atLineStart = true;
      continue;
    }
    if (atLineStart && (char === ' ' || char === '\t')) { index++; continue; }
    if (char === ' ' || char === '\t') {
      let cursor = index;
      while (cursor < length && (source[cursor] === ' ' || source[cursor] === '\t')) cursor++;
      if (cursor >= length) break;
      if (source[cursor] === '\r' || source[cursor] === '\n') { index = cursor; continue; }
      push(' ');
      index = cursor;
      continue;
    }
    push(char);
    index++;
  }
  return output.join('');
}

/** 按扩展名选择压缩器；未知扩展名原样返回（manifest 只声明 .js/.css）。 */
function minifyInlineAsset(relativePath, source) {
  if (relativePath.endsWith('.css')) return minifyStyleSheet(source, relativePath);
  return minifyJavaScript(source, relativePath);
}

function validateTemplate(root, template) {
  for (const placeholder of [SCRIPT_PLACEHOLDER, STYLE_PLACEHOLDER, VERSION_PLACEHOLDER]) {
    const hits = countOccurrences(template, placeholder);
    if (hits !== 1) fail('模板占位符 ' + placeholder + ' 应恰好出现 1 次，实际 ' + hits + ' 次');
  }
  const references = [];
  const pattern = /<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const match of template.matchAll(pattern)) references.push(match[1]);
  for (const reference of references) {
    if (/^(?:https?:)?\/\//i.test(reference)) fail('模板包含非本地构建资源: ' + reference);
    if (/^(?:data|#|mailto):/i.test(reference)) continue;
    const pathname = normalizeRelative(reference.split(/[?#]/, 1)[0], '模板静态引用');
    if (!fs.existsSync(path.join(root, pathname))) fail('模板静态引用不存在: ' + reference);
  }
}

function build(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const manifest = loadManifest(root, options.manifestFile);
  validateDiskManifest(root, manifest);
  validateSymbolsAndOrder(root, manifest);
  for (const lib of REQUIRED_LIBS) {
    if (!fs.existsSync(path.join(root, 'libs', lib))) fail('libs/' + lib + ' 缺失');
  }
  const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  if (!version) fail('VERSION 文件缺失或为空');
  const template = fs.readFileSync(path.join(root, manifest.template), 'utf8');
  validateTemplate(root, template);
  const minify = options.minify === undefined
    ? isMinifyEnabled(process.argv.slice(2), process.env)
    : !!options.minify;
  const stats = { jsRaw: 0, jsOut: 0, cssRaw: 0, cssOut: 0, minified: minify };
  // 每个资源单独压缩，段标记在压缩**之后**拼上 —— 标记本身是注释，
  // 若先拼标记再压缩会被剥掉，产物就没法按段定位了。
  const inline = (relativePath, trimmer) => {
    const raw = fs.readFileSync(path.join(root, relativePath), 'utf8');
    const isCss = relativePath.endsWith('.css');
    const before = Buffer.byteLength(raw, 'utf8');
    const code = minify ? minifyInlineAsset(relativePath, raw) : trimmer(raw);
    const after = Buffer.byteLength(code, 'utf8');
    if (isCss) { stats.cssRaw += before; stats.cssOut += after; }
    else { stats.jsRaw += before; stats.jsOut += after; }
    return code;
  };
  const prebuiltParts = (manifest.prebuilt || []).map(entry =>
    '/* ===== ' + entry.path + ' (prebuilt) ===== */\n' + inline(entry.path, code => code.trimEnd()));
  const scriptParts = manifest.scripts.map(entry =>
    '/* ===== ' + entry.path + ' ===== */\n' + inline(entry.path, code => code.trimEnd()));
  const styleParts = manifest.styles.map(pathname =>
    '/* ===== ' + pathname + ' ===== */\n' + inline(pathname, code => code.trimEnd()));
  const script = prebuiltParts.concat(scriptParts).join('\n\n');
  const styles = styleParts.join('\n\n');
  try { new Function(script); } catch (error) { fail('拼接脚本语法校验失败: ' + error.message); }
  const html = template
    .replace(SCRIPT_PLACEHOLDER, () => script)
    .replace(STYLE_PLACEHOLDER, () => styles)
    .replace(VERSION_PLACEHOLDER, () => version);
  const output = path.join(root, manifest.output);
  fs.writeFileSync(output, html, 'utf8');
  return { html, output, modules: manifest.scripts.length, styles: manifest.styles.length,
    prebuilt: (manifest.prebuilt || []).length, stats };
}

function main() {
  try {
    const result = build();
    console.log('[build] node=%s | %d 个模块, %d 个样式, %d 个预编译产物 -> %s (%d 行)',
      process.version, result.modules, result.styles, (result.prebuilt || 0),
      path.relative(ROOT, result.output), result.html.split('\n').length);
    const stats = result.stats || {};
    if (stats.minified) {
      const bytes = Buffer.byteLength(result.html, 'utf8');
      console.log('[build] 压缩: JS %d -> %d (-%d), CSS %d -> %d (-%d), 产物 %d 字节',
        stats.jsRaw, stats.jsOut, stats.jsRaw - stats.jsOut,
        stats.cssRaw, stats.cssOut, stats.cssRaw - stats.cssOut, bytes);
    } else {
      console.log('[build] 压缩已关闭（--no-minify / %s），产物未瘦身', NO_MINIFY_ENV);
    }
  } catch (error) {
    console.error('[build] 失败: ' + error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  BuildError, build, isMinifyEnabled, loadManifest, maskJavaScript, minifyInlineAsset,
  minifyJavaScript, minifyStyleSheet, scanTopLevelSymbols, validateDiskManifest,
  validateSymbolsAndOrder, validateTemplate
};
