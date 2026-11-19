# Harbor R47 轮报告（2026-11-07）——性能优化准备轮

> 定位：把「感觉慢」变成「哪里慢、多慢、优化后对比什么」。产出=实测基线文档
> + 启动打点 + 快赢（hub-catalog 懒加载）+ 性能门禁。基线文档（含复测口径）：
> `outputs/r47-perf/baseline.md`（本地留存）。

---

## 0. 一眼看全局

| 项 | 数值 |
|---|---|
| 基线 | 启动分段（server 1190ms / db 1235ms / window 1480ms）· 构建 372ms · 产物 3.87MB · 源码 3.2MB/115 模块（hub-catalog 占 58%）· 渲染微基准四项 |
| 快赢 | **hub-catalog 懒加载**（1.2MB 顶层字面量 → JSON 字符串 + hubCatalog() 首次访问懒解析；未开市场面板的启动零解析，首次访问 4.21ms/394 专家完整） |
| 门禁 | build×2 一致 / 五契约 PASS / 锚点 **r47**（1266 符号）/ audit PASS / **pytest 1979+ 绿（终态见提交）** |
| 新增测试 | `test_r47_perf.py`（4：懒加载形态/行为实测/启动打点/产物字节上限） |

## 1. 基线要点（详见 baseline.md）
- **启动分段**（HARBOR_PERF_MARKS=1，dev 口径）：进程→server-listening 1190ms
  占 80%（fastify+prisma+导入），→window-loaded 1480ms；冻结包需同口径重测。
- **源码字节 Top**：hub-catalog 1.86MB（58%）/ run-controller 78.8KB /
  group.js 64.5KB——单文件架构下主线程解析成本的分布地图。
- **渲染微基准**：session_search 9.3ms / stream_schedule 2.2ms /
  analytics_render 48.9ms（p95 63.5——低频面板可接受）/ terminal ~0。

## 2. 快赢：hub-catalog 懒加载（F2a④/F3a-6）
1.2MB 顶层对象字面量 → `HUB_CATALOG_JSON` 字符串 + `hubCatalog()` 首次访问
懒解析（hub-market.js 5 处引用同步改写）。实测：模块加载 5.86ms 零解析
（`_HUB_CATALOG` 保持 null）、首次 `hubCatalog()` 4.21ms（394 专家完整）。
未打开市场/连接器面板的启动完全跳过 1.2MB 解析+分配。

## 3. 下一批候选（基线 §5，按证据排序）
1. hub-catalog 移出主 bundle（harbor:// fetch 外链 → 主 bundle -31%）
2. server 启动段 1.2s 分解（--cpu-prof → 延迟 require）
3. orjson 序列化（F3c①；隔离 venv 基建已备）
4. 大截图落盘传路径（F3c⑤）/ sandbox 子进程池化（⑥）
5. hljs core+按需语言（F3b⑧）/ Node 桥 under-pressure（F3c⑧）

## 4. 踩坑增量
- **测试基建符号名污染（第三次）**：foundation 两段式 replace 的 BODY 坑
  （R45）之后，本轮确认 basename 歧义 key 丢弃（`hub-catalog.js` basename
  可用但 `context.js` 不可用）+ 断言目标必须排除 system 行/提示行（R46）
  + json.dumps(body) 误当代码嵌入（R47 新踩——body 必须**直接嵌入**不能
  dumps 成字符串字面量）。
- git diff 的 `+` 行与文件真实内容核对：heredoc 转义层吃 `\n` 时
  `grep -n` 看到的与 cat -A 一致才算数。

## 5. 交付物索引
| 类别 | 路径 |
|---|---|
| 基线文档（本地） | `outputs/r47-perf/baseline.md` |
| 本报告 | `deliverables/dev-plan/HANDOVER-R47.md` |
| 契约锚点 | `deliverables/dev-plan/contract-baseline-r47.json` |
