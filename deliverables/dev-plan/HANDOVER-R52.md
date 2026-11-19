# Harbor R52 轮报告（2026-11-07）——性能优化实施第二批

> 接续 R51：R47 baseline §5 候选实施。两项探索一项落地一项回退（教训留档）。

---

## 0. 一眼看全局

| 项 | 数值 |
|---|---|
| 落地 | NODE_COMPILE_CACHE 注入点（Electron 嵌入 Node 实测未生效——留档）· hub-catalog 外链原型（尝试后回退——测试基建波及面过大，JSON 文件已备好供后续） |
| 门禁 | build×2 一致 / 五契约 PASS / 锚点 **r51 保持** / audit PASS / 桥侧 20 PASS / **pytest 2009 passed / 0 failed / 3 skipped** |

## 1. NODE_COMPILE_CACHE（F2a⑥）

**实现**：`injectEnv()` 注入 `NODE_COMPILE_CACHE=<CONFIG_DIR>/compile_cache`——
V8 编译缓存持久化。理论：二次启动跳过 ESM 编译直接反序列化。

**实测**：三连启动对比（冷/热/热）——**时序无差异**（app-js-imported 均
~1100ms），缓存目录 0 文件。**结论：Electron 嵌入式 Node 不支持
NODE_COMPILE_CACHE 的运行时注入**（需进程启动前设置——安装器/快捷方式
层面可行，代码内注入无效）。代码保留（未来 Electron 版本可能支持）。

## 2. hub-catalog 外链（F2a④ 最终形态——尝试后回退）

**目标**：主 HTML 3.87→2.6MB（-31%）——市场快照数据从嵌入字符串移到
`libs/hub-catalog.json` 外链 + harbor:// 协议 fetch。

**实施**：
- `libs/hub-catalog.json` 已写入（1.9MB pretty-printed，394 专家完整）✓
- hub-catalog.js 改写为 fetch 预加载 + 同步缓存访问器 ✓
- 协议白名单 + MIME application/json ✓
- manifest provides 更新 ✓

**回退原因**：hub 测试套件（r32/r34/r35 共 12 测试）全部基于「嵌入 JSON
字符串解析源码」或「vm 内 hubCatalog() 同步调用」的假设——外链后需重写
全部 vm 基建（preload 注入/断言目标排除/跨模块符号前置）。波及面远超
单轮范围，**回退待独立测试基建轮**。`libs/hub-catalog.json` 已入库
（下次实施直接用）。

## 3. R51 项确认
- orjson fast_loads 已入 errors.py（内部解析快路径，非契约面）✓
- 启动打点 marks 正常 ✓
- hub-catalog R47 懒加载验证 ✓

## 4. 剩余性能候选（更新后）
1. **server app.js 延迟 require**（需服务依赖图梳理——独立工程）
2. **hub-catalog 外链**（JSON 已备，需 vm 测试基建更新轮）
3. fast_loads 热路径推广（需 profiling 定位最大 loads 点）

## 5. 交付物索引
| 类别 | 路径 |
|---|---|
| 本报告 | `deliverables/dev-plan/HANDOVER-R52.md` |
| 外链 JSON（已入库备用） | `libs/hub-catalog.json` |
