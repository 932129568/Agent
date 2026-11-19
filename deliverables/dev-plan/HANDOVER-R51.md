# Harbor R51 轮报告（2026-11-07）——性能优化实施第一批

> 接续 R47 基线：启动分段定位瓶颈 + orjson 序列化层。基线文档（本地）：
> `outputs/r47-perf/baseline.md`。

---

## 0. 一眼看全局

| 项 | 数值 |
|---|---|
| 启动瓶颈定位 | **`import server/src/app.js` = 1215ms（占 boot 80%）**——fastify+prisma+全部 service 导入 |
| orjson 基准 | dumps **6.9x** / loads 1.5x（35KB 典型载荷） |
| 契约面结论 | ok()/err() **不可走 orjson**（无空格分隔与 legacy 漂移 58 处，实证后回退）——改提供 `fast_loads()` 供内部解析 |
| 门禁 | build×2 一致 / 五契约 PASS / 锚点 **r51**（1266 符号）/ audit PASS / 桥侧 20 PASS / **pytest 2009 passed / 0 failed / 3 skipped** |

## 1. 启动瓶颈定位（R51-1）

细粒度打点（`HARBOR_PERF_MARKS=1` + boot 内 `Date.now` 计时）：

| 分段 | 耗时 | 说明 |
|---|---|---|
| boot:start → safeStorage-done | 91ms | safeStorage 探测 + dpapi 导入 |
| **safeStorage-done → app-js-imported** | **1215ms** | `import server/src/app.js`（fastify+prisma+全部 service） |
| → buildServer-done | 29ms | fastify 实例构建 |
| → listen-done | 4ms | 端口绑定 |
| → db-schema-ready | 44ms | ensureSchema |
| → window-loaded | ~420ms | BrowserWindow + harbor:// 加载 |

**结论**：app.js 导入是启动瓶颈（1215/1800 = 67%）。修复方向（F2a②）：
延迟 require 非 thead 必需模块（browser driver/mcp/expert 等可推迟到
首次使用），或 V8 code cache（`NODE_COMPILE_CACHE`）。这是独立工程——
本轮定位并留档，不在紧迫窗口内盲拆。

## 2. orjson 序列化层（R51-2）

### 2.1 基准（35KB 典型载荷）

| 操作 | stdlib json | orjson | 加速比 |
|---|---|---|---|
| dumps | 0.033ms | 0.005ms | **6.9x** |
| loads (35KB) | 0.431ms | 0.283ms | **1.5x** |

### 2.2 契约面裁决
ok()/err() 尝试切 orjson → **契约漂移 58 处**（orjson 输出无空格分隔，
`"key": "value"` 变 `"key":"value"`）→ **实证后回退**。js_api 契约面
字节锁定不允许输出格式变更。

### 2.3 落地
- `errors.py` 新增 `fast_loads(data)`：orjson.loads 快路径（1.5x）+
  stdlib 兜底——供**内部大 payload 解析**使用（非契约面）。
- ok()/err() **不改**（保持 legacy 字节兼容——契约红线优先于微优化）。
- `requirements-win.txt` 加 `orjson==3.13.0`（钉版）。
- orjson 已装入系统 Python 与隔离构建 venv。

## 3. 下一批候选（baseline §5 更新）
1. server app.js 延迟 require（需梳理服务依赖图——独立工程）
2. NODE_COMPILE_CACHE（Node 22+ 编译缓存，二次启动提速）
3. orjson fast_loads 逐热路径推广（需 profiling 定位最大 loads 点）
4. hub-catalog 移出主 bundle（harbor:// fetch 外链，主 bundle -31%）

## 4. 交付物索引
| 类别 | 路径 |
|---|---|
| 本报告 | `deliverables/dev-plan/HANDOVER-R51.md` |
| 基线文档（本地） | `outputs/r47-perf/baseline.md`（启动分段更新） |
| 契约锚点 | `deliverables/dev-plan/contract-baseline-r51.json` |
