# tools/uiaudit —— R101 UX 判据基座（T01）

判据先于实现。本目录是 T01 的产出：**把「怎么算过」钉死**，并且用注入式负控
证明每条判据真的能咬。**T01 不含任何产品代码改动**（`frontend/**` 零修改）。

> 本目录的判据在当前仓库上**故意是红的**。这是正确的 —— 它证明判据有分辨力。
> 修绿是 Phase B / T03 的活，T01 只负责把缺陷变成可判定的红。

---

## 0. 一句话说清为什么判 rc 不够

三个实测过的场景，**rc 都是 0，但结论都是错的**：

| 场景 | rc | 实际情况 |
|---|---|---|
| 判据脚本崩了（异常被 `try/except` 吞掉） | 0 | 一条都没扫 |
| `manifest.json` 路径改了眼，扫到 0 个 CSS | 0 | 「没东西可扫」被当成「没有违例」 |
| 正则漏改（产品换个写法就匹配不到） | 0 | 有违例，但一个都没报出来 |

所以本目录每个脚本都**必须**在输出里给出**可逐字匹配的行集合**
（`[A1] 死引用: <name> @ <file>:<line>` 这种），并且负控**比对的是行，不是 rc**。

更极端的例子在同仓已经复现过（见 §5）：**两道门禁读的不是同一个文件**，
一道红一道绿，只跑一道就会得出完全相反的结论。

---

## 1. 四个脚本与运行方式

### 1.1 `assert_motion.py` —— 动效静态断言 A1–A5

```bash
C:/Users/陈/.workbuddy/binaries/python/envs/default/Scripts/python.exe tools/uiaudit/assert_motion.py
# 加 --json 输出一行机读 JSON；加 --root DIR 指向副本
```

| ID | 判据 | 为什么这样判 | 当前触发率 |
|---|---|---|---|
| A1 | 每个 `animation` / `animation-name` 引用的名字，必须有同名 `@keyframes` | 死引用在浏览器里**完全静默**：`animationName` 照样返回该名、`getAnimations()` 返回空、无控制台报错。实测确认（§3） | **30** |
| A2 | 同一 `@keyframes` 名不得重复定义 | 后者覆盖前者，同样静默；重复通常是复制粘贴出错 | **1** |
| A3 | `@keyframes` 内属性 ⊆ 合成器直通白名单；布局属性单独点名 | 布局属性每帧重排，破「合成器直通」纪律 | **0**（真实零，见下） |
| A4 | 不得 `transition:all` / `transition-property:all` | `all` 把未预期属性一起过渡，触发意外重排 | **0**（真实零） |
| A5 | 动画/过渡时长必须走 `var(--dur-*)`，不得裸写 `137ms` | 令牌是单一事实源；裸数字让 fx-off 降级与全局改时长全部失效 | **62** |

**A3 / A4 的 0 是真实零，不是没接线。** 已被注入负控证明能咬：
- M3 注入 `@keyframes zzBad{from{left:0}to{left:10px}}` → 报 `[A3] 违例: zzBad 含 left`
- M4 注入 `.zz-probe{transition:all .2s}` → 报 `[A4] 违例: transition all`

没有这两条负控，读报告的人无法区分「零」和「判据没跑」。

**A5 的两类豁免（豁免项在输出里显式计数，不静默丢弃）**：
- `infinite` 循环动画（实测豁免 15 个时长）：令牌体系当前**没有**循环档
  （架构文档 §6.2 已登记该缺口）。此时硬要求令牌 = 要求工程师先造令牌。
- `.01ms` 降级开关（4 个）：fx-off / reduced-motion 的**停用**写法，字面量即语义。

**A5 第一版有个假阳性，已修**：`var(--dur-fast, .12s)` 里的 `.12s` 是**回退值**，
令牌已经用了。第一版对整条 value 做 `finditer`，`island.css:139` 一行就被报 3 次。
修法 = 先剥 `var(...)`（含括号内回退值、含嵌套）再找时长令牌。
实测 65 → **62**，`island.css:139` 彻底消失，与 team-lead 独立预测逐项相等。

### 1.2 `assert_dead_controls.py` —— 死控件 / 调试残余 A6–A9

```bash
C:/Users/陈/.workbuddy/binaries/python/envs/default/Scripts/python.exe tools/uiaudit/assert_dead_controls.py
```

| ID | 判据 | 当前触发率 |
|---|---|---|
| A6 | 必须有「窗口隐藏时暂停循环动画」的机制（CSS `animation-play-state:paused` 或 JS `animationPlayState='paused'`） | **1**（0 钩子 / 26 条 infinite 循环） |
| A7 | 模板里不得有「永久 disabled 且无解释」的死控件 | **1**（死 1 + 豁免 2） |
| A8 | JS 动态生成的 disabled 按钮必须有说明，且不得自陈不可用 | **2** |
| A9 | 主界面不得有调试残余特征串 | **0**（真实零，M9 验证能咬） |

**为什么 A7 与 A8 必须分开（方法论缺口，不是代码洁癖）**：
`grep -n disabled frontend/index.template.html` 只看得到模板里的 3 处，**永远看不到**
由 JS 拼字符串生成的按钮。实测三处 JS 生成：
- `planning/card.js:144` `planEditBtn` —— 模板里不存在，只在运行时出现
- `sessions/controller.js:310` 「在下方输入框」—— 是模板 `:617` 那颗的**运行时重建版**
- `shell/hub-market.js:357` 翻页钮 —— `(s.page <= 1 ? ' disabled' : '')`，条件态，合理（豁免）

**A7 区分「真死」与「按状态禁用」的判法（本判据最容易做错的地方）**：
判「该 id 是否在 `frontend/src/**` 里被赋过 disabled」。但 `expert/center.js` 的写法是
```js
const enable = document.getElementById('expertEnableBtn');
if (enable) enable.disabled = true;      // 赋值点写的是变量名 enable，不是 id 字符串
```
第一版只做「`.disabled =` 前后 60 字符内有 id 字符串」的窗口匹配 → 两者相距 200+ 字符、
永远匹配不到 → `:994` / `:995` 被**误报成死控件（假红 2 条）**。
修法 = 先解析「id 被绑定到哪些变量名」，再找这些变量名附近的赋值。
实测修后：**死 1（`:617`）+ 豁免 2**，与 team-lead 独立验证一致。

> 为什么不用「必须赋过 `.disabled = false`」做判法：`select.disabled = detail.enabled === false`
> 里 `false` 是条件表达式的右操作数、不是赋值终点 —— 那样判会把 `:995` 误判成死控件。

**A8 的两个子判据（为什么「有 title」还不够）**：`planEditBtn` **有** title：
`title="当前版本不支持编辑计划；请拒绝后重新描述任务"` —— title 存在，但它**自陈不可用**。
红线 4 要清的是「存在但永远不会被用」的按钮，title 写着「不支持编辑」恰恰是自证死控件。
- A8-a：无 title ⇒ 违例（用户不知道为什么不能点）
- A8-b：title 自陈不可用（不支持 / 不可用 / unsupported / unavailable）⇒ 违例（红线靶心）

两者分开报，因为修法不同：a 是补说明，b 是删按钮或做真功能。

**A6 基线为什么必须红**：全仓 0 处 `animation-play-state`、0 处 `animationPlayState`，
而 CSS 里有 **26 条 `infinite` 循环动画**。窗口最小化/被遮挡时这些循环仍在跑 ——
这是「静置 GPU ≤ 0.5%」红线守不住的主因之一。四轮独立实测静置全机 3D 占用
p95 = **19.06% / 19.20% / 19.28% / 19.29%**（分别 5 / 7 / 9 / 5 采样，dwm 8.36%、
WorkBuddy 9.63%）。四轮都在 19% 附近但**互不相等** —— 这本身就是「不许单次读数」
的证据：区间跨度约 0.23pp，而红线是 0.5%，单读数的抖动已接近红线本身。

### 1.3 `assert_motion_negative.py` —— 注入式负控 M1–M9 + M0 + 恒真式自检

```bash
C:/Users/陈/.workbuddy/binaries/python/envs/default/Scripts/python.exe tools/uiaudit/assert_motion_negative.py
# 期望：MOTION_NEGATIVE: PASS (10/10)，rc=0
```

九条变异，每条都在**临时副本**上做（复制 `manifest.json` + `styles/` + `react/src/` +
`src/` + `index.template.html`），跑完 `finally` 清理。**绝不在真实工作树上变异** ——
本仓 `core.autocrlf=true` 且无 `.gitattributes`，一次 rebuild 就让 `harbor.html`
从 LF 态变 CRLF 态（+30,061 B），在真实树上变异+忘记还原会直接污染共享树。

**验收标准是「红得对」，不是「红了」**：每条的实际输出行必须与期望子串**逐字相等**。
只判 rc 的负控自己就会变成新的假通过源。

**M0 反向负控（必须有）**：构造一份「引用与定义唯一 + 只用合成器属性 + 时长全走令牌」
的干净 CSS，`assert_motion.py` 必须 **rc=0 / PASS**。没有这一条，前面九条「都能红」
可能只是「脚本对任何输入都红」，那同样没有分辨力。

**恒真式自检（本脚本最重要的守卫，也是被实测逼出来的）**：
每条期望子串在**未变异基线**上必须 MISS。只有这样才能排除「零变异也能通过」的假负控。

> 这条守卫抓到了一条真问题：M6 第一版设计是「删掉 motion.js 的暂停钩子 → 期望
> `[A6] 缺失: 静置暂停钩子`」。但 A6 是**存在性断言**、基线本来就红（0 钩子），
> 所以那个子串在**零变异时就已经存在** ⇒ 该负控是**恒真式**，HIT 不代表任何东西。
> 改法：A6 的区分维度只能是**计数**（`infinite 循环动画有 N 条`，基线 26，注入 2 条后 28）。

### 1.4 `probe_compose_height.py` —— 实测「释放 56px」

```bash
C:/Users/陈/.workbuddy/binaries/python/envs/default/Scripts/python.exe tools/uiaudit/probe_compose_height.py
# 加 --json / --width / --height / --estimate
```

用 playwright-core + 系统 Edge 打开 `harbor.html`，在受控对照下量：
- **current**：产品当前默认态（`access-strip` 显示）
- **baseline**：隐藏 `#attachPreview` / `#wsQuick` / `.access-strip`（即「压缩后」目标态）

`释放量 = baseline 阅读区高度 - current 阅读区高度`，
并做**空间守恒自检**（阅读区增量必须等于输入舱缩减、两者之和必须不变）。

实测（1440×900，Edge）：`#chatContainer` 596 → 648 px，`#inputArea` 186 → 134 px，
**释放 52 px**，和估计 56 差 **-4 px**，守恒自检 PASS。

**口径必须写清**：这是**可释放空间上界**（受控对照），不是 Phase B 的改前/改后 diff。
真正的改前后对比应在 CSS 改动后跑两遍。

失败模式是 fail-closed：缺 browser / 缺 playwright-core / 缺 `harbor.html` /
元素量不到高度 → 一律 `blocked-by-environment` + 退出码 2，**绝不输出 0 或编数字**。

### 1.5 `probe_idle_gpu.ps1` —— 静置 GPU 3D 占用

```powershell
& tools/uiaudit/probe_idle_gpu.ps1                      # 默认 warmup 10s / 9 采样 / 阈值 0.5%
& tools/uiaudit/probe_idle_gpu.ps1 -WarmupSeconds 20 -Samples 15 -Json
& tools/uiaudit/probe_idle_gpu.ps1 -TargetPid 1234       # 只看指定进程
```

采 `\GPU Engine(*engtype_3D)\Utilization Percentage`（核显无 `nvidia-smi`，
这是唯一标准路径）。三条纪律：
1. **必须先静置**（默认 10s）—— 入场动画没结束时采到的是峰值，不是静置态。
2. **必须中位数 + p95**，不能单次读数（计数器本身是间隔平均，抖动可达数个百分点）。
   **判定用 p95**：max 会被单帧尖峰拉高（判等于判「永不通过」），median 又会放过持续抖动。
3. **必须报告谁在占用**（按 pid / luid 分组）—— 20 个实例各 0.1% 和 1 个实例 0.4%
   是两件不同的事。

**四个 PowerShell 陷阱（都实测踩过，已修）**：
- **`.ps1` 含中文时必须存 UTF-8 带 BOM**（最隐蔽的一个，会让文件整体不可执行）。
  `powershell.exe`（5.1，Win10/11 自带，也是本文档 `.EXAMPLE` 用的解释器）读 `.ps1`
  **不做 UTF-8 探测**，直接按当前 ANSI 代码页（本机 CP936）解码。本文件有 62 行中文注释，
  无 BOM 时 CP936 会把全角括号/引号拆成非法字节序列，导致引号配对错乱、花括号不平衡，
  在 104/106 行抛「表达式或语句中包含意外的标记"}"」。实测：无 BOM → PS5.1 解析 2 个错误；
  加 BOM → 0 个错误。**这个坑在 `pwsh` 7 下完全不暴露**（pwsh 默认按 UTF-8 读），
  所以只在 pwsh 里测过的脚本，交付前必须再用 `powershell.exe` 跑一遍。
  （`probe_idle_gpu.ps1` 现在 13,616 B、首三字节 `EF BB BF`，改动时不要弄丢 BOM。）
- `param([string]$Pid)` → 运行时抛「无法覆盖变量 Pid，因为它是只读变量或常量」。
  `$Pid` / `$IsWindows` 是**只读自动变量**。改用 `-TargetPid` / `$onWin`。
- `$samples = @()` 会**覆盖参数 `$Samples`**（变量名大小写不敏感）⇒ `for` 循环拿数组
  比 `<` 整数，抛「无法将 Object[] 转换为 Int32」。改用 `$sampleTotals`。
- `Get-Counter -ListSet` 返回的 `Paths` 是**模板路径**（`\GPU Engine(*)\Utilization Percentage`），
  不是展开后的实例名。在模板上 grep `engtype_3D` 永远匹配不到 ⇒ 会把可用环境误判成
  blocked。实例维度只能在真正采样后判定。

**空集 ≠ 0%**：计数器返回 0 个实例时，无法区分「没有 3D 活动」与「驱动不上报」，
脚本拒绝报 0%，直接 `blocked-by-environment`。

---

## 2. 判据清单与自报触发率（一张表看全）

| 判据 | 脚本 | 当前值 | 性质 | 负控 |
|---|---|---|---|---|
| A1 无死动画引用 | assert_motion.py | **30**（`v4LineIn`×29 + `v4Spin`×1） | 真缺陷 | M1 |
| A2 无重复关键帧名 | assert_motion.py | **1**（`v4MaskIn`×2 @ legacy.css:454,:987） | 真缺陷 | M2 |
| A3 合成器直通属性 | assert_motion.py | **0** | 真实零 | M3 |
| A4 无 transition:all | assert_motion.py | **0** | 真实零 | M4 |
| A5 时长取令牌 | assert_motion.py | **62**（豁免 infinite 15 / .01ms 4） | 真缺陷 | M5 |
| A6 静置暂停钩子 | assert_dead_controls.py | **1**（0 钩子 / 26 条 infinite 循环） | 真缺陷 | M6（计数维度） |
| A7 模板无死控件 | assert_dead_controls.py | **1**（死 1 + 豁免 2） | 真缺陷 | M7 |
| A8 JS 生成按钮有说明 | assert_dead_controls.py | **2** | 真缺陷 | M8 |
| A9 无调试残余 | assert_dead_controls.py | **0** | 真实零 | M9 |

合计：`MOTION_STATIC: FAIL (A1=30 A2=1 A3=0 A4=0 A5=62 total=93)`、
`DEAD_CONTROLS: FAIL (A6=1 A7=1 A8=2 A9=0 total=4)`。

---

## 3. 已实测清单（哪些结论是跑出来的，不是推的）

| 结论 | 怎么验的 | 结果 |
|---|---|---|
| **CSS 动画名大小写敏感** | playwright-core + Edge：`@keyframes UPPER{...}` 配 `animation:upper 100s` | `animationName="upper"`、`getAnimations().length=0`、`transform:none` ⇒ **不命中**。故判据一律区分大小写 |
| 死引用在浏览器里静默 | 同上 | 无 pageerror、无 console 警告 |
| `@keyframes` 定义总数 | `grep -c` 与解析器双口径 | 76 定义 / 75 唯一名 |
| `v4MaskIn` 重复位置 | 逐行读 | `legacy.css:454` 与 `:987`（内容逐字相同） |
| `v4LineIn` 死引用数 | 解析器 + `grep` | 29 处引用，0 处定义 |
| **`v4Spin` 死引用（方案原文未提）** | 解析器发现 → `grep -rn "@keyframes v4Spin"` 零命中 | `legacy.css:1281` 1 处 ⇒ **新发现** |
| `box-shadow` / `background` 出现在 keyframes 内 | 属性直方图 | 6 个 keyframes 用到，均为**仅绘制**类，已进白名单（不误报） |
| 静置 GPU 3D 占用 | `probe_idle_gpu.ps1` 实跑 ×4（5 / 7 / 9 / 5 采样） | p95 = **19.06% / 19.20% / 19.28% / 19.29%**（dwm 8.36%、WorkBuddy 9.63%、msedgewebview2 0.63%）；四轮互不相等 ⇒ 必须多采样 |
| 输入舱 / 阅读区高度 | `probe_compose_height.py` 实跑（1440×900） | 释放 **52 px**（估计 56，差 -4），守恒自检 PASS |
| 全仓无动画暂停钩子 | `grep` 三种写法 | 0 处 |

---

## 4. 为什么判据不能只看一道门（实测复现的「延迟失败陷阱」）

`deliverables/design/check_contract.py` 读 **`frontend/index.template.html`**，
而 `tools/contract_diff.py` 的 `html` 契约面读 **`harbor.html`（构建产物）**。

⇒ **改模板但不 rebuild 时，两道门给出的结论相反**：

```
删 themeBtn 不 rebuild：
  check_contract.py  → [DOM id] 39/40 ; 结果: FAIL (1 项) ; ✗ 缺少 DOM id: themeBtn
  contract_diff.py   → 结论: 零漂移 PASS          ← 读的是旧产物，看不见这次改动

rebuild 之后：
  contract_diff.py   → dom_ids: 丢失=['themeBtn'] 新增=[]
```

这是一种**延迟失败**：今天改模板漏 rebuild 只是 `ui-contract` 红；等任何人跑一次
`node frontend/build.js`，漂移才突然出现在 `contract-diff` 上 —— 而那时改模板的人
可能已经不在，没人知道是自己造成的。

**纪律**：任何模板改动必须 `node frontend/build.js` 后**同时**跑两道门，
禁止只跑一道就宣布绿。

同一族的第二个陷阱（已实测）：`contract_diff.py` 的 `SRC = frontend/src`，对
`**/*.js` 的**所有非空行（含注释）**排序哈希 ⇒ **改一行注释也会红**；
而 `frontend/styles/**`、`frontend/skin/*.js`、`frontend/react/src/island.css`、
模板纯重排（不动 id/onclick 字面量）**都不在 SRC 内** ⇒ 零契约红利区。
这一条决定了 Phase A 的策略：**能交给 CSS 的改动一律不动 JS**。

---

## 5. 扫描面口径（两个脚本必须一致，否则会各扫一套）

- `frontend/manifest.json` 的 `styles` 数组（当前 **14** 个，Q8 裁决不许变）
- `frontend/react/src/island.css`（不进 manifest，但经 React IIFE 内联进产物，运行时真的生效）

**不扫** `deliverables/design/liquid-glass/styles/*.css` —— 设计稿素材，不是运行时样式。

`manifest.json` 缺失或 `styles` 为空 → 直接判 `environment` 失败，**不静默兜底成
「扫 `frontend/**/*.css`」**。一旦兜底，manifest 路径改掉后判据会悄悄换一个扫描面，
而输出里看不出这件事。

---

## 6. 新门禁的接线状态（Q7 裁决 = A，13 → 14 门）

`tools/uiaudit/assert_motion.py` 计划接入 `tools/run_normalized_gates.py` 的 `GATES`，
**当前以 `required=False` 起步**（T01 建判据期，记 SKIP/WARN 不判 FAIL），
T02/T03 修绿后改 `required=True`。

> **过渡态必须登记，否则就是永久豁免。** 豁免登记表在
> `deliverables/dev-plan/R101-T01-判据基座报告.md` §豁免登记表。
> 转 True 只允许「原本红 → 修绿」，需出示：修复前实测红值 + 修复后实测绿值 +
> **判据常量未改动的 diff**。**禁止**「原本红 → 放宽判据 → 变绿」。

T01 期间**未**修改 `run_normalized_gates.py`（改动归 T02）。

---

## 7. 环境与版本

| 项 | 值 |
|---|---|
| Python | `C:/Users/陈/.workbuddy/binaries/python/envs/default/Scripts/python.exe` |
| Node | v22.22.2 |
| Browser | `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe` |
| playwright-core | `server/node_modules/playwright-core`（经 `createRequire` + `pathToFileURL` 绕中文路径） |
| 行尾 | 本仓 `core.autocrlf=true` 且无 `.gitattributes`；所有判据读入后统一成 LF 再比对，故 `crlf` / `mixed` 文件不会造成假结论 |

**注意**：本地 `python -m pytest` 跑不起来（PATH 上的 `python` 是 3.13.12、无 pytest；
裸 `pytest` 来自 `envs/default/Scripts`）。本目录脚本全部是**独立可执行的判据**，
不依赖 pytest。

**取退出码时禁止用管道**：`python x.py | tail` 会把 rc=1 变成 rc=0（管道的 rc 是 `tail` 的）。
一律 `python x.py > out.txt 2>&1; echo "rc=$?"`。

---

## 8. 文件清单

| 文件 | 作用 | 依赖 |
|---|---|---|
| `_common.py` | CSS 解析共用件（等长遮罩 / keyframes 枚举 / 简写解析 / `var()` 剥离） | 无 |
| `assert_motion.py` | 动效静态断言 A1–A5 | `_common.py` |
| `assert_dead_controls.py` | 死控件 / 调试残余 A6–A9 | `_common.py` |
| `assert_motion_negative.py` | 注入式负控 M1–M9 + M0 反向负控 + 恒真式自检 | 两个断言脚本 |
| `probe_compose_height.py` | 实测「释放 56px」 | Edge/Chrome + playwright-core + harbor.html |
| `probe_idle_gpu.ps1` | 静置 GPU 3D 占用 | Windows WDDM 2.0+ |

零产品代码改动：本目录全部为**新增**文件，`frontend/**` 与 `tools/run_normalized_gates.py` 均未修改。