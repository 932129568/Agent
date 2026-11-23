/* ================= v3.4 I09 · 沙箱 Hooks（写后格式化） =================
 * 目的（施工总册 I09）：写文件后自动跑格式化；**零孤儿进程泄漏**。
 *
 * 设计取舍（三条，都是为了让"零孤儿"可证）：
 *  ① 命令来自工作区的 `.harbor/hooks.json`（{ "post_write": "cmd {file}" }），按 mtime 热缓存；
 *     没有配置 ⇒ 不跑任何东西（**绝不内置一个"猜的"格式化命令**）。
 *  ② 用 `shell:true` 起进程，超时后**杀整棵进程树**（Windows: taskkill /T /F；POSIX: 杀进程组）。
 *     只 kill 直接子进程的话，`npx prettier` 这类会留一个 node 孙进程继续跑——
 *     那就是"孤儿进程"，也是这条判据的核心。
 *  ③ Hook 失败**不影响写操作本身**：写入已经成功，格式化失败只是附注（结果里带 hook 字段）。
 *     反过来，让格式化失败导致写入报错，会让 Agent 误以为文件没写进去而重写。
 *
 * 安全：命令由**用户自己的工作区文件**提供，等同用户自己配置的构建脚本；
 * 不做命令白名单（做不好反而给假安全感），但强制：超时、cwd 锁在工作区、输出截断。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const HOOK_TIMEOUT_MS = 15000
const HOOK_OUTPUT_CAP = 2000
const _cache = new Map()   // wsRoot -> { sig, config }

function _hooksPath(wsRoot) {
  return path.join(String(wsRoot || ''), '.harbor', 'hooks.json')
}

/** 读配置（mtime+size 热缓存）。形状非法一律当"没有配置"。 */
function loadHooks(wsRoot) {
  const root = String(wsRoot || '')
  if (!root) return null
  const fp = _hooksPath(root)
  let st = null
  try { st = fs.statSync(fp) } catch (e) { return null }
  const sig = st.mtimeMs + ':' + st.size
  const hit = _cache.get(root)
  if (hit && hit.sig === sig) return hit.config
  let cfg = null
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'))
    if (raw && typeof raw === 'object') cfg = raw
  } catch (e) { cfg = null }   // JSON 坏 = 没配置（不猜、不修）
  _cache.set(root, { sig, config: cfg })
  return cfg
}

/** 杀掉整棵进程树。Windows 用 taskkill /T /F；POSIX 用 -pid（进程组）。 */
function killTree(child) {
  if (!child || !child.pid) return
  try {
    if (process.platform === 'win32') {
      // detached:true 让我们拿到独立进程组；/T 连带子进程，/F 强制
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch (e) { try { child.kill('SIGKILL') } catch (e2) {} }
    }
  } catch (e) { /* 尽力而为，不抛 */ }
}

/**
 * 跑 post_write hook。返回 {ran, ok, code, ms, timedOut, output}。
 * **永不抛异常**：调用方是写文件主路径。
 */
function runPostWriteHook(wsRoot, relPath, opts = {}) {
  return new Promise((resolve) => {
    const cfg = loadHooks(wsRoot)
    const tpl = cfg && typeof cfg.post_write === 'string' ? cfg.post_write : ''
    if (!tpl) { resolve({ ran: false, ok: true, code: null, ms: 0, output: '' }); return }
    const rel = String(relPath || '').replace(/\\/g, '/')
    // 只做最朴素替换：{file} → 相对路径；不求引号转义魔法（路径里有空格由用户自己加引号）
    const cmd = tpl.split('{file}').join(rel)
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : HOOK_TIMEOUT_MS
    const t0 = Date.now()
    let out = ''
    let settled = false
    let child = null
    const finish = (payload) => {
      if (settled) return
      settled = true
      resolve({ ...payload, ms: Date.now() - t0, output: out.slice(0, HOOK_OUTPUT_CAP) })
    }
    try {
      child = spawn(cmd, {
        cwd: String(wsRoot),
        shell: true,
        detached: process.platform !== 'win32',   // POSIX 下建独立进程组，便于整组杀
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      finish({ ran: true, ok: false, code: null, error: String(e && e.message || e).slice(0, 200) })
      return
    }
    const timer = setTimeout(() => {
      try { killTree(child) } catch (e) {}
      finish({ ran: true, ok: false, code: null, timedOut: true })
    }, timeoutMs)
    const onData = (buf) => { out += String(buf || '') }
    if (child.stdout) child.stdout.on('data', onData)
    if (child.stderr) child.stderr.on('data', onData)
    child.on('error', (e) => { clearTimeout(timer); finish({ ran: true, ok: false, code: null, error: String(e && e.message || e) }) })
    child.on('close', (code) => { clearTimeout(timer); finish({ ran: true, ok: code === 0, code: code }) })
  })
}

export { HOOK_TIMEOUT_MS, HOOK_OUTPUT_CAP, loadHooks, runPostWriteHook, killTree }
