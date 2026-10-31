# W2 后端迁移中断现场与恢复清单

- 日期：2026-10-26
- 状态：IN PROGRESS / NOT VERIFIED / 禁止作为完成交付
- 原因：software-engineer 执行 W2 时发生 429 调用频率限制，未返回完成报告
- 已完成且不受影响：W1-modern manifest 与241项相关测试；三份PRD/架构文档；既有dist三exe为旧构建，未因本波重新验证

## 实际现场

1. `backend/services/**` 已在工作区标记删除，服务文件已迁入 `backend/domains/{settings,workspace,security,planning,providers,integrations}/**`。
2. 新增 `backend/application/{__init__,session,operation}.py`；新增 `backend/bootstrap.py`；大量 tests/tools/README/spec 引用已修改。
3. `deliverables/wave-backups/W2-modern/manifest.json` 状态仍为 `snapshotted`，post hash 未填，未 complete/verify。
4. 没有工程师 W2 完成报告；不得宣称 W2 通过、全量回归通过或打包通过。

## 已实测阻断

命令：`python -c "import backend.api"`。

结果：ImportError。

```text
backend/domains/integrations/browser/driver.py: from ... import paths
ImportError: cannot import name 'paths' from 'backend.domains'
```

直接原因：迁移后的相对导入层级未全部校正，当前组合根不能加载。

另一项架构偏差：最终统一架构要求唯一组合根为 `backend/bootstrap/__init__.py + backend/bootstrap/container.py`，当前却新增 `backend/bootstrap.py`，且 W2 manifest 仍记录旧形状。不得两种形状并存。

## 恢复时的最小执行顺序

1. 继续同一工程师/新工程师先读本文件、统一架构、W2 manifest 和当前 git diff；保留现场，不重复机械迁移，不整库回退。
2. 将组合根收敛到 `backend/bootstrap/{__init__,container}.py`，同步 `backend/api.py` import 与 W2 新 Wave/补充清单；旧 `bootstrap.py` 只能在内容完整迁移且验证后移除。
3. 以 `backend/domains/integrations/browser/driver.py` 为首个失败点，逐层修正所有相对导入；`backend.domains` 不导出 paths，后端共享基础设施应从 `backend` 顶层正确导入。
4. 运行全量 import/py_compile 和静态旧引用扫描，区分测试 monkeypatch 路径与产品 import，不通过兼容 shim 或放松断言掩盖。
5. 运行代表性浏览器 executor spy、Session/Operation、API/release、现代 build、UI契约、build×2；再做全量回归。全部通过后才能 complete/verify Wave。
6. 在 W2 未完成前禁止 W3/W4/W5、打包和交付声明。

## 保护约束

- 不主动启动 exe，不提交，不 reset/checkout/stash 整库，不删除未跟踪成果。
- 当前旧 `dist/` 仍是此前构建，不能作为当前源码已修复的证据。
- 恢复后优先使用现有断点，不重新复制 services 造成覆盖或第二套实现。

## 恢复进展（本地独立检查）

- `import backend.api` 已为 IMPORT_OK；组合根已是唯一 `backend/bootstrap/{__init__,container}.py`，无平行 bootstrap.py。
- API/release/modern build 38 passed；现代后端架构 8 passed；UI契约PASS，build×2成功。
- 剩余3个测试接缝：`test_v19_browser.py` 旧 `api.SearchService` 私有别名断言；`test_round6_adversarial.py` 两项仍从模板读CSS，须改manifest合并样式。已派工程师做最小修正。
- W2仍未全量通过/未complete，禁止后续Wave与打包。
