/**
 * T05 验收②/④（P0-4 §8 T05-②/④，§5.4/Q5）：NSIS 装卸语义端到端（临时目录 /S /D=，
 * 真实 %LOCALAPPDATA%\Programs\Harbor 与用户已装 Harbor 绝不触碰；真实 ~/.glm-chat
 * 零污染——「用户数据」由隔离 CONFIG_DIR 承担代表）。
 *
 * 流程：
 *   A. 安装到临时目录①（/S /D=）→ 产物文件在位 + HKCU 卸载键在位（键值留证）
 *   B. 跑安装位产物（HEADLESS，隔离 CONFIG_DIR）→ save_sessions 写入 1 会话 → 读回
 *   C. 卸载①（Uninstall *.exe /S）→ 安装目录删净 + HKCU 卸载键移除 + 隔离用户数据保留
 *   D. 重装到临时目录②（/S /D=）→ 同一隔离 CONFIG_DIR 读回 → 会话仍在
 *   E. 卸载②（现场清理）→ 键移除 + 目录删净
 *
 * Q5（④）：NSIS 键读写机制以本脚本 HKCU 查询/卸载移除逐键留证；旧 PyInstaller
 * 卸载键（HKCU）在真机上的实际处置留 T06（需主理人在场——本报告登记待办）。
 *
 * 用法：node tools/verify-install-uninstall.mjs [--setup <Setup.exe>] [--keep]
 * 退出码：0 全过；1 存在失败；2 基础设施错误。
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const setupExe = args.includes('--setup')
  ? path.resolve(args[args.indexOf('--setup') + 1])
  : path.join(PROJECT_ROOT, 'dist-electron', 'Harbor-Setup-1.9.0.exe')
const keep = args.includes('--keep')
const UNINSTALL_KEY_ROOT = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'

if (!fs.existsSync(setupExe)) {
  console.error(`Setup 不存在: ${setupExe}`)
  process.exit(2)
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-t05-nsis-'))
const userData = path.join(scratch, 'userdata') // 「用户数据」代表（隔离 CONFIG_DIR）
fs.mkdirSync(userData, { recursive: true })

const checks = []
const check = (name, fn) => {
  try { const detail = fn(); checks.push({ name, ok: true, ...(detail ? { detail } : {}) }) }
  catch (e) { checks.push({ name, ok: false, detail: String(e.message || e).slice(0, 400) }) }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

/** reg.exe 输出走 ANSI 代码页（本机 cp936），中文路径经 Node utf8 解码必坏——
 * 一律改走 PowerShell（显式 UTF8 console + ConvertTo-Json），路径保真。 */
async function psOut(script) {
  const { stdout } = await execFileAsync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + script],
    { encoding: 'utf8' })
  return stdout.trim()
}
async function psJson(script) {
  return JSON.parse(await psOut(script))
}
async function regQuery(key) {
  try {
    const obj = await psJson(
      `(Get-ItemProperty -LiteralPath 'Registry::${key.replaceAll("'", "''")}' -ErrorAction Stop | `
      + 'Select-Object * -ExcludeProperty PS*) | ConvertTo-Json -Compress')
    return obj && typeof obj === 'object' ? obj : null
  } catch { return null }
}
async function regSubKeys(key) {
  try {
    const out = await psOut(
      `(Get-ChildItem -LiteralPath 'Registry::${key.replaceAll("'", "''")}' -ErrorAction Stop | `
      + 'Select-Object -ExpandProperty PSChildName) -join \',\'')
    return out ? out.split(',').filter(Boolean) : []
  } catch { return [] }
}

/** 实测（2026-11-01）：electron-builder per-user NSIS 的卸载键名为 GUID（appId 派生），
 * 命名不可静态假设——枚举 Uninstall 根下全部子键，按「指向本临时安装目录」归属匹配
 * （UninstallString/DisplayIcon 内嵌安装路径；伴生键 HKCU\Software\<guid> 持
 * InstallLocation）。绝不触碰非本 scratch 的任何键（用户机器其他安装零影响）。 */
function ours(values, installDir) {
  if (!values) return false
  const hay = `${values.UninstallString || ''} ${values.DisplayIcon || ''}`.toLowerCase()
  return hay.includes(installDir.toLowerCase())
}
async function findUninstallKeys(installDir) {
  const found = []
  for (const name of await regSubKeys(UNINSTALL_KEY_ROOT)) {
    const values = await regQuery(`${UNINSTALL_KEY_ROOT}\\${name}`)
    if (ours(values, installDir)) {
      const companion = await regQuery(`HKCU\\Software\\${name}`)
      found.push({ name, full: `${UNINSTALL_KEY_ROOT}\\${name}`, values, companion })
    }
  }
  return found
}
async function findUninstallKey(installDir) {
  return (await findUninstallKeys(installDir))[0] || null
}

async function waitUntil(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await new Promise(r => setTimeout(r, 800))
  }
  throw new Error(`等待超时（${timeoutMs}ms）: ${what}`)
}

async function silentInstall(setup, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const child = spawn(setup, ['/S', `/D=${dest}`], { stdio: 'ignore', windowsHide: true })
  // NSIS /D= 必须最后且不带引号；oneClick per-user 无 UAC。父进程可能先行退出，
  // 以「Harbor.exe + Uninstall + HKCU 键」三要素轮询为准。
  return await waitUntil(async () => {
    const exeOk = fs.existsSync(path.join(dest, 'Harbor.exe'))
    const key = await findUninstallKey(dest)
    if (!exeOk || !key) return null
    const uninstaller = fs.readdirSync(dest).find(n => /^Uninstall .*\.exe$/i.test(n))
    return uninstaller ? { key, uninstaller } : null
  }, 240000, `NSIS 静默安装 ${dest}`)
}

async function runHeadless(installDir, configDir, fn) {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const child = spawn(path.join(installDir, 'Harbor.exe'), [], {
    cwd: configDir,
    env: {
      ...process.env,
      HARBOR_HEADLESS: '1', HARBOR_CONFIG_DIR: configDir,
      DATABASE_URL: `file:${path.join(configDir, 'harbor.db').replaceAll('\\', '/')}`,
      HOST: '127.0.0.1', PORT: String(port), LOG_LEVEL: 'silent',
      HARBOR_UPDATE_DIR: path.join(configDir, 'update'),
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  try {
    await waitUntil(async () => {
      try {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })
        return res.ok ? await res.json() : null
      } catch { return null }
    }, 90000, `/health 就绪 ${installDir}`)
    return await fn(base)
  } finally {
    try { child.kill() } catch { /* already dead */ }
    const deadline = Date.now() + 10000
    while (child.exitCode === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 300))
    try { if (child.exitCode === null) child.kill('SIGKILL') } catch { /* gone */ }
  }
}

async function silentUninstall(installDir) {
  const uninstaller = fs.readdirSync(installDir).find(n => /^Uninstall .*\.exe$/i.test(n))
  if (!uninstaller) throw new Error(`卸载器缺失: ${installDir}`)
  spawn(path.join(installDir, uninstaller), ['/S'], { stdio: 'ignore', windowsHide: true })
  // NSIS 卸载器会复制自身到 %TEMP% 再执行：以「键移除 + 目录删净」轮询为准
  await waitUntil(async () => {
    const key = await findUninstallKey(installDir)
    const dirGone = !fs.existsSync(path.join(installDir, 'Harbor.exe'))
    return !key && dirGone ? true : null
  }, 240000, `NSIS 静默卸载 ${installDir}`)
}

let evidence = { ok: false, setup: setupExe, scratch, userData }
try {
  /* A. 安装① */
  const t0 = Date.now()
  const { key: keyA, uninstaller } = await silentInstall(setupExe, path.join(scratch, 'A', 'Harbor'))
  const installA = path.join(scratch, 'A', 'Harbor')
  const installMs = Date.now() - t0
  check('②A NSIS 静默安装①（临时目录 /S /D=）产物在位', () => {
    if (!fs.existsSync(path.join(installA, 'Harbor.exe'))) throw new Error('Harbor.exe 缺失')
    if (!fs.existsSync(path.join(installA, 'resources', 'app.asar'))) throw new Error('app.asar 缺失')
  })
  check('④ HKCU 卸载键在位（per-user，键值留证）', () => {
    const v = keyA.values
    if (!String(v.DisplayName || '').includes('Harbor')) throw new Error(`DisplayName=${v.DisplayName}`)
    if (v.DisplayVersion !== '1.9.0') throw new Error(`DisplayVersion=${v.DisplayVersion}`)
    if (!v.UninstallString) throw new Error('UninstallString 缺失')
    return { key: `${UNINSTALL_KEY_ROOT}\\${keyA.name}`, values: v, uninstaller }
  })

  /* B. 隔离用户数据写会话 */
  await runHeadless(installA, userData, async base => {
    const save = await (await fetch(`${base}/jsapi/save_sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: [JSON.stringify([{
        id: 't05_persist_1', title: 'T05 卸载重装持久会话', createdAt: 1000, updatedAt: Date.now(),
        messages: [{ role: 'user', content: '卸载重装后仍在' }],
      }])] }),
    })).text()
    check('②B 隔离 CONFIG_DIR 写会话（save_sessions ok）', () => {
      if (!save.includes('"ok":true')) throw new Error(save.slice(0, 160))
    })
    const rows = JSON.parse((await (await fetch(`${base}/jsapi/get_sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"args":[]}',
    })).text()))
    check('②B 写后读回 1 会话', () => {
      if (!(rows.length === 1 && rows[0].id === 't05_persist_1')) throw new Error(JSON.stringify(rows).slice(0, 160))
    })
  })

  /* C. 卸载① */
  const t1 = Date.now()
  await silentUninstall(installA)
  const uninstallMs = Date.now() - t1
  check('②C 卸载①：安装目录删净', () => {
    if (fs.existsSync(installA)) {
      const rest = fs.readdirSync(installA)
      if (rest.length) throw new Error(`残留: ${rest.slice(0, 6).join(',')}`)
    }
  })
  {
    const keyAfter = await findUninstallKey(installA)
    check('②C 卸载①：HKCU 卸载键移除', () => {
      if (keyAfter) throw new Error(`键残留: ${UNINSTALL_KEY_ROOT}\\${keyAfter.name}`)
    })
  }
  check('②C 卸载①：隔离用户数据保留（deleteAppDataOnUninstall=false 语义代表）', () => {
    if (!fs.existsSync(path.join(userData, 'harbor.db'))) throw new Error('harbor.db 丢失')
  })

  /* D. 重装② + 会话仍在 */
  const t2 = Date.now()
  await silentInstall(setupExe, path.join(scratch, 'B', 'Harbor'))
  const reinstallMs = Date.now() - t2
  const installB = path.join(scratch, 'B', 'Harbor')
  check('②D 重装②（临时目录 /S /D=）+ HKCU 键重建', () => {
    if (!fs.existsSync(path.join(installB, 'Harbor.exe'))) throw new Error('Harbor.exe 缺失')
  })
  await runHeadless(installB, userData, async base => {
    const rows = JSON.parse((await (await fetch(`${base}/jsapi/get_sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"args":[]}',
    })).text()))
    check('②D 重装后同一 CONFIG_DIR 会话仍在（卸载保留数据语义）', () => {
      if (!(rows.length === 1 && rows[0].id === 't05_persist_1'
        && rows[0].messages?.[0]?.content === '卸载重装后仍在')) {
        throw new Error(JSON.stringify(rows).slice(0, 200))
      }
    })
  })

  /* E. 卸载②（现场清理） */
  await silentUninstall(installB)
  check('②E 卸载②：键移除 + 目录删净（现场零残留）', () => {
    if (fs.existsSync(path.join(installB, 'Harbor.exe'))) throw new Error('目录残留')
  })
  {
    const keyAfter = await findUninstallKey(installB)
    check('②E 卸载②：HKCU 卸载键移除', () => {
      if (keyAfter) throw new Error(`键残留: ${keyAfter.name}`)
    })
  }

  evidence = {
    ok: checks.every(c => c.ok), setup: setupExe, scratch, userData,
    timings: { installMs, uninstallMs, reinstallMs },
    uninstallKeyRoot: UNINSTALL_KEY_ROOT,
    checks,
  }
} catch (error) {
  evidence = { ok: false, setup: setupExe, scratch, userData,
    fatal: String(error.message || error).slice(0, 400), stack: String(error.stack || '').split('\n').slice(0, 4), checks }
  // 失败兜底清理：若本 scratch 仍有键/目录残留，尽力静默卸载（只动本 scratch 归属键）
  try {
    const key = await findUninstallKey(scratch)
    if (key) {
      const loc = (key.companion && key.companion.InstallLocation) || key.values.InstallLocation || ''
      if (loc.toLowerCase().startsWith(os.tmpdir().toLowerCase())) {
        const un = fs.readdirSync(loc).find(n => /^Uninstall .*\.exe$/i.test(n))
        if (un) spawn(path.join(loc, un), ['/S'], { stdio: 'ignore', windowsHide: true })
      }
    }
  } catch { /* 尽力而为 */ }
}

console.log(JSON.stringify(evidence, null, 1))
if (!keep && evidence.ok) {
  // scratch 清理延迟数拍（卸载器 %TEMP% 副本可能仍持有句柄）；失败现场保留待查
  await new Promise(r => setTimeout(r, 3000))
  try { fs.rmSync(scratch, { recursive: true, force: true, retryDelay: 500, maxRetries: 5 }) } catch { /* 容忍 */ }
}
process.exit(evidence.ok ? 0 : 1)
