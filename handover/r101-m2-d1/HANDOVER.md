# R101 M2 · D1 补测 · 交接文档

> **交接人**：team-lead（原 team: `software-r101-d1`）
> **交接时间**：2026-11-22
> **轮次**：R101 M2 Spike · D1（层间对齐偏差）补测
> **对接受众**：接手 R101 M2 → M3 的人
> **一句话结论**：D1 已从 `blocked(capability)` 补测完成，改测 `coupleRatio` 后拿到**判据级证据**（分离度 66.67 倍）；同时发现 **6 个判据缺陷，修了 5 个**，剩 2 项如实留红。
>
> **本目录结构**：`HANDOVER.md`（本文）＋ `source/`（探针最终态源码镜像，文档里所有行号引用以此为准）＋ `.gitattributes`（禁行尾转换，保 sha256 可比）。

---

## 目录

- [0. 先读这段（最重要的三件事）](#0-先读这段最重要的三件事)
- [1. 背景：D1 原来为什么测不出来](#1-背景d1-原来为什么测不出来)
- [2. 发现的问题（6 个 DEFECT + 1 项未点亮）](#2-发现的问题6-个-defect--1-项判据未点亮)
- [3. 修了的问题（5 项）与怎么修的](#3-修了的问题5-项与怎么修的)
- [4. 没修的问题（2 项）](#4-没修的问题2-项)
- [5. 环境陷阱（会颠覆结论，必须知道）](#5-环境陷阱会颠覆结论必须知道)
- [6. 最终证据与验收状态](#6-最终证据与验收状态)
- [7. 复现步骤](#7-复现步骤)
- [8. 给接手人的建议与禁区](#8-给接手人的建议与禁区)

---

## 0. 先读这段（最重要的三件事）

### 0.1 结论是什么

**D1 判定完成，结构结论 = 两窗链路 INDEPENDENT。**

这是**结构判别**，不是「A 优于 B」。通路 B 只有一条链，`coupleRatio` 对 B 恒为 0（物理上没有第二窗），所以这个量**只在通路 A 内部有意义**。

原始指标：A-I（并行注入）五轮 `coupleRatio = 0.010101~0.015152`，A-NC（`--serial` 串行负控）两轮 `1.010101 / 1.020202`。

**分离度 `1.010101 / 0.015152 = 66.67` 倍**（保守口径 `1.010101 / 0.010101 = 100.00` 倍）。

### 0.2 比结论更值钱的是：6 个判据缺陷（5 修 / 1 留）

**其中 2 个是「假通过」——它们让错误的数据看起来是合格证据：**

- **DEFECT-3 零分母假通过**：`injectCount=0`（本轮压根没注入）时，程序报 `INDEP_VERDICT=INDEPENDENT`。**4/4 份全错**，而且方向恰好是「通过」，所以没人会去查。
- **DEFECT-4 代码缺中间带**：文档要求 `coupleRatio ∈ [0.05, 0.50)` 判「不可判」，代码里**只有 0.5 一条边界，0.05 上界从未实现**。整段被静默判成 `INDEPENDENT`。活体：`0.349367 → INDEPENDENT`。

**6 个 DEFECT 的处置**：DEFECT-1/2/3/4/5 **已修**（DEFECT-2 是整段判别式替换为 `DRIFT_FRAMES`），DEFECT-6 **未修**；另加 1 项判据未点亮（`R_UNUSABLE_BLOCKY` 零阳性）。合计 **5 修 / 2 项如实留红**（见 §4）。

### 0.3 有一条会颠覆结论的环境陷阱

**同一二进制、同一臂、同样 60s，跨负载 `coupleRatio` 差 34.5 倍。**

安静环境 `另一窗掉拍 4/5/6`，高负载 `138/176/125`；`dropRate` 同步 `0.000404 → 0.013933`（也是 34.5 倍）。**两个量同倍数放大 ⇒ 不是判据变了，是环境基线变了。**

**所以本轮的 A-I/A-NC 结论只在安静环境成立。** 复跑前**必须先跑 A-N 短轮做环境前置门**，`dropRate > 0.002` 直接 abort。详见 §5。

**还有一个连带的坑（§5.4）**：连**验证修复**的那 4 轮（v5/v6）也是在脏环境下跑的。修复结论仍然成立（用的是方向判别、余量 60~244 倍），但那些**绝对值不可与安静轮比较**。

---

## 1. 背景：D1 原来为什么测不出来

原始方案测的是 **Δpx / Δframe**（两层渲染的像素级相位差）。它在 22 份采集上被判 `blocked(capability)`。

**关键：否决理由不是「样本不够」或「值太小」，而是「参数不恒定」。**

12 桶齐性 χ²(11)（α=0.001，临界 31.264）结果：

| 分类 | 份数 |
|---|---|
| 异质（λ≥5，χ²>31.264） | 15 |
| 异质（精确 Bonferroni） | 5 |
| **齐性** | **1 —— 且是人工注入轮 `lag60`** |
| 无检出力 | 1（`nc_pos8_g9`，O=11） |

⇒ **自然态 21 份：20 拒绝 / 1 无证据 / 0 齐性。**

唯一齐性样本是人造的注入轮，说明**自然态下 `R` 从来不具备比率语义**，正确物理定性是「**时变相位占比**」。

**这个区别很重要**：若误判成「样本不够」，就会有人继续加大 n 去救——但 χ² 拒绝的是「`p` 恒定」，而 `p` 本身随时间变，**加大 n 救不了**。

**处置**：原量保留为 `D1.Δpx_frame`，`weight: null`（不占权重，登记在 `blockedSubQuantities`）；D1 改由 `coupleRatio`（层间独立性）这条量补测。

---

## 2. 发现的问题（6 个 DEFECT + 1 项判据未点亮）

> 计数口径：**DEFECT-1~6 共 6 个**判据/文档缺陷；另单列 1 项「判据未点亮」（`R_UNUSABLE_BLOCKY` 零阳性），它不是缺陷，是**未验证**。合计 7 行 ⇒ 5 修 / 2 留红。

| ID | 问题 | 性质 | 状态 |
|---|---|---|---|
| **DEFECT-1** | `OTHER_P50_DELTA_MS > 3.0` 是**恒假门** | 判据失效 | ✅ 已修 |
| **DEFECT-2** | AC6 的 `std` 判别式在两臂上不兼容 | 判据失效 | ✅ 已替换 |
| **DEFECT-3** | 零分母**假通过** | **假通过（严重）** | ✅ 已修 |
| **DEFECT-4** | 代码**缺 0.05 中间带**，AC2 形同虚设 | **假通过（最严重）** | ✅ 已修 |
| **DEFECT-5** | 解读规则行**复用判决量的 KEY** | 可核对性 | ✅ 已修 |
| **DEFECT-6** | 架构师 §14.2 的**兼容表和它的公式不对应** | 文档不自洽 | ❌ 未修 |
| — | `R_UNUSABLE_BLOCKY` 阳性样本 = 0 | 判据未点亮 | ❌ 未修 |

---

## 3. 修了的问题（5 项）与怎么修的

### 3.1 DEFECT-1：`P50` 恒假门 → 改 `P95` 比值

**症状**：`OTHER_P50_DELTA_MS > 3.0` 判「另一窗被拖住」。**7 轮触发 0 次，包括应该红的串行负控。**

实测 7 轮该量全为 `-0.001 ~ 0.006 ms`。

**根因（构造性的，不是拟合的）**：注入是每 `150ms` 插 `12ms` stall，**占空比 = 12/150 = 8%**。中位数落在 50% 处，**按定义永远不会被 8% 的样本移动**。

⇒ **这不是「阈值定得太高」，是「量选错了」。** 任何机器上、任何阈值下它都几乎不可能触发。

**修法**：改用 `CROSS_P95_RATIO = P95(另一窗∩注入窗) / P95(另一窗∩清洁窗) > 1.5`。

**为什么 P95 能响应**：`P95` 落在最上面 5%，而受影响样本占 8%，**`8% > 5%` ⇒ P95 正好落在受影响集合内部**。这是由占空比与百分位定义的算术关系，与机器无关。

**为什么阈值取 1.5**（架构师 §14.3 给的构造推导，未引用实测值选值）：含 stall 的间隔 ≥ `12 + 6.06 = 18.06ms`，清洁 `P95 ≈ 6.20ms`，**构造下界 = 18.06/6.20 = 2.91**。取 1.5 距该下界留 1.94 倍余量，且比「完全无响应」的 1.0 高 50% ⇒ 两侧余量同数量级，不偏袒任一侧。

**修后实测**：串行 `3.5996~3.6477` → `TRIGGERED`；并行 `0.9989~1.0039` → `NOT_TRIGGERED`。（两轮串行分别来自 v5/v6，均为高负载环境——见 §5.4。）

**附带效果**：串行臂**首次达成 `INDEP_AGREEMENT=STRONG`**（修复前 5/5 全部 `OUT_OF_AGREEMENT`，因为两条判据永远不一致）。

**代码位置**：`source/d1_indep_probe2.cpp:656~694`（判据计算与输出；判决链见 3.4 的 `636~734`）

**顺带降级**：`OTHER_P50_DELTA_MS` 保留为**纯描述量**并打 `DESCRIPTIVE_ONLY=1`，不得作门。

**⚠ 与禁令的关系**：本判据按注入时刻对齐另一窗，是架构师 §6.4 禁令 2 的**唯一豁免**，三条件必须同时满足：(a) 只作交叉校验、不进主判决；(b) 函数名含 `crosscheck`；(c) 输出带 `CROSS_CHECK_ONLY=1`。已全部落实。

---

### 3.2 DEFECT-2：AC6 的 `std` 判别式 → 改 `DRIFT_FRAMES`

**症状**：`std(win0.relUs − win1.relUs) / medianIntervalUs` 判别式，要求串行 `< 0.05`、并行 `> 0.20`。

实测：并行 `16.0027`（判对），**串行 `0.2292 > 0.20` 被判成「并行」**（错）。

**根因**：分子用 `std`，它把**漂移**（两链相对相位的累积移动）与**抖动**（单帧时间噪声）**加在一起**。两臂抖动同量级，差别全在漂移：

| | 总漂移 | 漂移量（帧） | `std(diff)` | 去趋势后 `std` |
|---|---|---|---|---|
| 并行 | +339.861 ms | **56.1012 帧** | 96944.3 us | 14593.4 us |
| 串行 | −0.115 ms | **0.0190 帧** | 1387.9 us | 1381.3 us |

串行臂几乎无漂移（0.019 帧），但逐帧抖动 std=1387.9us ⇒ 得分 0.2292。**去趋势后串行 0.2281 仍 > 0.20 ⇒ 这个判别式在串行臂上恒假，不是阈值选错。**

**修法**（架构师 v2.4 §14.2 预置裁定）：改用**首尾各 10% 中位数差**

```
DRIFT_FRAMES := | median(diff[k], 后10%) − median(diff[k], 前10%) | / medianIntervalUs
serial   : < 1.0
threaded : > 5.0
[1.0, 5.0] : AC6_INCONCLUSIVE（不判 fail、不计入证据）
n < 5000   : INSUFFICIENT_PAIRS（低于 60s 一律 INCONCLUSIVE）
```

**为什么这样能分得开**：抖动是**零均值、不累积**的，首尾中位数差对它的响应是 `O(jitter/√n)`（n≈990 ⇒ 压 31.5 倍）——**抖动再大，只要不累积，这个差就接近 0**；漂移是**单边累积**，首尾中位数差恰好读到累积量本身。**这个量测的是「累积」这件事，而串行/并行的唯二结构差别就在「相对相位是否累积」。**

**修后实测**：串行 `0.0041`（`SERIAL`）/ 并行 `303.2886`（`PARALLEL`）。

**代码位置**：`source/d1_indep_probe2.cpp:786~837`

**验证来源（如实标注）**：`0.0041`（`v6_serial.txt`，`n_pairs=8995`）/ `303.2886`（`v6_AI.txt`，`n_pairs=9443`）。**两轮均在 loaded 环境**（见 §5.4）。差异倍数 `303.2886 / 0.0041 = 73972.8` 倍。

**⚠ 这里有 DEFECT-6（未修）**：架构师兼容表里的数值与他的公式不对应，详见 §4.1。

---

### 3.3 DEFECT-3：零分母假通过

**症状**：`injectCount = 0`（本轮没注入）时，程序报 `INDEP_VERDICT = INDEPENDENT`。**4/4 份全错**（1 份 8s + 3 份 60s）。

**根因**（原代码 `:599`）：

```cpp
const bool coupledByDrops = (injCount > 0) && (otherDrops * 2 >= injCount);
const char* verdict = coupledByDrops ? "COUPLED" : "INDEPENDENT";
```

`(injCount > 0) &&` 这个守卫**只拦住了「判耦合」**，却让「判不耦合」照常输出——`coupledByDrops` 在 `injCount=0` 时是 `false`，于是落到 `INDEPENDENT`。**空集被当成 0 参与了判决。**

**同一族还有第二处**：`INJ_WIN_DROP ∈ [0.8, 1.5] × injectCount` 在 `injectCount=0` 时退化成 `[0, 0]`，**区间退化了却仍然成立**，任何取值都「通过」。**区间退化不是「更严格」，是「无定义」。**

**修法**：

```cpp
const bool zeroDenominator = (injCount == 0);
printf("DIVIDE_GUARD=%s\n", zeroDenominator ? "ZERO_DENOMINATOR" : "OK");
if (zeroDenominator) {
  printf("COUPLE_RATIO=null COUPLE_RATIO_DENOM=0 COUPLE_RATIO_STATUS=UNMEASURABLE\n");
  printf("INJ_WIN_DROP_RATIO_CHECK=INVALID ...\n");
} else { ... }
```

判决侧：`zeroDenominator ⇒ verdict = "UNMEASURABLE"`，且 `INDEP_AGREEMENT = UNDEFINED`。

**规矩**：**分母为 0 的量一律输出 `null` + 显式状态，绝不输出数字，也绝不落到某个 verdict。**

**修后实测**：`DIVIDE_GUARD=ZERO_DENOMINATOR`、`COUPLE_RATIO=null`、`INDEP_VERDICT=UNMEASURABLE`。

**代码位置**：`source/d1_indep_probe2.cpp:602~634`（守卫）＋ `695~734`（由零分母重定向的判决与一致性）

**同族问题**：`d1_r_probe.cpp:438` 曾有 `smp.injected = 0` 硬编码（串行分支永远报 `INJECTION_UNDEFINED`），已修为 `smp.injected = injected`。

---

### 3.4 DEFECT-4：代码缺「中间带」（最严重）

**症状**：架构文档 AC2 要求 `coupleRatio ∈ [0.000, 0.050]` 才判 `INDEPENDENT`，§2.4 状态转移表第 3 行要求 `[0.050, 0.500]` 判「中间带 ⇒ `UNMEASURABLE` / blocked」。

但代码**只有一条边界**：

```cpp
const bool coupledByDrops = (injCount > 0) && (otherDrops * 2 >= injCount);  // 即 >= 0.5
```

**`0.05` 上界在代码里没有任何分支承接** ⇒ `0.050~0.500` 整段被静默判成 `INDEPENDENT`。

**活体证据**：`t04v2_AI_r1/r2/r3` 实测 `coupleRatio = 0.349367 / 0.446701 / 0.316456`，按文档都该是 `UNMEASURABLE`，旧代码**全报 `INDEPENDENT`**。

**这是「规则写在注释里、不写进代码分支 = 没写」的又一实例。** 「0.000~0.050 才算 INDEPENDENT」这句要求，实际只能靠「数据恰好落在那儿」满足，**不是靠判据拦住**。

**修法**：三带，边界由常量驱动（防再次漂移）

```cpp
const double INDEP_BAND_LO = 0.050;  // < LO  ⇒ INDEPENDENT
const double INDEP_BAND_HI = 0.500;  // >= HI ⇒ COUPLED；[LO, HI) ⇒ INCONCLUSIVE

const bool coupledByDrops    = (injCount > 0) && (r >= INDEP_BAND_HI);
const bool bandInconclusive  = (injCount > 0) && (r >= INDEP_BAND_LO) && (r < INDEP_BAND_HI);

verdict = zeroDenominator ? "UNMEASURABLE"
        : coupledByDrops  ? "COUPLED"
        : bandInconclusive? "UNMEASURABLE"     // 带 INDEP_UNMEASURABLE_REASON=BAND_AMBIGUOUS
        :                   "INDEPENDENT";
```

同时 `INDEP_AGREEMENT` 在中间带必须报 `UNDEFINED`（主判据本身不可判，交叉校验无从谈起），**不得写成 `STRONG`**。

**修后实测**：`0.189873` / `0.237975` / `0.275949` 全部正确落 `INCONCLUSIVE → UNMEASURABLE`。

**合成边界扫描**（验证无重叠无空洞）：`0 → INDEP`、`0.047980 → INDEP`、`0.050505 → AMBIG`、`0.348485 → AMBIG`、`0.497475 → AMBIG`、`0.500000 → COUPLED`、`1.010101 → COUPLED`。

**代码位置**：`source/d1_indep_probe2.cpp:636~734`

---

### 3.5 DEFECT-5：规则行复用判决 KEY

**症状**：解读规则段有一行

```cpp
printf("INDEP_VERDICT=UNMEASURABLE (ZERO_DENOMINATOR) => 本轮无注入，两条判据都无定义；\n");
```

它是**无条件 `printf` 常量**（每一份日志都会打），却在文本上长得和真正的判决行一模一样。

**后果**：任何 `grep "^INDEP_VERDICT="` 都会在**每一份日志**里命中它。于是一轮明明判 `INDEPENDENT` 的输出里同时出现 `UNMEASURABLE`——**我自己的核对脚本先被骗了**，以为该轮是零分母轮。

**根因不是「读得不够仔细」，而是「规则行借用了判决量的 KEY」，让人无法靠 KEY 区分常量与结果。**

**修法**：规则/说明行一律用 `RULE_` 前缀，判决量的 KEY 只由分支产出。

```cpp
printf("RULE_ZERO_DENOMINATOR => ...\n");
printf("RULE_BAND_AMBIGUOUS => ...\n");
printf("RULE_EFFECTIVE_PLUS_INDEPENDENT => ...\n");
printf("RULE_EFFECTIVE_PLUS_COUPLED => ...\n");
```

**修后实测**：`grep -c '^INDEP_VERDICT='` 从 **2 行降到 1 行**。

**代码位置**：`source/d1_indep_probe2.cpp:777~784`（`RULE_` 段本身；注释理由在 `768~776`）

**规矩**：**KEY 是机器可读的接口，不是给人看的标题。**

---

## 4. 没修的问题（2 项）

### 4.1 DEFECT-6：架构师 §14.2 的兼容表和它的公式不对应（未修）

**这是文档不自洽，不是代码缺陷。**

架构师 `R101-M2-D1-架构裁定.md` §14.2 的**正文公式**定义的是：

```
DRIFT_FRAMES := | median(后10%) − median(前10%) | / medianIntervalUs
```

但同一节的**兼容性检查表**里列的实测值是 `56.1012 / 0.019`——那是**端点差法**（`diff[last] - diff[0]`）的数。按他正文的公式复算同一份数据：

| 文件 | 端点差法 | 架构师公式 | 比 |
|---|---|---|---|
| `t04_AI_r4.jsonl` | `56.1012` | `47.3967` | 1.18 |
| `t04_ANC_s2.jsonl` | `0.0190` | `0.0017` | 11.15 |

**两法判决方向一致**（>5.0 / <1.0），所以**不影响结论**；但**表里的数值不可复核**——任何人拿公式去验表，会得到差 1.18 倍与 11.15 倍的结果。

**讽刺之处**：端点差法只用了 **1 个样本**，正是架构师自己在 §14.2 理由 1 里批评的「把无关成分混进读数」的轻量版。

**我的处置**：探针按**公式**落地（用 983 个样本而非 1 个），并在 `noise.json` 的 `ac6DriftFrames.DISCREPANCY` 里完整登记，**没有擅自改架构师文档**。

**建议修法（二选一，不能混）**：
1. 兼容表改用公式对应的数（`47.3967 / 0.0017`）；或
2. 把公式改成端点差法，并说明为什么不怕单点噪声。

---

### 4.2 `R_UNUSABLE_BLOCKY` 阳性样本 = 0（未修）

判序第 3 级 `λ_b < 5 && MODE_SHARE > 0.9 ⇒ R_UNUSABLE_BLOCKY`。

架构师已如实登记 **`VERIFIABLE=0`** 并下派构造负控，但**本轮没有构造**。

**这意味着**：该判决分支从未被任何样本触发过 ⇒ 按「任何进主判序的门必须有 ≥1 个能触发它的阳性样本」这条规则，它**尚未验证**。

**这是诚实的留红，不是遗漏。** 接手人若要闭合，需主动构造一个 `λ_b < 5`（事件数极稀疏）且 `MODE_SHARE > 0.9` 的样本。

---

## 5. 环境陷阱（会颠覆结论，必须知道）

### 5.1 实测

同一二进制、同一臂、同样 60s：

| 环境 | 另一窗掉拍 | `coupleRatio` | `dropRate` |
|---|---|---|---|
| 安静（22:53~23:00） | 4 / 5 / 6 | `0.010127 / 0.012626 / 0.015152` | `0.000404 / 0.000505 / 0.000404` |
| 高负载（01:20~01:51） | 138 / 176 / 125 | `0.349367 / 0.446701 / 0.316456` | `0.013933` |

**`138 / 4 = 34.5` 倍** 与 **`0.013933 / 0.000404 = 34.5` 倍** —— **两个量同倍数放大 ⇒ 不是判据变了，是环境基线变了。**

当时后台有 6 个 WorkBuddy + 3 个 msedge + msedgewebview2 + sandbox-center + GameViewer，CPU 累计 340 / 243 / 220…

### 5.2 后果

**高负载下 A-I 会落进 `[0.05, 0.50)` 中间带，判 `UNMEASURABLE`。**

这**恰好是 DEFECT-4 修复后才有的正确行为**——修复前它会在脏数据上**假报 `INDEPENDENT`**。也就是说：**修复 DEFECT-4 和保护结论不被脏数据污染，是同一件事的两面。**

### 5.3 必须做的事

**每轮采集前先跑一次 A-N 短轮（8s）做环境前置门：**

```
win0/win1 dropRate > 0.002  ⇒  ENV_NOT_QUIET，abort，不产出任何 coupleRatio
```

**建议架构师把这条写进规范，与 `INJECT_COUNT_MIN=200` 并列。** 否则将来任何人复跑都会拿到脏数据而不知道。

### 5.4 ⚠ 一个容易被忽略的事实：修复验证也是在脏环境里做的

**这条是我在收口核对时才查出来的，必须写明，否则读者会误以为修复是在干净基线上验的。**

| 轮次 | 用途 | 未注入窗 `dropRate` | 相对安静基线 |
|---|---|---|---|
| `t04_AI_r1~r3` | 安静基线（参考） | `0.000404 / 0.000506 / 0.000606` | 1× |
| `v5_AI` / `v6_AI` | 验 DEFECT-1、AC6 | `0.009598 / 0.011553` | 约 19~29 倍 |
| `v5_serial` / `v6_serial` | 验 DEFECT-1、AC6 | `0.059072 / 0.062153` | 约 146~154 倍 |

**四轮验证全部在高负载下采的。**

**为什么这不影响修复的结论**：两个修复都是**方向判别**，不是绝对基线判别——

- `CROSS_P95_RATIO`：串行 `3.60~3.65` 距 1.5 阈有 2.4 倍余量，并行 `0.9989~1.0039` 距 1.5 有 1.5 倍余量。高负载同时抬高两臂的 P95，**比值近似不变**（这正是用比值而非差值的好处）。
- `DRIFT_FRAMES`：串行 `0.0041` 距 1.0 上界有 **244 倍**余量，并行 `303.2886` 距 5.0 下界有 **60.7 倍**余量，两臂跨 **7.4 万倍**。基线上浮一个数量级也翻不了判。

**但不能做的事**：把 `303.2886` 或 `0.0041` 这些**绝对值**跟将来安静轮的数字直接比。它们只在「高负载下的两臂对比」这个语境内有意义。

**本会话收口时又测了一次环境**（`--seconds=8 --stall-ms=0`）：

```
WIN0_DROP_RATE=0.118745  WIN1_DROP_RATE=0.074980
⇒ 0.118745 / 0.002 = 59.4 倍；0.074980 / 0.002 = 37.5 倍
```

**远超前置门阈值，所以本会话无法重采安静数据。** 这不是「懒得重跑」，是物理上办不到——后台进程属本会话自身。已在 `noise.json` 的 `environmentSensitivity.probeOfCurrentSession` 留证。

### 5.5 另有一个仪器自检门在脏环境里红过一次（不影响结论）

高负载串行轮 `v6_serial` 报 `INJ_WIN_DROP_RATIO_CHECK=FAIL injDropRatio=1.549367`（`612` 掉拍 / `395` 注入），越上界 `1.5` 约 3.3%。

| 轮次 | `injDropRatio` | 触发 |
|---|---|---|
| 安静（`t04_ANC_serial`） | `1.010~1.038` | PASS |
| 高负载并行（`v5_AI`/`v6_AI`） | `1.246 / 1.268` | PASS |
| 高负载串行（`v5_serial`/`v6_serial`） | `1.438 / 1.549` | **PASS / FAIL** |

**为什么串行臂会大**：串行采样下，一次 `12ms` stall 会同时拖长多个相邻间隔 ⇒ 「1 次注入」可能产出 >1 个长间隔。负载越高、采样相对 stall 越密，这个比值越大。**单调随负载上升 ⇒ 是真实响应，不是恒真/恒假门。**

**方向是 SAFE 的**：红 = 判可疑，不会把坏数据判成好数据——与 DEFECT-3/4 的「假通过」方向相反。

**处置：登记不改。** 上界 `1.5` 没有构造性依据（是拍出来的），高负载下必红 ⇒ 属 `PENDING-CALIBRATION`，与 `inflate=4.0`、`PACING_RATIO=1.05` 同族。本轮的 `INDEP_VERDICT` 不读这个门，所以它红**不影响任何结论**；但它恰好是**将来做环境前置门的现成信号**：该门红 ⇒ 环境不安静。

---

## 6. 最终证据与验收状态

### 6.1 采集结果（`d1_indep_probe2.exe`，`--seconds=60 --stall-every=150 --stall-ms=12`）

| 臂 | `injectCount` | 注入窗掉拍 | 另一窗掉拍 | `coupleRatio` | 判决 |
|---|---|---|---|---|---|
| A-I r1 | 395 | 399 | 4 | `0.010127` = 4/395 | INDEPENDENT |
| A-I r2 | 396 | 401 | 5 | `0.012626` = 5/396 | INDEPENDENT |
| A-I r3 | 396 | 400 | 6 | `0.015152` = 6/396 | INDEPENDENT |
| A-I r4 | 396 | 401 | 5 | `0.012626` = 5/396 | INDEPENDENT |
| A-I rev（注入窗 1） | 396 | 399 | 4 | `0.010101` = 4/396 | INDEPENDENT |
| A-NC s1（`--serial`） | 396 | 401 | 400 | `1.010101` = 400/396 | COUPLED |
| A-NC s2（`--serial`） | 396 | 411 | 404 | `1.020202` = 404/396 | COUPLED |
| A-N r1~r3（无注入） | **0** | 4/5/4 | 4/5/4 | `null` | UNMEASURABLE |

**关键**：`injectCount` **全部 395~396**（理论 400，落地率 98.75%~99.00%）⇒ 7/7 轮 ≥ `INJECT_COUNT_MIN=200`。

**这解除了架构裁定 §2.3-A 那条「五组全部 52 ⇒ 状态转移表第 4 行恒真」的缺陷**（此前所有探针只跑 8s，`8/0.15 ≈ 53`）。该行恢复为「偶发失效出口」。

**反向臂**（注入窗 1）`0.010101` 与正向 `0.010127` 同侧 ⇒ **不是「窗 0 特权」**。

### 6.2 AC 逐项

| AC | 结果 |
|---|---|
| AC1 `env.json` tiers | ✅ PASS（`tiersAvailable=["165"]` + 60Hz 不存在登记） |
| AC2 `injectCount ≥ 200` | ✅ PASS（395~396） |
| AC3 A-N `dropRate ≤ 0.002` | ✅ PASS（max win0 `0.000505` / win1 `0.000506`） |
| AC4 A-I vs A-N 臂别分离 | ✅ PASS |
| AC5 `repro.md` | ✅ PASS |
| AC6 结构判别式 | ✅ 已由 `DRIFT_FRAMES` 替换（原 `std` 式作废） |
| AC7 `noise.json` N=极差 | ✅ PASS（A-I n=5 极差 `1.5000` 倍，逐轮原值齐全） |
| AC8 代码带 == 文档带 | ✅ PASS（DEFECT-4 修复后） |

### 6.3 交付物

**结论面（入库）**
```
deliverables/dev-plan/r101-evidence/
├── verdict.json                     # 裁决（派生式覆盖率 60/100）
├── env.json                         # 环境
├── R101-M2-c-裁决报告.md            # 报告（§A~§G）
└── d1/
    ├── env.json                     # D1 环境（tiers/几何/注入参数）
    ├── aggregate.json               # D1 七轮原值 + 极差 + 两臂分离
    ├── noise.json                   # AC 逐项 + 6 缺陷登记 + 修复验证 + 环境敏感性
    └── repro.md                     # 逐臂命令 + sha256
```

**探针源码镜像（入库）**

`native/build/` 被 `.gitignore:40` 忽略，探针源码留在那里等于「文档引用的文件在仓库里看不到」。所以把**最终态源码**镜像到本目录：

```
handover/r101-m2-d1/source/
├── d1_indep_probe2.cpp   # 43722 B  sha256 a6a4bde455754df5d9980bec79738d7e13621703eeb8a29b5d47a485b51394a2
└── bd1indep2.bat         #   997 B  sha256 b7c4173f3069c8dd3ae3c5c941e824551533589da67a6cd3c1518db9c0c298bf
```

**本文档中所有 `d1_indep_probe2.cpp:行号` 的引用，都以这份镜像为准**（与 `native/build/m2probe/` 下同名文件**逐字节相同**，sha256 一致）。编译照 §7.1 拷回去即可。

**原始面（不入库，`native/build/` 被 `.gitignore:40` 忽略）**
```
native/build/m2probe/t04_*.txt|jsonl   # 首轮 10 轮
native/build/m2probe/v3_*.txt          # DEFECT-4 修复后
native/build/m2probe/v4_*.txt          # DEFECT-5 修复后
native/build/m2probe/v5_*.txt          # DEFECT-1 修复后（高负载环境，见 §5.4）
native/build/m2probe/v6_*.txt|jsonl    # AC6 DRIFT_FRAMES 落地后（高负载环境，见 §5.4）
```

> ⚠ 这 5 组原始日志**不在仓库里**，只在本机。要留住证据，先复制出来（见 §8.2 禁区 5）。
>
> ⚠ `v3~v6` 是**逐缺陷修复后**的重采，其中 `v5/v6` 已在 **loaded** 环境（`dropRate` 是安静轮 20~154 倍）。判断某个修复是否成立时，看的是**方向与余量**，不是绝对值。

### 6.4 校验器

```bash
python tools/verify_r101_verdict.py deliverables/dev-plan/r101-evidence/verdict.json
# RESULT: PASS  (all 37 checks passed)  rc=0
```

**覆盖率从 `80/100` 更正为 `60/100`**：`dims[D1]=30 + dims[D2]=30 + dims[D3]=blocked(20 不计)`，上限 `80/100`。原 `80/100` 是算错的（只测了 D2 却写了 80）。

**负控验证**（证明判据有分辨力，不是「任何改动都红」）：

| 负控 | 改动 | 期望 | 实测 |
|---|---|---|---|
| NC-COV-2 | D1 `weight` 改回 0 | 红 | ✅ 红（1 violation） |
| NC-COV-3 | D1 `status` 改 `fail` | 红 | ✅ 红（2 violations） |
| NC-COV-1 | D2 改 `blocked` 但 coverage 仍 60 | 红 | ✅ 红（1 violation） |
| NC-COV-4 | 删 D1 的锚点 | 红 | ✅ 红（1 violation） |
| 应绿对照 | 只改不参与判据的描述字段 | 绿 | ✅ 绿（37/37 PASS） |
| 应绿对照 2 | D3 改 `measured`（派生应变 80，声明 60） | 红 | ✅ 红（2 violations） |

---

## 7. 复现步骤

### 7.1 编译探针

```bash
# 源码在本目录：handover/r101-m2-d1/source/
# 编译需要它落在 native/build/m2probe/ 下（同名同目录），所以先拷回去：
cp handover/r101-m2-d1/source/d1_indep_probe2.cpp native/build/m2probe/
cp handover/r101-m2-d1/source/bd1indep2.bat        native/build/m2probe/

cd native/build/m2probe
cmd //c bd1indep2.bat          # MSVC 手工工具链，CL_EXIT=0 零告警
# 产物 d1_indep_probe2.exe（89600 B，sha256 c26447a4...786eb）
```

**注意**：本机 `vcvars64.bat` 不可用（内部调 `reg.exe` 被安全策略拦）。`bd1indep2.bat` 用手工 `set INCLUDE/LIB/PATH`，**必须带 `/utf-8`**，且 `cl` 必须在 `.bat` 内经 `cmd //c` 跑（Git Bash 直跑会被 MSYS 转坏 `/nologo`）。

### 7.2 环境前置门（**必做，不可跳过**）

```bash
./d1_indep_probe2.exe --seconds=8 --stall-every=150 --stall-ms=0 --inject-win=0
# 看 WIN0_DROP_RATE / WIN1_DROP_RATE，任一 > 0.002 ⇒ ENV_NOT_QUIET，停止，别往下跑
```

**本机实测（写文档时的状态，供对照）**：

```
WIN0_DROP_RATE=0.118745   WIN1_DROP_RATE=0.074980
⇒ 分别是阈值的 59.4 倍 / 37.5 倍 ⇒ ENV_NOT_QUIET，本机当时不可采集
```

**这一门没有写进架构文档**，是 team-lead 在 R101 收口时提的建议。**在你手上它还不是规范，但它是本轮最贵的一条经验**：不跑它，采到的 `coupleRatio` 会从 `0.010` 漂到 `0.30`（30 倍），而你不会知道为什么。

### 7.3 正式采集（逐轮串行，一轮一停）

```bash
# A-I 正向（注入窗 0）
./d1_indep_probe2.exe --seconds=60 --stall-every=150 --stall-ms=12 --inject-win=0
# A-I 反向（注入窗 1）—— 排除「窗 0 特权」
./d1_indep_probe2.exe --seconds=60 --stall-every=150 --stall-ms=12 --inject-win=1
# A-NC 串行负控（应红）
./d1_indep_probe2.exe --seconds=60 --stall-every=150 --stall-ms=12 --inject-win=0 --serial
# A-N 无注入（应 UNMEASURABLE）
./d1_indep_probe2.exe --seconds=60 --stall-every=150 --stall-ms=0  --inject-win=0
# 带 JSONL（AC6 需要）
./d1_indep_probe2.exe ... --jsonl=out.jsonl
```

### 7.4 关键输出字段怎么看

| 字段 | 含义 |
|---|---|
| `INJECT_COUNT` | 实际注入次数，**必须 ≥ 200**（60s 理论 400） |
| `DIVIDE_GUARD` | `ZERO_DENOMINATOR` ⇒ 本轮无注入，下面的判决无效 |
| `COUPLE_RATIO` | 主判据。`null` = 无定义 |
| `INDEP_BAND ... band=` | `INDEPENDENT` / `INCONCLUSIVE` / `COUPLED` / `UNDEFINED` |
| `INDEP_VERDICT` | 最终判决。**恰好 1 行**（多行 = DEFECT-5 复发） |
| `CROSS_P95_RATIO` | 交叉判据（旁证，不进主判决）。`CROSS_CHECK_ONLY=1` |
| `AC6_DRIFT_FRAMES` | 结构判别式。`SERIAL` / `PARALLEL` / `INCONCLUSIVE` |
| `INJECTION_VERDICT` | `INJECTION_EFFECTIVE` 才说明仪器有分辨力 |

**⚠ 读日志的陷阱**：`RULE_` 开头的行是**无条件常量**，不是判决结果。只看不带 `RULE_` 前缀的行。

---

## 8. 给接手人的建议与禁区

### 8.1 建议

1. **先跑环境前置门再采集**，这是本轮最贵的教训。
2. **D1 已可结案**，但结论只在安静环境成立。要写进报告的口径是「D1 判定完成，结构结论 = 两窗链路 INDEPENDENT」，**不要说「A 通过 D1」或「A 优于 B（D1）」**——`coupleRatio` 对 B 恒为 0，这个比较不成立。
3. **`coupleRatio` 不可跨轮比较**（跨负载差 34.5 倍）。要比就同环境同轮次比。
4. **闭合 DEFECT-6**：拿公式去验架构师的兼容表，选一种口径统一。
5. **点亮 `R_UNUSABLE_BLOCKY`**：构造 `λ_b < 5` 且 `MODE_SHARE > 0.9` 的稀疏样本。
6. **想用 `AC6_DRIFT_FRAMES` 做门，先安静环境重采**：本轮的 `303.2886 / 0.0041` 是 loaded 环境的值（§5.4），只能证明方向，不能当基线。
7. **不要删 `noise.json` 里那些「不好看」的字段**：`gateObservations`（`INJ_WIN_DROP_RATIO_CHECK` 红过 1 次）、`environmentSensitivity.probeOfCurrentSession`（本机 59 倍于阈值）这些是本轮诚实性的凭证。留着比删掉有用。

### 8.2 禁区

1. **不要事后按实测结果调阈值**——那是「看着结果挑标准」。阈值必须预置并写明构造理由。本轮的 `1.5` 与 `1.0/5.0` 都是架构师按构造推的，实测只用于**事后兼容核对**。
2. **不要用 `std` 判「有没有漂移」**——它把抖动与漂移加在一起，抖动大的臂会被顶过阈值。
3. **不要用 `P50` 判 8% 占空比的注入响应**——P50 按定义不响应。
4. **不要让任何判决 KEY 在日志里出现 2 次**——常量不许借用判决 KEY。
5. **`native/build/` 被 `.gitignore` 忽略，删了就永久丢失**（本轮教训：`outputs/` 一次误删导致 9 项 pytest 永久不可恢复）。要保留原始证据先复制出来。
6. **不要把 `coupleRatio` 的「绝对值」写进任何验收阈值**——它是**比值**，但分母 `injectCount` 与分子 `otherDrops` 都随环境漂。跨负载实测差 30 倍。判据只在「同环境、同轮次、两臂对比」这个语境内有效。
7. **不要因为 `INJ_WIN_DROP_RATIO_CHECK=FAIL` 就去改 `1.5`**——那是 `PENDING-CALIBRATION` 的拍定值，改它得先有构造性依据（§5.5）。

### 8.3 一个方法论提醒

**本轮最贵的东西不是那个 66.67 倍分离度，而是「两个假通过是怎么被发现的」。**

- DEFECT-3 和 DEFECT-4 的共同形态：**方向恰好是「通过」**，所以跑得通、没人查。
- 发现它们的唯一方法：**逐条 AC 去代码里找对应的比较表达式**。找不到，就是没实现。

**这条建议比任何数值都重要。**