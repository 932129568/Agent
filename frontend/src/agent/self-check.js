/* ================= v3.4 I05 · 自检闭环（self-check） =================
 * 目的（施工总册 I05）：改完代码直接结束、缺少自动验证闭环。
 * 方案：**含写操作 + 配了 verifyCmd** 时，在收尾前跑一次轻自检；失败则把输出回灌给模型
 * 让它自己修（只回灌一次，避免无限往返）。
 *
 * 判据：造语法错 → Agent 宣布完成前自动发现，并把失败输出带进下一轮。
 *
 * ── 为什么 verifyCmd 要分三级 ──────────────────────────────────────────────
 * ① `session.__verifyCmd`（调用方显式给）：测试与「项目级设置」用；
 * ② 工作区 `.harbor/verify`（第一行就是命令，其余行当注释）：显式、可提交、可 review；
 * ③ `package.json` 的 scripts 里按 test > lint > build 取第一个存在的：零配置兜底。
 * 三级都没有 ⇒ **不跑**（返回 null）。绝不猜一个命令去执行——跑错命令比不跑更危险。
 *
 * ── 为什么只回灌一次 ──────────────────────────────────────────────────────
 * 自检失败可能是「模型改错」也可能是「验收命令本身不适用」。无限回灌会让一次任务
 * 卡在自检里烧钱；一次回灌足够覆盖「语法错/漏改」这类可自动修的失败。
 *
 * 依赖注入（readFile / runCommand）是为了可测：本模块不直接碰 callApi，
 * 由 run-controller 传入真实实现，用例传入桩。
 */

const SELF_CHECK_MAX_ATTEMPTS = 2;      // 首次 + 1 次修复
const SELF_CHECK_TIMEOUT_MS = 120000;

/** 从 package.json 文本里挑验收脚本：test > lint > build（只取第一个存在的）。 */
function selfCheckPickNpmScript(pkgText) {
  let pkg = null;
  try { pkg = JSON.parse(String(pkgText || '{}')); } catch (e) { return null; }
  const scripts = (pkg && pkg.scripts) || {};
  for (const key of ['test', 'lint', 'build']) {
    const v = scripts[key];
    if (typeof v === 'string' && v.trim()) return { cmd: 'npm run ' + key, script: key };
  }
  return null;
}

/**
 * 解析验收命令（三级来源）。返回 {cmd, source} 或 null。
 * @param {{readFile?:Function, session?:object}} opts readFile(path)->Promise<string|null>
 */
async function selfCheckResolveCmd(opts) {
  const o = opts || {};
  const sess = o.session || null;
  if (sess && typeof sess.__verifyCmd === 'string' && sess.__verifyCmd.trim()) {
    return { cmd: sess.__verifyCmd.trim(), source: 'session' };
  }
  const readFile = (typeof o.readFile === 'function') ? o.readFile : null;
  if (!readFile) return null;
  // ② .harbor/verify：第一行是命令，其余忽略（允许写注释）
  try {
    const raw = await readFile('.harbor/verify');
    if (typeof raw === 'string' && raw.trim()) {
      const first = raw.split(/\r?\n/).map(s => s.trim()).filter(s => s && s[0] !== '#')[0];
      if (first) return { cmd: first, source: '.harbor/verify' };
    }
  } catch (e) { /* 不存在就往下走 */ }
  // ③ package.json 脚本
  try {
    const raw = await readFile('package.json');
    const picked = selfCheckPickNpmScript(raw);
    if (picked) return { cmd: picked.cmd, source: 'package.json:' + picked.script };
  } catch (e) { /* 同上 */ }
  return null;
}

/** 执行一次验收。runCommand(cmd, timeout) -> Promise<string>（js_api 原样返回）。 */
async function selfCheckRun(runCommand, cmd, timeoutMs) {
  if (typeof runCommand !== 'function' || !cmd) return { ok: false, ran: false, code: null, output: '' };
  let raw = '';
  try {
    raw = await runCommand(cmd, timeoutMs || SELF_CHECK_TIMEOUT_MS);
  } catch (e) {
    return { ok: false, ran: true, code: null, output: '验收命令执行异常: ' + ((e && e.message) || String(e)) };
  }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
  // 约定：run_command 返回 {ok, code/exit_code, stdout/stderr} 之一；
  // 解析不了就当失败（宁可不宣布通过），并把原文带上让人能看。
  const code = parsed && (parsed.code != null ? parsed.code : parsed.exit_code);
  const ok = !!(parsed && parsed.ok === true && (code == null || code === 0));
  const output = parsed
    ? [parsed.stdout, parsed.stderr].filter(x => typeof x === 'string' && x).join('\n')
    : String(raw || '');
  return { ok: ok, ran: true, code: code == null ? null : code, output: output.slice(0, 4000) };
}

/**
 * 收尾前的一次自检（供 run-controller 在「本轮有写操作」时调用）。
 * 返回 {ran, ok, injected, cmd, source, output}；`injected=true` 表示已把失败输出
 * 追加成一条 system 消息，调用方应让循环再跑一轮。
 */
async function selfCheckAfterWrites(opts) {
  const o = opts || {};
  const session = o.session || null;
  const run = o.run || null;
  if (!session) return { ran: false, ok: false, injected: false, reason: 'no-session' };
  const attempts = (run && run.verifyAttempts) || 0;
  if (attempts >= SELF_CHECK_MAX_ATTEMPTS) return { ran: false, ok: false, injected: false, reason: 'attempts-exhausted' };
  const resolved = await selfCheckResolveCmd({ readFile: o.readFile, session });
  if (!resolved) return { ran: false, ok: false, injected: false, reason: 'no-verify-cmd' };
  const res = await selfCheckRun(o.runCommand, resolved.cmd, o.timeoutMs);
  if (run) run.verifyAttempts = attempts + 1;
  if (res.ok) {
    session.__verifyLast = { ok: true, cmd: resolved.cmd, source: resolved.source, at: Date.now() };
    return { ran: true, ok: true, injected: false, cmd: resolved.cmd, source: resolved.source };
  }
  // 失败 ⇒ 回灌一条 system（带命令与截断后的输出），让模型自己修
  if (Array.isArray(session.messages) && typeof o.pushSystem === 'function') {
    o.pushSystem(session, '【自动验收未通过】命令：`' + resolved.cmd + '`（来源：' + resolved.source +
      '）\n输出（截断）：\n' + (res.output || '(无输出)') +
      '\n请修复上面报告的问题后重新完成；若判定该验收命令不适用，请说明原因而不要反复重试。');
  }
  session.__verifyLast = { ok: false, cmd: resolved.cmd, source: resolved.source, at: Date.now() };
  return { ran: true, ok: false, injected: true, cmd: resolved.cmd, source: resolved.source, output: res.output };
}
