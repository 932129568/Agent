# D1 · T04 采集执行 · 可复现命令

> 采集日：2026-11-21 22:00~22:30（本地时区 +08:00）
> 探针：`native/build/m2probe/d1_indep_probe2.exe`（82944 B，mtime 2026-11-21 16:06，本轮未重编）
> 工作目录：`C:\v4h\proj\native\build\m2probe`
> 环境：quiet（每轮串行、一轮一停，采集期间无编译/编辑/分析）

## 臂定义

| 臂 | 含义 | 预期 | 轮次 |
|---|---|---|---|
| **A-I** | 双线程、注入窗 0 | `INDEPENDENT`（`coupleRatio ≤ 0.05`） | r1 r2 r3 r4 + 反向 rev（注入窗 1） |
| **A-NC** | `--serial` 单线程串行（复刻 `dcomp_demo` 的 `for(i)`） | `COUPLED`（`coupleRatio ≥ 0.50`） | s1 s2 |
| **A-N** | 无注入（`--stall-ms=0`），环境 guard | 两窗 `dropRate ≤ 0.002` | r1 r2 r3 |

## 逐臂命令

```bash
# A-I 正向（注入窗 0）—— 3 轮 + 1 轮带 JSONL
./d1_indep_probe2.exe --seconds=60 --stall-every=150 --stall-ms=12 --inject-win=0            > t04_AI_r1.txt 2>&1
./d1_indep_probe2.exe --seconds=60 --stall-every=150 --stall-ms=12 --inject-win=0            > t04_AI_r2.txt 2>&1
./d1_indep_probe2.exe --seconds=60 --stall-every=150 --stall-ms=12 --inject-win=0            > t04_AI_r3.txt 2>&1
./d1_indep_probe2.exe --seconds=60 --stall-every=150 --stall-ms=12 --inject-win=0 --jsonl=t04_AI_r4.jsonl > t04_AI_r4.txt 2>&1

# A-I 反向（注入窗 1）—— 排除「窗 0 特权」
./d1_indep_probe2.exe --seconds=60 --stall-every=150 --stall-ms=12 --inject-win=1            > t04_AI_rev.txt 2>&1

# A-NC 串行负控（应红）
./d1_indep_probe2.exe --seconds=60 --stall-every=150 --stall-ms=12 --inject-win=0 --serial           > t04_ANC_serial.txt 2>&1
./d1_indep_probe2.exe --seconds=60 --stall-every=150 --stall-ms=12 --inject-win=0 --serial --jsonl=t04_ANC_s2.jsonl > t04_ANC_s2.txt 2>&1

# A-N 无注入（环境 guard）
./d1_indep_probe2.exe --seconds=60 --stall-every=150 --stall-ms=0  --inject-win=0            > t04_AN_r1.txt 2>&1   # 同理 r2 r3

# NC-D1-INDEP-3 零分母（8s 即可）
./d1_indep_probe2.exe --seconds=8  --stall-every=150 --stall-ms=0  --inject-win=0            > t04_NC3_zero.txt 2>&1
```

## 原始产物 sha256

| 文件 | sha256 |
|---|---|
| `t04_AI_r1.txt` | `3f7a93bc7d528a3bace36456b8943d172d880ed7e8487997d1f20f868e6de55f` |
| `t04_AI_r2.txt` | `8ab07eebefba94bd6b2ab83af36c8e89c7bfa4a6e4b1cba84dfc1a6a9307de74` |
| `t04_AI_r3.txt` | `6802b300f93733cf7c999c5ba2ecd75e488d86fb173e7250c7b642220f967b78` |
| `t04_AI_r4.txt` | `89c2b965a3934311cad3d511b8677790f62e5c54b19118068d2f3d4f0d78acf1` |
| `t04_AI_rev.txt` | `0a744f2cc2345642183c94f7fc43338fdac4def2e5a92eec1ec802fdba3447b7` |
| `t04_ANC_serial.txt` | `22ccaad0a1fc5c9542863199a26dddd0f4dc8c3f0633e37cae104c9ba38d22dd` |
| `t04_ANC_s2.txt` | `c8f57a549bb553991eb20aae2b5809f2b19f4ec491c13de5d8b54f1c2b46d166` |
| `t04_AI_r4.jsonl` | `05674f34f7e10d02285a0797fc9e6a8e36ac4b8fa97a2288aa3598a9a178c834` |
| `t04_ANC_s2.jsonl` | `57a5af1f30a38915bacfc11cb2b6b5574d40a56fb00b88796f977afebc8c1b43` |

原始文件留在 `native/build/m2probe/`（该目录被 `.gitignore:40 build/` 忽略，不入库）。
入库面 = 本文件 + `env.json` + `aggregate.json` + `noise.json`。

## 复现性说明

- `INJECT_COUNT` 7 轮实测 395~396（理论 400），落地率 98.75%~99.00%，**全部 ≥ `INJECT_COUNT_MIN=200`**。
  此前五组探针全部只有 52（8s 轮），使状态转移表第 4 行恒真；本轮已解除。
- `WINDOWS=2 OVERLAP=1 RECT=(500,400) 400x300`：两窗完全重叠，D1 的真实形态是层间不是并列。
- vsync 实测 `p50=6056~6066us`（165Hz），`GLOBAL_GAP_MEDIAN_MS≈6.058`。
- 每轮 `SHUTDOWN=OK EXIT=0`。

## 已知缺陷（详见 `noise.json` → `gateDefects`）

1. **DEFECT-1** `COUPLED_BY_TIME_WINDOW` 恒真（0/7 触发，含应红的串行负控）—— 用 P50 不敏感，P95 才有响应（串行 2.604 倍 / 并行 0.999 倍）。
2. **DEFECT-2** AC6 结构判别式阈值带与实测不兼容（串行 0.2292 > 0.20 被判成「并行」）—— 分子用 std 分不开抖动与漂移，改用「总漂移帧数」得 2952.7 倍分离。
3. **DEFECT-3** 零分母假通过（`injectCount=0` 时仍输出 `INDEPENDENT`）—— AC3 要求 `UNMEASURABLE`，实测 4/4 份全错。

三条均**未修改探针代码**，只登记。修法见 `noise.json` 的 `suggestedFix`，须下一轮以预置方式重定阈值。
