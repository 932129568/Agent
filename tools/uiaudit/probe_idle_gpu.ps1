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
      · 计数器在无 GPU 活动的机器上可能返回空集（不是 0），必须区分「测不到」与
        「很干净」。判据不是按「整机有没有实例」写的，而是按**「你测的那个集合」**写的
        —— 详见下面「三态判定」与 $matchedCounts 的注释（这里曾有一个恒真门。
        实测：-TargetPid 999999（不存在的 PID）曾返回 rc=0 + PASS，p95=0%）。

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
    逐行文本；最后一行是结论行。

    三态判定（输出里 state[1/3] / state[2/3] / state[3/3] 各报一次，
    这样「测不到」与「很干净」在输出上立刻可分）：

        state[1/3]  整机实例数 == 0                  → blocked (NO_MACHINE_INSTANCES)
                    驱动不上报 / 无 3D 活动，二者不可分辨，拒绝报 0%

        state[2/3]  filterActive && 匹配实例数 == 0  → blocked (NO_INSTANCES)
                    PID 写错 / 进程没起来 / 作用域取错。
                    **这是 Q13 的 N0 判据**：Harbor 完全退出时同口径必须走到这里。
                    若这里出了 PASS，说明探针在撒谎。

        state[3/3]  MEASURED                          → 按 p95 判 PASS/FAIL

    ⇒ 「输出中出现 PASS」等价于「确实匹配到了目标实例」。这是可被断言检验的强性质：
      负控要验的不是 rc，而是 **A 组输出里不出现 PASS 字样**（rc=2 但仍有 PASS 行
      这种半修状态最容易发生）。

    退出码：
      0 = MEASURED 且通过阈值
      1 = MEASURED 但超过阈值
      2 = blocked（计数器不可用 / 整机空集 / 过滤后空集 / 采样失败）

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

# 作用域证据（在任何 exit 之前就初始化，blocked 路径也要能输出它）。
# 只有 pid 清单时，"28 个 pid" 无法分辨量的是 Harbor 还是 WorkBuddy ——
# 这正是本仓实测踩过的坑：负控脚本把 @('WorkBuddy','msedgewebview2') 的结果
# 标成 "real Harbor tree"，而 Get-Process -Name Harbor 在同一台机器上恒为 0。
# ⇒ 判据不能只报 pid，必须把 pid 反查回**进程名**，让读报告的人一眼看出量的是谁。
$resolvedNames = @()
# 提前给默认值：Write-Blocked 在参数自检阶段就可能被调用（早于 TargetPid 解析），
# 那时 $pidFilter/$filterActive 还没赋值。没有 Set-StrictMode 不会报错，
# 但 blocked 路径的 JSON 会缺字段 —— 而 blocked 路径恰恰最需要作用域证据。
$pidFilter = @()
$filterActive = $false

function Write-Verdict([string]$state, [string]$detail) {
    Write-Output ('{0}: {1} | {2}' -f $RIG, $state, $detail)
}

function Write-Blocked([string]$reason) {
    Write-Verdict 'blocked-by-environment' $reason
    if ($Json) {
        Write-Output (@{
                state                = 'blocked-by-environment'
                reason               = $reason
                scope                = $(if ($filterActive) { 'targeted' } else { 'whole-machine' })
                targetPids           = @($pidFilter)
                resolvedProcessNames = @($resolvedNames)
            } | ConvertTo-Json -Compress)
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

# ---- 把 pid 反查成进程名（作用域自证）----------------------------------------
# 为什么必须有这一步：本项目的 GPU 负控脚本曾把 WorkBuddy+msedgewebview2 的读数
# 标成 "real Harbor tree"，而 Harbor.exe 在本机从未启动（Get-Process -Name Harbor = 0）。
# 光看 "28 pids" 无法发现这个错 —— 只有把名字打出来才会暴露。
# 进程可能在过滤后退出，反查失败时写 '(exited)'，不许静默丢项（丢项会让清单长度
# 与 pid 数不符，读报告的人会以为漏测）。
function Resolve-PidNames([int[]]$Ids) {
    $out = @()
    foreach ($p in $Ids) {
        $nm = ''
        try { $nm = (Get-Process -Id $p -ErrorAction Stop).ProcessName } catch { $nm = '(not running)' }
        $out += ('{0}:{1}' -f $p, $nm)
    }
    return $out
}

if ($filterActive) { $resolvedNames = @(Resolve-PidNames $pidFilter) }

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
$sampleTotals = @()          # 每次采样的「作用域内 3D 占用总和」
$perPid  = @{}          # pid -> 累计贡献（用于报告「谁在占用」）
$perLuid = @{}          # luid -> 累计总和（多 GPU 时分开看）
$instanceCounts = @()    # 每次采样的「整机」实例数
$matchedCounts = @()     # 每次采样的「过滤后命中」实例数（关键：与整机分开统计）

for ($i = 1; $i -le $Samples; $i++) {
    try {
        $reading = Get-Counter -Counter $COUNTER -ErrorAction Stop
    } catch {
        Write-Blocked "Get-Counter failed on sample $i/$($Samples): $($_.Exception.Message)"
    }
    $cs = @($reading.CounterSamples)
    $instanceCounts += $cs.Count
    $sum = 0.0
    $matchedInSample = 0
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
            $matchedInSample++          # ← 过滤后命中计数（不论数值是否为 0）
            $sum += $v
        } elseif (-not $filterActive) {
            # 实例名不含 pid（极少数驱动/会话）→ 只在全机模式下计入总和
            $sum += $v
        }
    }
    $sampleTotals += $sum
    $matchedCounts += $matchedInSample
}

$totalInstances = ($instanceCounts | Measure-Object -Sum).Sum
$totalMatched = ($matchedCounts | Measure-Object -Sum).Sum

# ── 三态判定（顺序写死，不可调换）──────────────────────────────────────────────
# 为什么必须区分「整机实例数」与「命中实例数」：
#   滤波在采样循环里用 continue 跳过不匹配的实例，**从来不统计命中几个**。
#   于是「整机有实例、但过滤后一个都没命中」会落进 sum=0 的正常路径 ⇒ p95=0% ⇒ PASS。
#   实测后果：-TargetPid 999999（根本不存在的 PID）拿到了 rc=0 + PASS。
#   这是**恒真门**，且藏在主判决位上：任何 PID 写错 / 进程没起来 / 作用域取错，
#   都会静默变绿 —— 比红更危险，因为在 CI 上看起来是"通过了"。
#   教训：空集保护要保护「你测的那个集合」，不是「存在的那个集合」。
$machineEmpty = ($instanceCounts.Count -eq 0) -or ($totalInstances -eq 0)

if ($machineEmpty) {
    # 状态 1：整机 0 实例 —— 分不清「无 3D 活动」与「驱动不上报」，拒绝报 0%
    Write-Output ('{0}: state[1/3] NO_MACHINE_INSTANCES | machine=0 matched=0' -f $RIG)
    Write-Blocked "counter returned 0 instances across $Samples samples; cannot distinguish 'no 3D activity' from 'driver does not report' (refusing to report 0%)"
}
Write-Output ('{0}: state[1/3] MACHINE_INSTANCES_OK | machine={1}/sample matched={2}/sample' -f `
        $RIG, (($instanceCounts | Sort-Object -Unique) -join ','), (($matchedCounts | Sort-Object -Unique) -join ','))

if ($filterActive -and $totalMatched -eq 0) {
    # 状态 2：过滤后 0 命中 —— PID 写错 / 进程没起来 / 作用域取错。
    # 这正是 Q13 的 N0 判据（Harbor 完全退出时同口径必须 NO_INSTANCES），
    # 也是本探针曾经漏掉的那个洞。**不许出 PASS**。
    $scopeMsg = ('targeted pids [{0}] matched 0 of {1} machine instances across {2} samples; ' +
        'PID typo / process not running / wrong scope. Refusing to report 0% as a passing ' +
        'measurement (this is the N0 scope check: Harbor fully exited MUST yield NO_INSTANCES)') -f `
        ($pidFilter -join ','), $totalInstances, $Samples
    Write-Output ('{0}: state[2/3] NO_INSTANCES | filter pids=[{1}] matched=0 while machine={2} instances/sample' -f `
            $RIG, ($pidFilter -join ','), (($instanceCounts | Sort-Object -Unique) -join ','))
    Write-Blocked $scopeMsg
}
if ($filterActive) {
    Write-Output ('{0}: state[2/3] SCOPE_MATCHED | matched={1}/{2} instances' -f $RIG, $totalMatched, $totalInstances)
    # 部分采样点 0 命中 ⇒ 进程在采样期间抖动/退出，数值只覆盖部分时间窗，必须如实标注
    $zeroSamples = @($matchedCounts | Where-Object { $_ -eq 0 }).Count
    if ($zeroSamples -gt 0) {
        Write-Output ('{0}: WARN {1}/{2} samples had 0 matched instances (process churn during sampling; value covers only the rest)' -f `
                $RIG, $zeroSamples, $Samples)
    }
} else {
    Write-Output ('{0}: state[2/3] WHOLE_MACHINE_ONLY | diagnostic scope, not the acceptance scope' -f $RIG)
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
    # 作用域自证：pid -> 进程名。没有这行，"量的是谁" 只能靠猜。
    Write-Output ('{0}: resolved process names = {1}' -f $RIG, ($resolvedNames -join ', '))
    if (@($resolvedNames | Where-Object { $_ -match ':Harbor$' }).Count -eq 0) {
        # 不是错误（探针可以被指定测任何进程），但必须显式标注，
        # 因为本仓 Q13 的验收口銕是 "Harbor 进程树"，两条作用域不能混用。
        Write-Output ('{0}: NOTICE scope contains no process named "Harbor" (this reading is NOT Harbor-scope evidence)' -f $RIG)
    }
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
# state[3/3]：只有走到这里才允许出 PASS/FAIL。前面两道 guard 已经 exit 2，
# 所以「输出里出现 PASS」等价于「确实测到了目标实例」—— 这是可被断言的强性质。
Write-Output ('{0}: state[3/3] MEASURED | scope={1} matched={2} instances over {3} samples' -f `
        $RIG, $(if ($filterActive) { 'targeted' } else { 'whole-machine' }), $totalMatched, $Samples)
Write-Verdict $state ('p95 = {0}% vs threshold {1}% (median {2}%, samples {3})' -f `
        [math]::Round($p95, 4), $Threshold, [math]::Round($median, 4), $Samples)

if ($Json) {
    Write-Output (@{
            state            = 'MEASURED'
            verdict          = $state
            counter          = $COUNTER
            warmupSec        = $WarmupSeconds
            samples          = $Samples
            threshold        = $Threshold
            # 作用域证据：没有这两个数，p95=0% 无法与「测不到」区分
            scope            = $(if ($filterActive) { 'targeted' } else { 'whole-machine' })
            targetPids       = @($pidFilter)
            resolvedProcessNames = @($resolvedNames)
            machineInstances = $totalInstances
            matchedInstances = $totalMatched
            min              = [math]::Round($min, 4)
            median           = [math]::Round($median, 4)
            mean             = [math]::Round($mean, 4)
            p95              = [math]::Round($p95, 4)
            max              = [math]::Round($max, 4)
            pass             = $pass
            rawSamples       = ($sampleTotals | ForEach-Object { [math]::Round($_, 4) })
        } | ConvertTo-Json -Compress)
}

if ($pass) { exit 0 } else { exit 1 }