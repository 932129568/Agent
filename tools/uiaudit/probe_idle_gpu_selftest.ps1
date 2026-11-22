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
      D  真实 Harbor 进程树                → 必须 MEASURED 且 matchedInstances > 0
                                         若本机没有 Harbor 进程，此组判 SKIP（如实标注，
                                         不许把"没环境"算成"通过"）

.PARAMETER WarmupSeconds
    传给被测探针的静置秒数。默认 1（负控不关心数值稳定性，只关心状态机）。
.PARAMETER Samples
    传给被测探针的采样点数。默认 3（最少值，`< 3` 会被探针判非法参数）。

.OUTPUTS
    逐行文本。退出码：
      0 = 四组全部 as-expected（含 SKIP 时不失败，但会显式计数并打印）
      1 = 有任何一组不符合预期

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
$harborPids = @()
foreach ($n in @('WorkBuddy', 'msedgewebview2')) {
    $harborPids += @(Get-Process -Name $n -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
}
$harborPids = @($harborPids | Sort-Object -Unique)

if ($harborPids.Count -eq 0) {
    $results += Test-Expect -Id 'D' -What 'real Harbor process tree -> MEASURED' `
        -Result @{ Rc = 0; Out = '' } -WantRc 0 `
        -Skip:$true -SkipReason 'no Harbor/WebView2 process running on this machine'
}
else {
    $rD = Invoke-Probe -ExtraArgs @('-TargetPid', ($harborPids -join ','))
    $results += Test-Expect -Id 'D' -What "real Harbor tree ($($harborPids.Count) pids) -> MEASURED, one verdict line" `
        -Result $rD -WantRc $(if ($rD.Rc -eq 0) { 0 } else { 1 }) -WantSubstring 'MEASURED' -AllowVerdictLine
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

if ($nFail -gt 0) {
    Write-Output ('{0}: FAIL | scope negative-controls must all go blocked; a passing fake PID means the probe is tautological' -f $RIG)
    exit 1
}
Write-Output ('{0}: PASS | scope negative-controls all as-expected' -f $RIG)
exit 0