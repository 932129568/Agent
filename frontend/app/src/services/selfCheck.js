/**
 * 写文件后自动验收自检闭环（继承 I05 全部行为钉）：
 * 三级解析 verifyCmd（绝不盲猜命令）：
 *   1) session.__verifyCmd
 *   2) 工作区 .harbor/verify（首行非空非注释行）
 *   3) package.json scripts（test > lint > build）
 * 失败仅回灌模型一次，防止无限烧钱循环。
 */
export function pickNpmVerifyScript(pkgText) {
  let pkg = null
  try { pkg = JSON.parse(String(pkgText || '{}')) } catch { return null }
  const scripts = (pkg && pkg.scripts) || {}
  for (const key of ['test', 'lint', 'build']) {
    if (typeof scripts[key] === 'string' && scripts[key].trim()) {
      return { cmd: `npm run ${key}`, source: `package.json:${key}` }
    }
  }
  return null
}

export async function resolveVerifyCmd({ session = null, readFile } = {}) {
  if (session && typeof session.__verifyCmd === 'string' && session.__verifyCmd.trim()) {
    return { cmd: session.__verifyCmd.trim(), source: 'session' }
  }
  if (typeof readFile !== 'function') return null
  try {
    const hv = await readFile('.harbor/verify')
    if (typeof hv === 'string' && hv.trim()) {
      const first = hv.split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('#'))
      if (first) return { cmd: first, source: '.harbor/verify' }
    }
  } catch {}
  try {
    const pkg = await readFile('package.json')
    if (typeof pkg === 'string' && pkg.trim()) {
      const picked = pickNpmVerifyScript(pkg)
      if (picked) return picked
    }
  } catch {}
  return null
}

export async function runSelfCheckAfterWrites({ session, readFile, runCommand }) {
  const resolved = await resolveVerifyCmd({ session, readFile })
  if (!resolved) return { ran: false, ok: true, reason: 'no_verify_cmd' }
  if (typeof runCommand !== 'function') return { ran: false, ok: false, reason: 'no_runner' }
  try {
    const raw = await runCommand(resolved.cmd, 120)
    let parsed = raw
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw) } catch { parsed = { ok: true, output: raw } }
    }
    const exitCode = Number(parsed && parsed.exit_code)
    const failed = (parsed && parsed.ok === false) || (parsed && parsed.error) || (Number.isFinite(exitCode) && exitCode !== 0)
    const output = String((parsed && (parsed.stderr || parsed.output || parsed.error)) || '').slice(0, 2000)
    return {
      ran: true,
      ok: !failed,
      cmd: resolved.cmd,
      source: resolved.source,
      output,
      feedbackMessage: failed
        ? `【自动验收自检未通过】已执行 \`${resolved.cmd}\`（来源：${resolved.source}），退出异常：\n\`\`\`\n${output}\n\`\`\`\n请定位报错根因并直接修复后再收尾。`
        : '',
    }
  } catch (e) {
    return { ran: true, ok: false, cmd: resolved.cmd, source: resolved.source, reason: String(e && e.message || e), output: '' }
  }
}
