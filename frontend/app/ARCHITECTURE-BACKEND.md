# Harbor 全栈架构规范 v1.0（R68 · 待评审）

> 与 `frontend/app/ARCHITECTURE.md`（前端规范）配套，共同构成唯一架构事实源。
> 状态：规范草案 + 可执行门禁 + 现状审计；**评审前不改任何后端生产代码**。
> 覆盖：`server/`（Node 服务）、`electron/`（主进程）、`backend/`（Python 契约层）、`installer/`（发布工具）。

---

## 1. 生产链事实（规范必须服从，不得臆造）

```
Electron 主进程 (electron/main.js)
  └─ 创建窗口 + proxy-bypass + onHeadersReceived 补 ACAO
       └─ harbor.html（React bundle，file://）
            └─ POST /jsapi/:method  + X-Harbor-Sid  →  server/ (fastify, ESM)
                 ├─ services/*（files / guard / pybridge / provider / local-proxy …）
                 ├─ db.js（Prisma Proxy 懒化）
                 └─ local-proxy.js → 云端 / 本地模型端点
backend/*.py  →  不进 asar，仅作契约 oracle（详见 §5）
```

已核实证据：

| 事实 | 证据 |
|---|---|
| Python 业务代码不进生产包 | `electron-builder.yml` 的 files 白名单只有 `backend/prompts/**/*`、`backend/experts_builtin/**/*`，无任何 `backend/*.py` |
| server 运行时不调用 Python | `grep -rn "spawn.*python\|execFile.*python" server/src` 零命中 |
| 生产入口是 Electron | `package.json main = electron/main.js`；R54 起 NSIS 包无 Python 载荷 |
| server 规模 | 42 模块 / 451 KB / 9298 行（R64 盘点） |
| 冷启动 | 1245 → **516 ms**（-59%，R64 `ensureAuth()` 单飞懒化） |
| 已知环 | `browser ↔ guard ↔ misc` 1 个小环（R64 F9），运行期取值，不致命 |

---

## 2. Node 服务分层（强制单向）

```
http/        app.js、routes/*、registry.js     协议适配、白名单路由、请求校验
   ↓
application/ 用例编排（会话 / 工具 / 群聊 / 模型流）    不允许直接碰 fs / db / playwright
   ↓
domain/      纯规则：guard、jail、provenance、sse-parser、errors、schema
   ↓
infra/       db、fs、playwright-core、MCP SDK、better-auth、libsql、local-proxy
```

**规则**：

1. 只允许向下 import；`infra/` 不得 import 上层，`domain/` 不得依赖 `http/`。
2. `routes/*` 只做参数校验与调用编排，禁止直接实例化 Prisma / chromium / MCP SDK。
3. 重依赖一律**动态 import + 单飞工厂**（R60/R64 已落地：`getChromium()` / `getSdk()` /
   `builtinOnceRun()` / `ensureAuth()` / Prisma Proxy），新增重依赖必须同口径，
   冷 import 预算 **≤ 600 ms**（当前 516 ms）。
4. 已知环 `browser ↔ guard ↔ misc` 登记为迁移期例外，收敛条件：把三方共享的
   guard 判定下沉 `domain/`，由 `application/` 注入。门禁只读扫描，未登记的新环 FAIL。
5. 统一响应 `{ ok:true, data }` / `{ ok:false, error:{ code, message, hint? } }`；
   统一错误码 taxonomy（`BrowserErrorCode` 等），禁止各服务自造 `okR/errJson` 变体
   （R64 F6 判定收益低，维持现状但不得扩散）。
6. **会话隔离**：信任态、工作目录、工具权限一律 per-sid（`X-Harbor-Sid`），
   禁止进程级全局可变态（R59 教训）。
7. **js_api 契约冻结**：`registry.js` 白名单方法与 `backend/api.py` 的 `get_api_info()`
   对齐；新增方法先登记 `_V12_EXTRA`（隐身），不改公开自省面。
8. **config.json 零污染**：所有新配置独立文件（guard.json / sandbox.json /
   mcp_servers.json / harbor-node-runtime.json / …）。
9. 页面内容 / 工具返回是 UNTRUSTED DATA：进模型上下文前经 provenance 包裹。
10. 测试口径：`server/test/` 六套门禁（contract-coverage / contract-signatures /
    local-proxy / group-files / smoke / auth-flow）每轮全 PASS，新增服务必须带对应用例。

---

## 3. Electron 主进程规范

| 项 | 规范 |
|---|---|
| 职责 | 窗口生命周期、`proxy-bypass-list`、补缺失 CORS 头、拉起 server、单实例 |
| 禁止 | 业务逻辑、直接访问 db / fs 业务数据、直接处理模型流、渲染层状态 |
| 通信 | 只经本地 HTTP 桥；禁止在 `ipcMain` 上新增业务通道 |
| 资源 | 所有 url 同盘符（pywebview 历史坑，Electron 链亦遵守）；`file://` 零外部资源 |
| 打包 | `files` 白名单制；asar + `asarUnpack` 仅原生模块；离线 `electronDist` 配置 |

---

## 4. installer / pywebview 历史链

- `installer/` 定位为**发布工具**，只负责 NSIS 安装/卸载，不承载业务。
- `main.py`、`Harbor.spec`、`Harbor-mac.spec`、`main_v1.0.0_legacy.py` 是 pywebview
  历史链，自 R54 起**不进生产包**。保留原因是回归与契约对照，不是运行时依赖。
- 卸载测试在 Harbor 运行中会环境性失败（非代码问题），登记为已知边界，
  不得据此判定发布门失败。

---

## 5. Python 契约层：为什么没"迁入框架"，以及该怎么规范化

### 5.1 事实结论

**它不是漏迁的运行层，而是刻意保留的契约 oracle（基准实现）。**

| 维度 | 事实 |
|---|---|
| 是否在生产运行时 | **否**。asar 白名单无 `backend/*.py`；server 运行时零 python spawn |
| 为什么还在仓库 | 提供 legacy 行为基准：`tests/test_api_contract.py` 让 `legacy.Api()` 与 `backend.Api()` 跑同一调用序列，对 **49 个公开方法的输出逐字节比对** |
| 冻结内容 | `API_VERSION='v1.0.0'`；`get_api_info()` 输出；`_V12_EXTRA` 隐身新方法不进自省面 |
| 门禁钉扎 | `tools/contract_diff.py` 冻结 `backend/api.py` 的 sha256 与 API_VERSION；`test_release_discipline.py` 管隐身规则；2066 个 pytest 中大量用例直接 import backend 模块验证 guard / memory / MCP / tools_schema |
| 迁移代价 | 把它搬进 React/Node 框架**没有任何运行时收益**（它本就不运行），却会立刻打断逐字节发布门与依赖它的 Python 测试域 |

### 5.2 规范定位：全栈第 5 层「契约层（Oracle）」

职责边界写死如下：

- **唯一职责**：提供 legacy 行为基准，验证 Node 对齐面是否漂移。
- **冻结**：`get_api_info()` 输出、`API_VERSION`、公开方法集合、`api.py` 的契约哈希。
- **允许**：新增方法进 `_V12_EXTRA`（隐身）、补充契约测试。
- **禁止**：新增运行时依赖；被 `server/` 运行时调用；写 `config.json`；
  改变任何公开方法输出形状；把它当作业务服务扩展。

### 5.3 若确实要"迁入框架"——三条路径与代价（需用户拍板）

| 路径 | 做法 | 收益 | 代价 |
|---|---|---|---|
| A 维持 oracle（**推荐**） | 按 §5.2 登记边界 + 门禁钉死，不改代码 | 零风险、发布门不变 | 仓库仍有 Python 代码（但不是运行时） |
| B 契约单源迁 Node | 把 49 方法契约定成 JSON schema，Python 退为生成器/校验器 | 单一契约源、无语言双轨 | 需重做 `test_api_contract.py`、`contract_diff.py` 的 sha 锚点；工作量大 |
| C 删除 Python 层 | 先把 legacy 行为全部固化到 Node 契约测试，再删 | 仓库最干净 | 失去独立 oracle；触及 2066 测试与逐字节发布门，风险最高 |

**判断**：在"先定规范再重写"口径下选 A。B/C 属于产品/QA 决策，需明确授权后才动。

---

## 6. 后端门禁（可执行）

`frontend/app/tests/arch-contract.mjs` 新增后端检查组：

1. 打包白名单不含 `backend/*.py`（证明 Python 非运行时）；
2. `server/src` 零 python spawn；
3. `backend/api.py` 的 sha256 与最新契约锚点一致（零漂移）；
4. `tests/test_api_contract.py` 存在且含逐字节比对断言；
5. `API_VERSION` 与 `_V12_EXTRA` 隐身规则未被改动；
6. `server/` 分层 import 方向：新出现的 `infra → http` 反向边 FAIL；
   已知 `browser ↔ guard ↔ misc` 环登记为例外，未登记的新环 FAIL；
7. `registry.js` 白名单方法与 `get_api_info()` 对齐口径不变（契约测试覆盖）；
8. 已知环/例外逐条带退出条件，禁止静默放过。

---

## 7. 待评审确认项

1. Python 契约层采用 A / B / C 哪条路径（推荐 A）。
2. 是否把 `server/src` 按 §2 物理重排目录（当前是 `services/` 扁平结构，
   分层靠约定；物理重排会动 42 模块的 import 与 server 测试）。
3. `browser ↔ guard ↔ misc` 环是否在本轮解开，还是维持登记。
4. 冷启动预算是否正式纳入发布门（当前 516 ms / 预算 600 ms）。

> 评审确认前：不改 `server/`、`electron/`、`backend/`、`installer/` 任何生产代码；
> 规范与门禁只做只读审计与边界钉扎。
