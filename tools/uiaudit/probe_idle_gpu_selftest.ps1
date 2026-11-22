<#
.SYNOPSIS
    静置 GPU 探针的作用域负控（防止「假 PID 也 PASS」这类恒真门复发）。

.DESCRIPTION
    为什么需要这个脚本：
    2026-11-22 实测发现 probe_idle_gpu.ps1 曾有一个**恒真门** ——
        -TargetPid 999999（根本不存在的 PID）→ rc=0 + "PASS | p95 = 0%"
    根因：滤波在采样循环里用 continue 跳过不匹配实例，从不统计「命中几个」；
          空集保护只检查「整机有没有实例」，不检查「你测的那个集合有没有实例」。
    ⇒ 任何 PID 写错 / 进程没起来 / 作用域取错，都会静默变绿。
    这是"恒假门与恒真门同族"里更危险的一类，因为它藏在主判决位上。

    教训（写进判据，不是写进注释就完事）：
        **空集保护要保护「你测的那个集合」，不是「存在的那个集合」。**
    同类错误会在「按用户筛选」「按时间窗筛选」「按 label 筛选」的判据上重演。

    本脚本把修复固化成可复跑的负控。**只看 rc 不够** —— 必须同时断言
    「blocked 组输出里不出现 PASS 字样」，因为「rc=2 但输出仍有 PASS 行」
    这种半修状态最容易发生。

    四组对照（缺一不可）：
      A  假 PID（999999）                → 必须 rc=2 + NO_INSTANCES + 输出无 PASS
      B  真实存在但无 3D 实例的进程       → 必须 rc=2 + NO_INSTANCES + 输出无 PASS
                                         这是 Q13 的 N0 判据：Harbor 完全退出时同口径
                                         必须走到 NO_INSTANCES。用自身 PID 做代理样本，
                                         因为 PowerShell 进程几乎必然没有 engtype_3D 实例。
      C  不带 -TargetPid（整机）           → 必须 MEASURED（证明正常路径没被改坏）
      D  真实 Harbor 进程树                → 必须 MEASURED 且判决行/JSON 里能看到 `Harbor`
                                         候选名单 = Harbor / harbor-desktop（**Harbor 优先**）。
                                         本机若没有 Harbor 进程，此组判 SKIP，并在总判决里
                                         显式声明「Q13 的 Harbor 口径未被本轮覆盖」。
                                         **不许用 WorkBuddy 顶替 Harbor** —— 那是测错对象。
      D2 Electron 宿主代理（WorkBuddy + msedgewebview2）
                                         → 仅作用域演练，标签写死 `NOT Harbor`，
                                         不可作为 Q13 验收依据。D 组 SKIP 时它仍然跑，
                                         因为它验证的是「多进程过滤」这个机制本身。

.PARAMETER WarmupSeconds
    传给被测探针的静置秒数。默认 1（负控不关心数值稳定性，只关心状态机）。
.PARAMETER Samples
    传给被测探针的采样点数。默认 3（最少值，`< 3` 会被探针判非法参数）。

.OUTPUTS
    逐行文本。退出码：
      0 = 全部 as-expected **且** D 组（Harbor 口径）真的测到了
      1 = 有任何一组不符合预期
      3 = 负控全部 as-expected，但 D 组被 SKIP ⇒ **Q13 的 Harbor 口径本轮未覆盖**
          （不是失败，但也**不是绿**。用独立 rc 是为了防止「没环境」被当成「通过」；
           这正是本仓「blocked-by-environment 不等于 0%」的同一条纪律。）

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools/uiaudit/probe_idle_gpu_selftest.ps1
.NOTES
    纯只读：只调用被测探针（其本身只 Get-Counter 读性能计数器）。
    不启动/不结束任何业务进程；自身 PID 来自 $PID（只读自动变量，不可被参数同名覆盖）。
    不写任何仓内文件。文件为 UTF-8 带 BOM（同 probe_idle_gpu.ps1 的编码契约）。
#>
[CmdletBinding()]
param(
    [int]$WarmupSeconds = 1,
    [int]$Samples = 3
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$HERE = Split-Path -Parent $MyInvocation.MyCommand.Path
$PROBE = Join-Path $HERE 'probe_idle_gpu.ps1'
$RIG = 'gpu_selftest'

if (-not (Test-Path $PROBE)) {
    Write-Output ('{0}: FAIL | probe not found at {1}' -f $RIG, $PROBE)
    exit 1
}

$PS5 = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $PS5)) { $PS5 = 'powershell.exe' }

<#
运行被测探针并返回 @{ Rc; Out }。
必须用 & 直接调用 + $LASTEXITCODE，**不许用管道套 Select-String 取 rc** ——
`probe.ps1 | Select-String xxx` 的 rc 是 Select-String 的（恒 0），
这是本项目实测踩过的坑（管道掩盖 rc）。
#>
function Invoke-Probe {
    param([string[]]$ExtraArgs = @())

    $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PROBE,
        '-WarmupSeconds', "$WarmupSeconds", '-Samples', "$Samples") + $ExtraArgs
    $out = & $PS5 @argv 2>&1 | Out-String
    return @{ Rc = $LASTEXITCODE; Out = $out }
}

<#
判定一条负控是否「真的红了且红得对」。

**重要**：这个函数**不调用 Write-Output**。PowerShell 里函数的 Write-Output
会混进返回值流，被 `$results +=` 一起收进数组 ⇒ 明细行永远打不出来
（这本身是我第一版踩的 bug，实测：只看到汇总行，看不到 [PASS] 明细）。
所以这里只**返回** hashtable（含 Detail 文本），由调用方负责打印。

两条都满足才算 PASS：
  1) rc == 期望的 rc
  2) 关键的**语义子串**出现 / 不出现
单看 rc 会漏掉「rc=2 但输出仍有一行 PASS」这种半修状态。

**判决行判据必须是结构匹配，不是关键词匹配**（team-lead 纠正过一版）：
说明文字里出现「PASS」是**合理的** —— "Refusing to report 0% as a passing measurement"
正是在解释「为什么不出 PASS」。用 `-match 'PASS'` 做判定 = 把**解释**当成**结论**。
（而且 PowerShell 的 `-match` 默认**不区分大小写**，`-cmatch` 才区分，
这一点本身就会让关键词判据产生假阳性。）

正确判据：只认**判决行的结构** —— `<RIG>: PASS|FAIL | p95 ...`
这与本仓「规则/说明行禁复用判决量 KEY」是同一条纪律。
#>
function Test-Expect {
    param(
        [string]$Id,
        [string]$What,
        [hashtable]$Result,
        [int]$WantRc,
        [string]$WantSubstring = '',
        [string]$ForbidSubstring = '',
        [switch]$AllowVerdictLine,       # 默认禁止出现判决行
        [string]$RequireProcessName = '', # 判决行/JSON 里必须看得到这个进程名
        [string[]]$ResolvedNames = @(),   # 探针 -Json 里的 resolvedProcessNames
        [switch]$Skip,
        [string]$SkipReason = ''
    )

    if ($Skip) {
        return @{ Id = $Id; Status = 'SKIP'; Detail = ('{0} [SKIP] {1}' -f $Id, $SkipReason); Raw = '' }
    }

    $problems = @()
    if ($Result.Rc -ne $WantRc) { $problems += "rc=$($Result.Rc) want=$WantRc" }
    if ($WantSubstring -and ($Result.Out -cnotmatch [regex]::Escape($WantSubstring))) {
        $problems += "missing '$WantSubstring'"
    }
    if ($ForbidSubstring -and ($Result.Out -cmatch [regex]::Escape($ForbidSubstring))) {
        $problems += "MUST-NOT-APPEAR '$ForbidSubstring' is present"
    }

    # 判决行计数：结构匹配，不看散落的关键词。
    # '^<RIG>: (PASS|FAIL) | p95' —— 只有探针的 Write-Verdict 会产出这种行。
    $verdictPattern = '^\S+: (PASS|FAIL) \| p95'
    $verdictLines = @($Result.Out -split "`n" | Where-Object { $_.Trim() -match $verdictPattern })
    if ($AllowVerdictLine) {
        if ($verdictLines.Count -ne 1) {
            $problems += "verdict-line count=$($verdictLines.Count) want=1"
        }
    }
    else {
        if ($verdictLines.Count -ne 0) {
            $problems += "verdict-line count=$($verdictLines.Count) want=0 (blocked 组不该有判决行)"
        }
    }

    # 「测的进程名 == 标签写的进程名」这一条只能靠**反查清单**判定，不能靠全文 grep。
    # 反例：探针在作用域里没有 Harbor 时会打印
    #   'NOTICE scope contains no process named "Harbor"'
    # —— 全文 grep 'Harbor' 会命中这行，从而把「明确不是 Harbor」判成「测到了 Harbor」。
    # 这正是本仓反复出现的「关键词判定把解释当成结论」。
    # 所以只认 resolvedProcessNames 里的 `<pid>:<name>` 结尾匹配。
    if ($RequireProcessName) {
        $wantSuffix = ':' + $RequireProcessName + '$'
        $hit = @($ResolvedNames | Where-Object { $_ -match $wantSuffix }).Count
        if ($hit -lt 1) {
            $problems += ("resolvedProcessNames lacks ':$RequireProcessName' (got: " +
                $(if ($ResolvedNames.Count -gt 0) { $ResolvedNames -join ',' } else { '<empty>' }) + ')')
        }
        if ($Result.Out -cmatch 'NOTICE scope contains no process named') {
            $problems += "probe itself declared the scope is NOT $RequireProcessName"
        }
    }

    if ($problems.Count -eq 0) {
        return @{
            Id = $Id; Status = 'PASS'
            Detail = ('{0} [PASS] {1} (rc={2})' -f $Id, $What, $Result.Rc)
            Raw = ''
        }
    }
    return @{
        Id = $Id; Status = 'FAIL'
        Detail = ('{0} [FAIL] {1} (rc={2}) -> {3}' -f $Id, $What, $Result.Rc, ($problems -join '; '))
        Raw = $Result.Out
    }
}

Write-Output ('{0}: probe = {1}' -f $RIG, $PROBE)
Write-Output ('{0}: warmup={1}s samples={2}' -f $RIG, $WarmupSeconds, $Samples)

$results = @()

# ── A：假 PID ────────────────────────────────────────────────────────────────
# 判据是「判决行数 == 0」，不是「全文不含 PASS 字样」—— 见 Test-Expect 的注释。
$rA = Invoke-Probe -ExtraArgs @('-TargetPid', '999999')
$results += Test-Expect -Id 'A' -What 'fake PID 999999 -> NO_INSTANCES, zero verdict lines' `
    -Result $rA -WantRc 2 -WantSubstring 'NO_INSTANCES'

# ── B：真实存在但无 3D 实例的进程（N0 判据代理样本）──────────────────────────
# 用自身 PID：PowerShell 进程必然存在，但不会持有 engtype_3D 实例。
# 这正是 Q13 的 N0 语义 —— 「进程在，但它没有 3D 活动」必须报 NO_INSTANCES，
# 而不是报 0% 通过。原缺陷对这种情况同样会静默变绿。
$rB = Invoke-Probe -ExtraArgs @('-TargetPid', "$PID")
$results += Test-Expect -Id 'B' -What "real-but-no-3D pid $PID -> NO_INSTANCES, zero verdict lines" `
    -Result $rB -WantRc 2 -WantSubstring 'NO_INSTANCES'

# ── C：整机口径必须仍然可用（防「修负控把主路径修坏」）──────────────────────
$rC = Invoke-Probe
$hasMachine = ($rC.Out -cmatch 'MEASURED')
$results += Test-Expect -Id 'C' -What 'whole-machine -> MEASURED, exactly one verdict line' `
    -Result $rC -WantRc $(if ($rC.Rc -eq 0) { 0 } else { 1 }) -WantSubstring 'MEASURED' `
    -AllowVerdictLine `
    -Skip:(-not $hasMachine) -SkipReason 'no machine instances in this environment'

# ── D：真实 Harbor 进程树 ───────────────────────────────────────────────────
# 名字必须与实测一致：这一组叫 Harbor，候选名单里就**必须**有 Harbor。
# 历史缺陷（本仓实测，第三次同族问题）：
#   候选名单是 @('WorkBuddy','msedgewebview2')，-What 却写 "real Harbor tree"。
#   Get-Process -Name Harbor 在同一台机器上恒为 0，10 + 17 = 27 pids 全部来自
#   WorkBuddy（本仓库的开发工具本体）。标签读起来成立，但没人核对它指向什么。
#   后果：Q13 的验收口径是「只测 Harbor 自己的 3D 占用」，若接这个口径，
#   等于在验收 WorkBuddy 烧多少 GPU，与 Harbor 无关 —— 测错对象的典型。
# ⇒ 修法：Harbor 优先；Harbor 不在就 SKIP（不许 WorkBuddy 顶替）；
#   代理组单独立成 D2 并在标签里写明 NOT Harbor。
$harborNames = @('Harbor', 'harbor-desktop')
$harborPids = @()
foreach ($n in $harborNames) {
    $harborPids += @(Get-Process -Name $n -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
}
$harborPids = @($harborPids | Sort-Object -Unique)

if ($harborPids.Count -eq 0) {
    # SKIP 不是绿：汇总里会计入 $nSkip，总判决行必须显式声明 Q13 未覆盖。
    $results += Test-Expect -Id 'D' -What 'real Harbor process tree -> MEASURED, verdict line must name Harbor' `
        -Result @{ Rc = 0; Out = '' } -WantRc 0 `
        -Skip:$true -SkipReason ('no process named Harbor / harbor-desktop on this machine ' +
        '(tried: ' + ($harborNames -join ', ') + '); Q13 Harbor-scope acceptance NOT covered by this run')
}
else {
    $rD = Invoke-Probe -ExtraArgs @('-TargetPid', ($harborPids -join ','), '-Json')
    $rDnames = @()
    $mNames = [regex]::Match($rD.Out, '"resolvedProcessNames":\[([^\]]*)\]')
    if ($mNames.Success) { $rDnames = @($mNames.Groups[1].Value -split ',' | ForEach-Object { $_.Trim('"', ' ') }) }
    $results += Test-Expect -Id 'D' -What "real Harbor tree ($($harborPids.Count) pids) -> MEASURED, verdict line names Harbor" `
        -Result $rD -WantRc $(if ($rD.Rc -eq 0) { 0 } else { 1 }) -WantSubstring 'MEASURED' `
        -RequireProcessName 'Harbor' -ResolvedNames $rDnames -AllowVerdictLine
}

# ── D2：Electron 宿主代理（口径演练，明确 NOT Harbor）────────────────────────
# 存在的理由：本机常常没有 Harbor.exe（仓规禁止主动启动 dist/Harbor.exe），
# 但「多进程 Electron 宿主」的作用域行为仍需演练。**它不能作为 Q13 的验收依据**，
# 所以标签里写死 NOT Harbor，且 never 用 Harbor 这个名字。
$proxyPids = @()
foreach ($n in @('WorkBuddy', 'msedgewebview2')) {
    $proxyPids += @(Get-Process -Name $n -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
}
$proxyPids = @($proxyPids | Sort-Object -Unique)

if ($proxyPids.Count -eq 0) {
    $results += Test-Expect -Id 'D2' -What 'proxy replay (NOT Harbor) -> MEASURED' `
        -Result @{ Rc = 0; Out = '' } -WantRc 0 `
        -Skip:$true -SkipReason 'no WorkBuddy / msedgewebview2 process on this machine'
}
else {
    $rD2 = Invoke-Probe -ExtraArgs @('-TargetPid', ($proxyPids -join ','), '-Json')
    $results += Test-Expect -Id 'D2' -What "proxy replay: WorkBuddy+msedgewebview2, NOT Harbor ($($proxyPids.Count) pids) -> MEASURED" `
        -Result $rD2 -WantRc $(if ($rD2.Rc -eq 0) { 0 } else { 1 }) -WantSubstring 'MEASURED' -AllowVerdictLine
}

# ── 汇总（先打印明细，再判总账）────────────────────────────────────────────
Write-Output ''
foreach ($r in $results) {
    Write-Output ('{0} {1}' -f $RIG, $r.Detail)
    if ($r.Status -eq 'FAIL' -and $r.Raw) {
        Write-Output ('{0} {1} --- raw output of the probe under test ---' -f $RIG, $r.Id)
        foreach ($line in ($r.Raw -split "`n")) {
            if ($line.Trim() -ne '') { Write-Output ('{0} {1}   | {2}' -f $RIG, $r.Id, $line.TrimEnd()) }
        }
    }
}
Write-Output ''

$nFail = @($results | Where-Object { $_.Status -eq 'FAIL' }).Count
$nSkip = @($results | Where-Object { $_.Status -eq 'SKIP' }).Count
$nPass = @($results | Where-Object { $_.Status -eq 'PASS' }).Count

Write-Output ('{0}: {1} PASS / {2} FAIL / {3} SKIP' -f $RIG, $nPass, $nFail, $nSkip)

# D 组是否被 SKIP —— 决定 rc 是 0（真覆盖）还是 3（未覆盖口径）。
# 不能因为 SKIP 就报 PASS：Q13 的验收口径是「Harbor 进程树的 3D 占用」，
# 本机没有 Harbor 时，那一口径**一条证据都没有**。把它算绿 = 「没环境算通过」。
$dStatus = (@($results | Where-Object { $_.Id -eq 'D' }) | Select-Object -First 1).Status
if (-not $dStatus) { $dStatus = 'MISSING' }

if ($nFail -gt 0) {
    Write-Output ('{0}: FAIL | scope negative-controls must all go blocked; a passing fake PID means the probe is tautological' -f $RIG)
    exit 1
}
if ($nSkip -gt 0) {
    # 行先拼好再输出（本仓踩过 -f 优先级坑：`"a{0} " + "b{1}" -f $x,$y` 只会格式化后半段）
    $incompleteLine = ('{0}: INCOMPLETE | {1} group(s) skipped; D={2} -> Q13 Harbor-scope acceptance is NOT covered by this run' -f $RIG, $nSkip, $dStatus)
    Write-Output $incompleteLine
    $noteLine = ('{0}: note | negative-controls themselves are all as-expected; this rc=3 is NOT a failure and NOT a pass (blocked-by-environment, same discipline as the probe''s own NO_INSTANCES trap)' -f $RIG)
    Write-Output $noteLine
    exit 3
}
Write-Output ('{0}: PASS | scope negative-controls all as-expected' -f $RIG)
exit 0