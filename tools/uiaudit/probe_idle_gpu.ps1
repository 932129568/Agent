<#
.SYNOPSIS
    静置态核显 3D 引擎占用采样探针（支撑「静置 GPU <= 0.5%」红线）。

.DESCRIPTION
    为什么需要这个脚本：仓内 tools/perf_*.py 全部只采进程级计数器（CPU / 工作集 /
    GDI 对象），没有任何 GPU 占用采集器。核显（Intel / AMD 集成显卡）没有
    nvidia-smi 这类厂商工具，唯一可用的标准路径是 Windows 性能计数器
    '\GPU Engine(*engtype_3D)\Utilization Percentage'。判据未建之前，
    「<= 0.5%」只能算设计意图，不能写进验收 —— 本脚本就是把它变成可执行判据。

    采样纪律（三条，缺一条数字就不可信）：
      1. 必须先静置（默认 WarmupSeconds=10），等入场动画、光标闪烁、CSS 无限循环
         动画全部进入稳定周期后再采 —— 否则采到的是入场阶段的峰值，不是静置态。
      2. 必须多采样取中位数 + p95，不能用单次读数。GPU Engine 计数器本身是
         间隔平均，单次读数抖动可达数个百分点。
      3. 必须报告「哪些进程在贡献占用」。占用 <= 0.5% 但有 20 个实例各 0.1%，
         和只有 1 个实例 0.4% 是两件不同的事（后者才是 Harbor 自己的代价）。

    计数器的已知陷阱（写进判据，不是写进注释就完事）：
      · 实例名形如 pid_10248_luid_0x0000_0x0000cee8_phys_0_eng_0_engtype_3D。
        同一进程可能出现在多个 engtype（3D / Copy / VideoDecode / Compute），
        只采 engtype_3D，否则会把视频解码占用算进 3D 红线。
      · 多 GPU（核显 + 独显）时实例的 luid 不同。默认全部采，但按 luid 分组
        单独输出，避免把两张卡的占用加总成一个不存在的「总占用」。
      · 计数器在无 GPU 活动的机器上可能返回空集（不是 0），必须区分
        NO_INSTANCES / ZERO_ACTIVITY / MEASURED 三种状态，不能把空集当 0%。

.PARAMETER WarmupSeconds
    采样前静置秒数。默认 10。必须是整数。
.PARAMETER Samples
    采样点数。默认 9（奇数，中位数落在中间那个点上，不需要插值）。
.PARAMETER Threshold
    红线百分比阈值。默认 0.5。
.PARAMETER TargetPid
    只统计指定进程 id（逗号分隔）。默认空 = 统计全机 3D 引擎总和。
    注意：不能叫 -Pid —— $Pid 是 PowerShell 的只读自动变量（当前进程 id），
    同名参数会在参数绑定阶段直接抛「无法覆盖变量 Pid，因为它是只读变量或常量」。
.PARAMETER Json
    额外输出一行机器可读 JSON（供 CI 解析）。给开关即输出，默认不输出。

.OUTPUTS
    逐行文本；最后一行是结论行。退出码：
      0 = MEASURED 且通过阈值
      1 = MEASURED 但超过阈值
      2 = blocked-by-environment（计数器不可用 / 无实例 / 采样失败）

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools/uiaudit/probe_idle_gpu.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools/uiaudit/probe_idle_gpu.ps1 -WarmupSeconds 20 -Samples 15 -Json
.NOTES
    纯只读：只用 Get-Counter 读性能计数器，不启动/不结束/不修改任何进程。
    不写任何仓内文件。文件名为纯 ASCII。

    编码契约（实测踩出来的，不能删）：
    本文件是 UTF-8 **带 BOM**，且必须一直带 BOM。原因是 Windows PowerShell 5.1
    （powershell.exe，Win10/11 自带，上面 .EXAMPLE 用的就是它）读取 .ps1 时
    不做 UTF-8 探测，直接按当前 ANSI 代码页（本机 CP936）解码。本文件含中文
    注释（62 行非 ASCII），无 BOM 时 CP936 解码会把全角括号/引号拆成非法字节
    序列，导致引号配对错乱、花括号不平衡，在 104/106 行抛
    「表达式或语句中包含意外的标记"}"」——文件整体不可执行。
    已验证：无 BOM -> PS5.1 解析 2 个错误；带 BOM -> 0 个错误。
    只有 PowerShell 7（pwsh）默认按 UTF-8 读，所以这个坑在 pwsh 下不会暴露。
    注意：本文件内容**不是**纯 ASCII，早先版本此处注释误写为「内容亦全 ASCII」，
    已更正 —— 判据脚本的注释必须与事实一致，否则会误导后来的人去掉 BOM。
#>
[CmdletBinding()]
param(
    [int]$WarmupSeconds = 10,
    [int]$Samples = 9,
    [double]$Threshold = 0.5,
    [string]$TargetPid = '',
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$COUNTER = '\GPU Engine(*engtype_3D)\Utilization Percentage'
$RIG = 'probe_idle_gpu'

function Write-Verdict([string]$state, [string]$detail) {
    Write-Output ('{0}: {1} | {2}' -f $RIG, $state, $detail)
}

function Write-Blocked([string]$reason) {
    Write-Verdict 'blocked-by-environment' $reason
    if ($Json) {
        Write-Output (@{ state = 'blocked-by-environment'; reason = $reason } | ConvertTo-Json -Compress)
    }
    exit 2
}

# ---- 参数自检（非法参数一律 blocked，不做静默纠正）----------------------------
if ($Samples -lt 3) { Write-Blocked "Samples=$Samples 太少；少于 3 点无法给出有意义的 p95" }
if ($Samples % 2 -eq 0) {
    # 偶数点会让中位数落在两值之间；不报错，但必须在结论里标明口径
    $medianNote = 'even-sample median = average of middle two'
} else {
    $medianNote = 'odd-sample median = middle value'
}
if ($WarmupSeconds -lt 0) { Write-Blocked "WarmupSeconds=$WarmupSeconds 非法（必须 >= 0）" }

# -TargetPid 过滤器：空 = 全机；非空则只累加这些 pid 的实例
$pidFilter = @()
if ($TargetPid -and $TargetPid.Trim() -ne '') {
    foreach ($piece in ($TargetPid -split ',')) {
        $t = $piece.Trim()
        if ($t -eq '') { continue }
        $parsed = 0
        if (-not [int]::TryParse($t, [ref]$parsed)) { Write-Blocked "TargetPid 含非法 pid '$t'（必须为整数）" }
        if ($parsed -le 0) { Write-Blocked "TargetPid 含非法 pid '$t'（必须为正整数）" }
        $pidFilter += $parsed
    }
    if ($pidFilter.Count -eq 0) { Write-Blocked 'TargetPid 给了解析后为空的列表' }
}
$filterActive = ($pidFilter.Count -gt 0)

# ---- 平台与计数器前置检查（fail-closed：不可用就是 blocked，不是 0%）----------
$onWin = $true
if ($PSVersionTable.PSEdition -eq 'Core') { $onWin = $IsWindows }
if (-not $onWin) { Write-Blocked 'only Windows exposes the GPU Engine performance counter set' }

try {
    $counterSet = Get-Counter -ListSet 'GPU Engine' -ErrorAction Stop
} catch {
    Write-Blocked "counter set 'GPU Engine' not present (WDDM 2.0+ / Win10 1709+ required): $($_.Exception.Message)"
}

if (-not (@($counterSet.Paths) | Where-Object { $_ -match 'Utilization Percentage' })) {
    Write-Blocked "counter set exists but exposes no 'Utilization Percentage' counter; available: $(@($counterSet.Paths) -join ' | ')"
}
# 注意：-ListSet 返回的 Paths 是**模板路径**（形如 \GPU Engine(*)\Utilization Percentage），
# 不是已展开的实例名。所以「有没有 engtype_3D 实例」只能在真正 Get-Counter 采样后判定，
# 不能在路径模板上 grep engtype_3D —— 那样永远匹配不到，会把可用环境误判成 blocked。

# ---- 静置（关键：入场动画未结束时采样会采到峰值）------------------------------
if ($WarmupSeconds -gt 0) {
    Write-Output ('{0}: warmup {1}s (让入场动画与首次布局结算完成，否则采到的是峰值而非静置态)' -f $RIG, $WarmupSeconds)
    Start-Sleep -Seconds $WarmupSeconds
}

# ---- 采样 ---------------------------------------------------------------------
$sampleTotals = @()          # 每次采样的「全机 3D 占用总和」
$perPid  = @{}          # pid -> 累计贡献（用于报告「谁在占用」）
$perLuid = @{}          # luid -> 累计总和（多 GPU 时分开看）
$instanceCounts = @()

for ($i = 1; $i -le $Samples; $i++) {
    try {
        $reading = Get-Counter -Counter $COUNTER -ErrorAction Stop
    } catch {
        Write-Blocked "Get-Counter failed on sample $i/$($Samples): $($_.Exception.Message)"
    }
    $cs = @($reading.CounterSamples)
    $instanceCounts += $cs.Count
    $sum = 0.0
    foreach ($s in $cs) {
        $v = [double]$s.CookedValue
        if ([double]::IsNaN($v) -or [double]::IsInfinity($v)) { continue }
        # 实例名解析：pid_10248_luid_0x0000_0x0000cee8_phys_0_eng_0_engtype_3D
        $name = [string]$s.InstanceName
        $m = [regex]::Match($name, '^pid_(\d+)_luid_0x([0-9a-fA-F]+)_0x([0-9a-fA-F]+)_')
        if ($m.Success) {
            $p = [int]$m.Groups[1].Value
            $luid = ($m.Groups[2].Value + ':' + $m.Groups[3].Value).ToLower()
            if (-not $perPid.ContainsKey("$p")) { $perPid["$p"] = 0.0 }
            $perPid["$p"] += $v
            if (-not $perLuid.ContainsKey($luid)) { $perLuid[$luid] = 0.0 }
            $perLuid[$luid] += $v
            if ($filterActive -and -not ($pidFilter -contains $p)) { continue }
            $sum += $v
        } elseif (-not $filterActive) {
            # 实例名不含 pid（极少数驱动/会话）→ 只在全机模式下计入总和
            $sum += $v
        }
    }
    $sampleTotals += $sum
}

$totalInstances = ($instanceCounts | Measure-Object -Sum).Sum

# 空集 ≠ 0%：计数器返回 0 个实例说明「没有进程在用 3D 引擎」或「驱动不上报」，
# 这两种情况必须显式区分，否则会把「测不到」当成「很干净」。
if ($sampleTotals.Count -eq 0 -or $totalInstances -eq 0) {
    Write-Blocked "counter returned 0 instances across $Samples samples; cannot distinguish 'no 3D activity' from 'driver does not report' (refusing to report 0%)"
}

$sorted = @($sampleTotals | Sort-Object)
$median = if ($Samples % 2 -eq 1) {
    $sorted[[int][math]::Floor($Samples / 2)]
} else {
    ($sorted[($Samples / 2) - 1] + $sorted[$Samples / 2]) / 2.0
}
# p95：最近秩法（nearest-rank），不做插值 —— 采样点少时插值会造出不存在的值
$rank95 = [int][math]::Ceiling(0.95 * $Samples)
if ($rank95 -lt 1) { $rank95 = 1 }
if ($rank95 -gt $Samples) { $rank95 = $Samples }
$p95 = $sorted[$rank95 - 1]
$max = $sorted[$Samples - 1]
$min = $sorted[0]
$mean = ($sampleTotals | Measure-Object -Average).Average

# ---- 输出 ---------------------------------------------------------------------
Write-Output ('{0}: counter = {1}' -f $RIG, $COUNTER)
Write-Output ('{0}: warmup = {1}s | samples = {2} | threshold = {3}%' -f $RIG, $WarmupSeconds, $Samples, $Threshold)
if ($filterActive) {
    Write-Output ('{0}: scope = TARGETED pids {1} (other processes excluded from the total)' -f $RIG, ($pidFilter -join ','))
} else {
    Write-Output ('{0}: scope = WHOLE-MACHINE sum of all engtype_3D instances' -f $RIG)
}
Write-Output ('{0}: instances/sample = {1} | {2}' -f $RIG, (($instanceCounts | Sort-Object -Unique) -join ','), $medianNote)
Write-Output ('{0}: samples(%) = {1}' -f $RIG, (($sampleTotals | ForEach-Object { [math]::Round($_, 4) }) -join ' '))
Write-Output ('{0}: min = {1}% | median = {2}% | mean = {3}% | p95 = {4}% | max = {5}%' -f `
        $RIG, [math]::Round($min, 4), [math]::Round($median, 4), [math]::Round($mean, 4), [math]::Round($p95, 4), [math]::Round($max, 4))

if ($perLuid.Count -gt 0) {
    Write-Output ('{0}: per-luid median-of-total-share:' -f $RIG)
    foreach ($k in ($perLuid.Keys | Sort-Object)) {
        $share = if ($mean -gt 0) { [math]::Round(($perLuid[$k] / $Samples), 4) } else { 0 }
        Write-Output ('{0}:   luid {1} -> avg {2}%' -f $RIG, $k, $share)
    }
}
if ($perPid.Count -gt 0) {
    $top = $perPid.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 5
    Write-Output ('{0}: top contributors (avg % over {1} samples):' -f $RIG, $Samples)
    foreach ($e in $top) {
        $avg = [math]::Round($e.Value / $Samples, 4)
        $pname = ''
        try { $pname = (Get-Process -Id ([int]$e.Key) -ErrorAction Stop).ProcessName } catch { $pname = '(exited)' }
        Write-Output ('{0}:   pid {1} ({2}) -> {3}%' -f $RIG, $e.Key, $pname, $avg)
    }
}

# 红线的判定口径：用 p95 而不是 max。max 会被单帧尖峰（一次窗口重绘）拉高，
# 判 max 等于判「永不通过」；判 median 又会放过持续的抖动。p95 是两者的折中，
# 并且必须在报告里写明用的是 p95。
$pass = ($p95 -le $Threshold)
$state = if ($pass) { 'PASS' } else { 'FAIL' }
Write-Verdict $state ('p95 = {0}% vs threshold {1}% (median {2}%, samples {3})' -f `
        [math]::Round($p95, 4), $Threshold, [math]::Round($median, 4), $Samples)

if ($Json) {
    Write-Output (@{
            state       = 'MEASURED'
            verdict     = $state
            counter     = $COUNTER
            warmupSec   = $WarmupSeconds
            samples     = $Samples
            threshold   = $Threshold
            min         = [math]::Round($min, 4)
            median      = [math]::Round($median, 4)
            mean        = [math]::Round($mean, 4)
            p95         = [math]::Round($p95, 4)
            max         = [math]::Round($max, 4)
            pass        = $pass
            rawSamples  = ($sampleTotals | ForEach-Object { [math]::Round($_, 4) })
        } | ConvertTo-Json -Compress)
}

if ($pass) { exit 0 } else { exit 1 }