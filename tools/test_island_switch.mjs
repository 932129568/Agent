/**
 * 侧栏岛交互验证：真实 harbor.html + 桩桥，调用 legacy `switchSession`，
 * 检查岛渲染的 active 项是否跟随（验证 legacy → 岛的单向数据推流）。
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-island-switch-'))

const stub = `<script>
window.__ERRS__ = [];
window.addEventListener('error', e => window.__ERRS__.push(String(e.message || e)));
window.pywebview = { api: new Proxy({}, { get: function (t, k) {
  if (k === 'get_sessions') return async function () {
    return JSON.stringify([
      { id: 's_a', title: '会话A', createdAt: 1, updatedAt: Date.now() - 60000,
        runStatus: 'working', messages: [] },
      { id: 's_b', title: '会话B', createdAt: 1, updatedAt: Date.now() - 3600000,
        runStatus: 'completed', projectId: 'p1', projectName: 'Harbor',
        projectWorkspace: 'C:/work/harbor', messages: [] }
    ]);
  };
  return async function () { return '{}'; };
} }) };
</script>`

const probe = `<script>
setTimeout(function () {
  var before = document.querySelector('#sidebarHistory .i-session.active');
  var beforeId = before ? before.getAttribute('data-sid') : null;
  try { switchSession('s_b'); } catch (e) { window.__ERRS__.push('switch:' + e.message); }
  setTimeout(function () {
    var after = document.querySelector('#sidebarHistory .i-session.active');
    var pre = document.createElement('pre');
    pre.id = 'report';
    pre.style.cssText = 'position:fixed;left:-9999px;top:0';
    pre.textContent = JSON.stringify({
      before: beforeId,
      after: after ? after.getAttribute('data-sid') : null,
      activeCount: document.querySelectorAll('#sidebarHistory .i-session.active').length,
      islandActive: window.__HARBOR_ISLAND_SIDEBAR__ === true,
      errors: window.__ERRS__
    });
    document.body.appendChild(pre);
  }, 400);
}, 1500);
</script>`

let html = fs.readFileSync(path.join(root, 'harbor.html'), 'utf8')
const headIndex = html.indexOf('<head>')
html = html.slice(0, headIndex + 6) + stub + html.slice(headIndex + 6)
html = html.split('src="libs/').join('src="../../libs/')
const bodyIndex = html.lastIndexOf('</body>')
html = html.slice(0, bodyIndex) + probe + html.slice(bodyIndex)
const outDir = path.join(root, 'outputs', 'island')
fs.mkdirSync(outDir, { recursive: true })
const page = path.join(outDir, 'island-switch.html')
fs.writeFileSync(page, html, 'utf8')

const { stdout } = await execFileAsync(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--window-size=1440,900', '--virtual-time-budget=20000',
  '--dump-dom', `file://${page.replace(/\\/g, '/')}`,
], { maxBuffer: 32 * 1024 * 1024, timeout: 120000 })

const match = stdout.match(/id="report"[^>]*>([^<]*)/)
assert.ok(match, '未取到报告节点')
const report = JSON.parse(match[1])
assert.equal(report.islandActive, true, '岛未激活')
assert.equal(report.after, 's_b', `切换后 active 未跟随：${JSON.stringify(report)}`)
assert.equal(report.activeCount, 1, 'active 项必须唯一')
assert.deepEqual(report.errors, [], '存在运行时错误')

console.log(JSON.stringify({ ok: true, node: process.version, report }, null, 2))
