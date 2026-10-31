'use strict';

/**
 * 生成 harbor.html 的无头验收副本（不改动原产物）。
 *
 * 注入：① pywebview 只读桩桥（离线回放 get_sessions）
 *       ② 延时报告（写入 <pre id="report">，供 --dump-dom 提取）
 * 产物路径：outputs/island/harbor-island-smoke.html（libs 引用同步改相对路径）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'outputs', 'island', 'harbor-island-smoke.html');

const stub = `<script>
window.__SMOKE_ERRORS__ = [];
window.addEventListener('error', e => window.__SMOKE_ERRORS__.push(String(e.message || e)));
window.addEventListener('unhandledrejection', e => window.__SMOKE_ERRORS__.push('rejection:' + String(e.reason)));
window.pywebview = { api: new Proxy({}, { get: function (t, k) {
  if (k === 'get_sessions') return async function () {
    return JSON.stringify([
      { id: 's_a', title: 'React 侧栏岛', createdAt: Date.now() - 3600000, updatedAt: Date.now() - 60000,
        runStatus: 'working', messages: [{ role: 'user', content: 'hi' }] },
      { id: 's_b', title: '空间内会话', createdAt: Date.now() - 7200000, updatedAt: Date.now() - 3600000,
        runStatus: 'completed', projectId: 'p1', projectName: 'Harbor',
        projectWorkspace: 'C:/work/harbor', messages: [] }
    ]);
  };
  if (k === 'get_config') return async function () { return '{}'; };
  return async function () { return '{}'; };
} }) };
</script>`;

const report = `<script>
setTimeout(function () {
  var pre = document.createElement('pre');
  pre.id = 'report';
  pre.style.cssText = 'position:fixed;left:-9999px;top:0';
  pre.textContent = JSON.stringify({
    islandPresent: typeof window.HarborIsland === 'object' && !!window.HarborIsland,
    framework: window.HarborIsland ? window.HarborIsland.framework : null,
    version: window.HarborIsland ? window.HarborIsland.version : null,
    sidebarActive: window.__HARBOR_ISLAND_SIDEBAR__ === true,
    islandSessions: document.querySelectorAll('#sidebarHistory .i-session').length,
    legacySessions: document.querySelectorAll('#sidebarHistory .session-item').length,
    projectGroups: document.querySelectorAll('#sidebarHistory .i-project').length,
    errors: window.__SMOKE_ERRORS__
  });
  document.body.appendChild(pre);
}, 500);
</script>`;

let html = fs.readFileSync(path.join(ROOT, 'harbor.html'), 'utf8');
const headIndex = html.indexOf('<head>');
if (headIndex < 0) throw new Error('harbor.html 缺 <head>');
html = html.slice(0, headIndex + 6) + stub + html.slice(headIndex + 6);
const libRefs = (html.match(/src="libs\//g) || []).length;
html = html.split('src="libs/').join('src="../../libs/');
const bodyIndex = html.lastIndexOf('</body>');
if (bodyIndex < 0) throw new Error('harbor.html 缺 </body>');
html = html.slice(0, bodyIndex) + report + html.slice(bodyIndex);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
console.log('[smoke] %s (%d B, libs 引用改写 %d 处)', path.relative(ROOT, OUT), html.length, libRefs);
