# 单域迁移模板（复制本目录到 `src/features/<domain>/` 后逐项打勾）

对应规范 §11.1。**每完成一项就在登记表 `frontend/app/migration-ledger.json` 打勾**。

1. [ ] 读全该域 legacy 模块，列出：依赖的全局符号 / DOM 写点 / `callApi` 目标 / 内联事件 / 测试钉。
2. [ ] `service.js`：所有后端调用经 `services/bridge.js`，错误统一 `HarborError`。
3. [ ] `useFeature.js`：状态经 `state/` 对应 slice + selectors，禁止局部可变全局态。
4. [ ] `Feature.jsx`：React 唯一 DOM 所有者，零 `innerHTML` / `getElementById` / 字符串事件。
5. [ ] 逐条登记 DOM 写点去向（旧写点 → 新 state 字段），不允许"直接删掉"了事。
6. [ ] 旧 vm harness 钉 → 新 L1/L2 钉，逐条写明「为何该钉不再以旧形态存在」（R65 教训）。
7. [ ] 新测试全绿；`arch-contract.mjs` 通过；刷新 `contract-baseline-r<N>.json`。
8. [ ] 从 `frontend/manifest.json` 移除该域条目、删除 `frontend/src/` 源文件。
9. [ ] 跑全套：构建 → UI 契约 → 契约差分 → 棘轮 → 架构门禁 → 运行时验收 → 全量 pytest。
10. [ ] 更新登记表状态为 `migrated`，写交接文档。

**禁止**：以「生产零调用」为删码依据；删除测试而不给理由；跨层反向 import；新增全局符号。
