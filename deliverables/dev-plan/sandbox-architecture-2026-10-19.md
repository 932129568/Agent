# Harbor 命令沙箱模块 · 架构设计与风险手册

**日期**：2026-10-19
**类型**：架构设计 + 实现说明 + 安全风险矩阵
**基线**：v1.5.0（561 passed）+ 本模块（584 passed / 1 skipped，契约 PASS）
**实现**：`backend/services/sandbox_service.py`（核心）、`backend/services/cmd_service.py`（集成）、`backend/api.py`（3 个隐身 js_api）、`tests/test_sandbox.py`（24 项真实 Win32 验证）

---

## 📌 TL;DR

- **一句话**：用 Windows **Job Object**（内核对象，零第三方依赖）给 Agent 的每条命令套上「进程树收编 + 内存/进程数/CPU 限制 + 孤儿清剿」的笼子，与既有护栏（guard 三档确认）/去重/熔断层层叠咬，**不放宽也不替代**任何既有安全机制。
- **核心实现决策**：`CreateProcessW(CREATE_SUSPENDED) → AssignProcessToJobObject → ResumeThread` 的**无竞业收编**——杜绝「Popen 后 assign」的毫秒级逃逸窗口（恶意命令可在 assign 前 fork 出 job 外子孙）。
- **诚实边界**（详见 §5 风险矩阵）：网络隔离与剪贴板隔离在本约束下（零依赖、无管理员提权、Windows 单文件）**不可达**，由 guard 审计与文档化缓解补位；提权通道（run_admin_command）显式排除沙箱。
- **意外收获**：集成测试暴露并修复了一个 **v1.1 起潜伏的真机 P0 bug**——`cmd_service._exec` 非桩路径返回 Popen 对象致 `result.stdout` 是管道对象，真机每条命令「执行成功但向 Agent 报错」（被测试桩全面掩盖，与用户报的「cmd 反复弹窗」现象部分同源）。

---

## 1. 架构总览

### 1.1 分层位置（沙箱是「执行层」约束，不是「决策层」替代）

```
Agent 工具调用 run_command / run_powershell
  │
  ├─ ① guard_service.enforce_exec ── 三档确认矩阵 + confirm-token（v1.3.1）
  │      「要不要执行」的决策层——不动
  ├─ ② RunDeduper.check ── 全窗去重 + 键归一（三轮修复）
  │      「同一条命令反复跑」的防呆层——不动
  ├─ ③ 【新】sandbox_service ── Job Object 收编 + 资源限制
  │      「执行时跑多远」的约束层——本模块
  └─ ④ R4 成本熔断 ── 预算硬停 + 循环检测（按签名计数，与沙箱正交）
```

**设计原则**：沙箱只约束「执行起来之后能碰到什么」，不决定「允不允许执行」。四层各自独立、层层可叠；任何一层失效不架空其余层（对照 v1.3.2 S8 教训：熔断曾被 archive 洗白架空——分层正交是本模块的硬约束）。

### 1.2 模块结构

| 组件 | 文件 | 职责 |
|---|---|---|
| `SandboxService` | `sandbox_service.py` | 配置（`~/.glm-chat/sandbox.json`，**独立文件不碰 config.json**）+ 档位解析 + 状态统计 |
| `create_job()` / `SandboxJob` | 同上 | Job Object 生命周期：创建/收编/清剿/记账/关闭 |
| `run_in_sandbox()` | 同上 | 无竞业执行：管道 → 挂起创建 → 收编 → 恢复 → 读取 → 超时清剿 |
| `_exec(sandbox=…)` | `cmd_service.py` | 集成点：sandbox 非空走沙箱路径，结果与 CompletedProcess 同构 |
| `sandbox_*` js_api | `api.py` | `sandbox_get_config` / `sandbox_save_config` / `sandbox_status`（`_V12_EXTRA` 隐身，契约零漂移） |

### 1.3 单次命令执行时序（无竞业收编）

```
run_in_sandbox(args, shell, cwd, timeout, limits)
  ├─ create_job(limits)                    Job 创建 + 设限（内存/进程数/CPU/UI）
  ├─ CreatePipe ×2 + NUL stdin             管道可继承（SECURITY_ATTRIBUTES.bInheritHandle=TRUE）
  ├─ CreateProcessW(CREATE_SUSPENDED|NO_WINDOW)   ← 挂起态！关键
  ├─ AssignProcessToJobObject(job, hProcess)       ← 无竞业：此时进程未跑，无法预先 fork
  ├─ ResumeThread(hThread)                        ← 放行
  ├─ 父侧关闭写端 → 读线程 ×2 收 stdout/stderr
  ├─ WaitForSingleObject(hProcess, timeout)
  │    ├─ 正常退出 → GetExitCodeProcess
  │    └─ WAIT_TIMEOUT → TerminateJobObject(job)   ← 内核级清剿整树（含孙进程）
  └─ finally: 关管道/进程/线程句柄 + job.close()    ← KILL_ON_JOB_CLOSE 兜底清剿
```

**为什么不用 `subprocess.Popen` 后 assign**：Popen 返回时进程已在运行，到 assign 之间存在毫秒级窗口——恶意命令（`cmd /c start malicious.exe`）可在窗口期内 fork 出 job 外进程，**限制对其完全无效**。挂起态收编在数学上消除该窗口（进程第一条指令都没执行）。

---

## 2. 隔离机制与能力矩阵

| 隔离维度 | 机制 | 强度 | 说明 |
|---|---|---|---|
| **进程隔离** | Job Object 收编整树 | **强** | 孙进程自动入 job；不设 BREAKAWAY_OK → `CREATE_BREAKAWAY_FROM_JOB` 必败；KILL_ON_JOB_CLOSE → 句柄关闭即全树清剿（防孤儿） |
| **资源限制** | commit 内存（per-process+per-job 双限）/ 活跃进程数 / per-job CPU 时间 | **强** | 超限表现：内存→分配失败（WinError 1816 类）；进程数→CreateProcess 失败；CPU→到点清剿 |
| **UI 面收窄** | basic=DESKTOP+EXITWINDOWS；strict 追加 GLOBALATOMS+HANDLES | **中** | 防切桌面伪造 UAC 确认框（提权欺骗经典路径）、防关机重启打断；strict 的 HANDLES 限制已知可能破坏部分运行时，默认关 |
| **文件系统** | 工作区门禁（既有 workspace_service）+ guard 保护名单 + 审计 | **中** | 应用层路径校验已存在（v1.3.1 S5 realpath 归一）；**未做** ACL/重定向层——见 §5 风险 R4 |
| **网络** | 无内核级隔离 | **弱（诚实标注）** | 见 §5 风险 R5 |
| **剪贴板/截屏** | 无沙箱层隔离，由 guard 三档确认兜底 | **弱（诚实标注）** | Job Object 无剪贴板 UI 限制；沙箱内进程调 Win32 API 读剪贴板不可拦——见 §5 风险 R6 |

---

## 3. 权限控制策略

### 3.1 配置模型（sandbox.json）

```json
{
  "enabled": true,
  "command_profiles": {
    "run_command": "standard",        // off / standard / strict
    "run_powershell": "standard",
    "run_admin_command": "off"        // 恒 off：见 3.3
  },
  "limits": {
    "standard": {"memory_mb": 1024, "max_processes": 16, "cpu_seconds": 120, "ui_restrict": "basic"},
    "strict":   {"memory_mb": 512,  "max_processes": 8,  "cpu_seconds": 60,  "ui_restrict": "strict"}
  }
}
```

- `max_processes=16` 的依据：实测本机 venv python 是**启动器**（一次 `Popen([python.exe])` 有 2 个进程入 job），且 npm/msbuild 构建树本身可开十余进程；进程数限制是**纵深防御**，主控是内存/CPU/时间限制 + R4 熔断。
- 用户可在设置面板调整（UI 接线为后续项，见 §7）；配置读写全部经 js_api，无手改文件要求。

### 3.2 fail-closed 语义

沙箱 **enabled** 但 `create_job`/收编失败（如 Win7 嵌套 job 拒绝、完整性不匹配）→ 抛 `SandboxUnavailable` → `cmd_service` 转 `RuntimeError('沙箱执行被阻止（fail-closed）：…')` → Agent 收到明确错误，**命令不执行**。绝不做「静默降级裸跑」——那会把安全特性变成幻觉（对齐 v1.3.1 S19 fail-closed 哲学）。用户确需关闭：设置里 `enabled=false`，行为精确回退 v1.5.0。

### 3.3 提权通道显式排除

`run_admin_command` 默认且**强制** off：UAC 提权后的子进程完整性级别高于中型父进程，父进程无法将其 assign 进 job（`ERROR_ACCESS_DENIED`/`1314`）。强行支持只会制造「以为关住了其实没关」的假安全感。admin 通道的安全依赖不变：MessageBox 人审 + UAC + dedup + guard。

---

## 4. 接口设计（js_api，全部 _V12_EXTRA 隐身）

| 方法 | 签名 | 返回 |
|---|---|---|
| `sandbox_get_config()` | 无参 | 配置 JSON（开关/档位/限制） |
| `sandbox_save_config(cfg_json)` | JSON 串 | `{"ok":true}` / `{"error":…}` |
| `sandbox_status()` | 无参 | `{available, platform, enabled, command_profiles, stats{jobs_created, runs_sandboxed, runs_failed_closed}}` |

**契约核对**：三方法均进 `_V12_EXTRA`，`get_api_info()` 输出与 legacy 逐字节一致（契约差分测试已验证）；`build_tools` 默认路径零改动；config.json 零写入；UI 契约本次无前端改动（零新增即零破坏）。

**预留扩展点**（文档化，未实现）：`SandboxJob.adopt_pid(pid)` 供 MCP stdio 温启等非对抗场景补挂（有竞业注记）；`job.stats()` 供未来的「沙箱资源看板」。

---

## 5. 安全风险矩阵与缓解

| # | 风险 | 等级 | 缓解 | 残留 |
|---|---|---|---|---|
| R1 | **沙箱内进程逃逸**：job 外预先 fork、breakaway、桌面切换伪造 UAC | 高 | 挂起态收编（无竞业窗口）；禁 BREAKAWAY_OK；UI 限制 DESKTOP+EXITWINDOWS；孙进程自动入 job | 内核漏洞级逃逸不防（超出应用层范畴） |
| R2 | **资源耗尽攻击**：内存炸弹/进程炸弹/CPU 死循环 | 高 | 三限制齐上（内存双限/进程数/CPU 时间）；超时清剿整树；R4 熔断正交兜底 | 限制值本身需用户按机器配置（默认值面向 8GB+ 内存机） |
| R3 | **孤儿进程**：job 关闭后残留占用文件/端口 | 中 | KILL_ON_JOB_CLOSE（句柄关闭即清剿）+ 退出时显式 terminate + close | 无（内核保证） |
| R4 | **文件系统越界**：沙箱内写工作区外路径 | 中 | 工作区门禁 + guard 保护名单（v1.3.1 S5 realpath 归一防 junction 绕过）+ 审计 | **未做 ACL 层**——用户自有文件对用户进程天然可写，应用层校验可被沙箱内进程直接调 Win32 API 绕过；根治需 AppContainer/低权限用户（与零依赖/单文件约束冲突，列后续） |
| R5 | **网络外联/数据外泄**：沙箱内进程回传数据 | 中 | 无内核级隔离（诚实缺口）；缓解：guard 审计可见 + 文档告知 + 「网络封禁助手」方案（netsh 脚本需用户 UAC，见 §7） | **弱**——默认配置下沙箱不阻网；威胁模型主要为「恶意 MCP 服务器/提示注入驱动的外联」 |
| R6 | **剪贴板/截屏窃取**：沙箱内进程读剪贴板 | 中 | Job 无此 UI 限制；由 guard 三档确认（clipboard_read/screenshot 默认 session 档）+ 审计兜底 | **弱**——沙箱内进程可绕过应用层直接调 API；提示注入场景下「Agent 截屏」本身仍受 guard 管 |
| R7 | **提权进程失控**：admin 通道不受沙箱 | 中 | 显式排除（3.3）+ MessageBox 人审 + UAC + dedup | 提权即信任边界外（设计取舍，文档明示） |
| R8 | **句柄泄漏/重入**：job 或管道句柄未关 | 低 | finally 全路径关闭 + 引用单次创建单次关闭 + 单测钉住 | 无 |
| R9 | **测试环境造假**：桩测试「证明」了不存在的安全 | 中 | 本模块测试**全部真实 Win32 API**（真子进程/真 job/真限制），含挂起态白盒路径；584 全量回归 | 真机起窗冒烟仍未做（KNOWN_ISSUES #1 延续） |
| R10 | **限制误伤合法构建**：npm/msbuild 超进程数/内存限 | 中 | standard 16 进程/1GB 留头；误伤时 Agent 收到 1816 人话可改配置；strict 仅高级用户 | 极端单体仓库构建可能仍需调大（配置出口存在） |

---

## 6. 测试验证（全部真实 API，非桩）

| 测试 | 验证的机制 |
|---|---|
| `test_basic_and_exit_code` / `test_shell_true_cmdline` / `test_cwd_applied` / `test_stderr_captured` | 执行正确性、shell 口径（与 CPython `comspec /c "args"` 逐字一致）、cwd、双管道 |
| `test_timeout_kills_whole_tree` | 超时清剿**孙进程**（pid 级探针验证死亡，非「看起来结束了」） |
| `test_kill_on_job_close` | 不显式 terminate、仅关句柄 → 残留被清剿 |
| `test_terminate_kills_tree` + `job.stats()` | TerminateJobObject + 记账查询 |
| `test_memory_limit_enforced` | 200MB 限下 400MB 分配必失败（禁 `ALLOC_OK`） |
| `test_process_count_limit` | 进程数上限生效（自适应断言：环境间 python 启动器差异） |
| `test_cpu_time_limit` | 1s CPU 限 → 死循环 ~秒级清剿 |
| `test_ui_restrictions_accepted` | basic/strict/none 三档系统接受 |
| `test_fail_closed_when_job_creation_fails` + `test_cmd_service_sandbox_fail_closed` | fail-closed：创建失败绝不裸跑，错误含「沙箱/fail-closed」 |
| `test_cmd_service_sandboxed_echo` / `_timeout` / `_no_sandbox_path_unchanged` / `_dedup_still_applies` | 集成层：沙箱路径可用、超时转译、非沙箱路径行为不变、去重不被沙箱绕过 |

**附带修复的验证**：`test_cmd_service_no_sandbox_path_unchanged` 同时是 P0 潜伏 bug（§TL;DR）的回归测试——非桩路径现在返回 `CompletedProcess`（communicate 捕获的真实字节）。

---

## 7. 已知限制与后续项

1. **设置面板 UI 未接线**：配置经 js_api 可读写，但前端还没有「沙箱」设置区块与状态灯（UI 契约纯新增，排下个小版本）。当前默认 enabled + standard，开箱即生效。
2. **网络封禁助手**（R5 的增强缓解）：可生成「为沙箱可执行文件添加入站/出站阻止规则」的 netsh 脚本由用户以管理员执行——零依赖但需 UAC，作为 opt-in 文档项，非默认。
3. **MCP stdio 服务器收编**：`adopt_pid()` 已预留（有竞业注记）；MCP 子进程（uvx/npx）纳入 job 需改 `mcp_service._spawn_client` 的创建路径，列为 v1.6.x 候选。
4. **真机冒烟**：起窗后走一遍「echo → 超时 → 拒绝路径 → 审计」四步（KNOWN_ISSUES #1 的延伸项）。
5. **文件系统 ACL 层**：与「完全本地 + 零依赖」定位冲突，不做；以 R4 的应用层校验 + 文档化残留风险接受。

---

## 8. 改动清单

| 文件 | 改动 |
|---|---|
| `backend/services/sandbox_service.py` | **新增**（约 560 行）：ctypes 结构/常量、SandboxJob、create_job、run_in_sandbox、SandboxService |
| `backend/services/cmd_service.py` | `_exec` 增 `sandbox` 参数（沙箱路径 + fail-closed 转译）；**修复 P0：非桩路径返回 CompletedProcess**；run_command/run_powershell 透传 sandbox |
| `backend/api.py` | 装配 SandboxService；run_command/run_powershell 传 `limits_for()`；3 个隐身 js_api 进 `_V12_EXTRA` |
| `tests/test_sandbox.py` | **新增** 24 项（真实 Win32 API） |
| `KNOWN_ISSUES.md` | P0 潜伏 bug 记录为已修；沙箱已知限制登记 |

**未碰**：`tools_schema.py`、`config.json` 任何路径、`GLM-Chat.spec`/`Harbor.spec`、前端（本版零前端改动，无构建需求）、契约基线 legacy 文件。

---

> 本模块由产品通基于「设计并实现沙箱功能模块」需求交付；内核级隔离经本机真实 API 验证，但真机起窗冒烟仍待目标环境执行（见 KNOWN_ISSUES）。
