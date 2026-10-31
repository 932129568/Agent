#!/usr/bin/env node
/** Manifest-driven, deterministic Harbor frontend build (Node builtins only). */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_PLACEHOLDER = '/*__APP_SCRIPT__*/';
const STYLE_PLACEHOLDER = '/*__APP_STYLES__*/';
const VERSION_PLACEHOLDER = '__APP_VERSION__';
const REQUIRED_LIBS = ['marked.min.js', 'purify.min.js', 'flate.js', 'highlight.min.js'];

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
  const prebuiltParts = (manifest.prebuilt || []).map(entry => {
    const code = fs.readFileSync(path.join(root, entry.path), 'utf8');
    return '/* ===== ' + entry.path + ' (prebuilt) ===== */\n' + code.trimEnd();
  });
  const scriptParts = manifest.scripts.map(entry => {
    const code = fs.readFileSync(path.join(root, entry.path), 'utf8');
    return '/* ===== ' + entry.path + ' ===== */\n' + code.trimEnd();
  });
  const styleParts = manifest.styles.map(pathname =>
    '/* ===== ' + pathname + ' ===== */\n' + fs.readFileSync(path.join(root, pathname), 'utf8').trimEnd());
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
    prebuilt: (manifest.prebuilt || []).length };
}

function main() {
  try {
    const result = build();
    console.log('[build] node=%s | %d 个模块, %d 个样式, %d 个预编译产物 -> %s (%d 行)',
      process.version, result.modules, result.styles, (result.prebuilt || 0),
      path.relative(ROOT, result.output), result.html.split('\n').length);
  } catch (error) {
    console.error('[build] 失败: ' + error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  BuildError, build, loadManifest, maskJavaScript, scanTopLevelSymbols,
  validateDiskManifest, validateSymbolsAndOrder, validateTemplate
};
