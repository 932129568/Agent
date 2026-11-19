# 步骤 5/6 物理删除边界清单（v3 · 已执行，执行结果见 §0）
> 2026-11-11 全源码深扫描后修订。v1 只列 186 个删除对象，**漏了 25 个必须同步改造的活动依赖**。

## 0. 执行结果（v3）

**结论（先行）**：本清单已从「**待确认 / 本轮未执行**」转为「**已执行**」。186 个文件（112 个 `backend/**/*.py` + 74 个耦合 pytest）已分批送回收站完成物理删除，Python 契约层退役，Node/Electron 为唯一运行链。（事实）

> 保留声明：下文第 1–5 节（受影响文件总数、两类真问题、具体风险、执行前置条件、186 个文件完整清单、25 个活动依赖路径）为 v2 删除前原文，**全部保留，未删除任何内容**，作为历史边界与回溯依据。其中「待单独确认」「本轮未执行」「必须先改造，不能只删」等均为删除前语义，执行结果以本节为准。

### 0.1 授权链与备份（事实）

| 项 | 内容 |
|---|---|
| 授权链 | 用户「全源码深扫描一遍，肯定存在问题的，然后解决了再删除」→ 深扫描发现 **2 个真问题** → 用户回复「**是**」，明确授权「废弃 pywebview 链 + 重构 25 个活动依赖 + 分批删除 186 文件」 |
| Git 标签 | `git tag r69-pre-deletion` |
| 物理副本 | `C:/Users/陈/Desktop/GLM-Chat-backup-20261111-1414`（**920 文件 / 24 MB**） |
| 冻结快照 | `deliverables/dev-plan/frozen-python-surface.json`，从 `backend/api.py` + `Api()` 运行时冻结：`API_VERSION=v1.0.0`、`APP_VERSION=1.9.0`、`api_py_sha256`、**51** 个公开方法、**116** 个隐身方法、**167** 个方法定义、参数元数表、**9** 个 domains、r68 契约锚点；**删除后为所有门禁的唯一事实源** |

### 0.2 前置改造与删除执行（事实）

- **25 个活动依赖**在删除前全部改造完毕：Node 组 `contract-golden.mjs` / `method-surface.mjs` / `domain-equivalence.mjs` / `arch-contract.mjs` 共 **6 处断言**；Python 组 `tests/conftest.py`（顶层去掉 `backend import` 与 `legacy_main` 加载）、`tests/helpers/state_reset.py`、`tools/contract_diff.py`（三方交叉校验）、`tools/contract_golden_replay.py`（改「重放改快照比对」并如实标注）、`tools/check_release.py`（读冻结值）、`gen_test_disposition.py` / `classify_remaining_pins.py` / `review_all_remaining.py`（改为重放冻结产物）；**9 个非门禁 Python 工具**与 `main.py` / `main_v1.0.0_legacy.py` 改为**明确退役 stub**。完整路径见第 5.3 节。
- `deliverables/dev-plan/deletion-manifest.json` 列 **186 个文件**（112 + 74）。因 PowerShell 的 `Add-Type` 与 COM 被安全策略拦截，改用 Windows 原生 **`SHFileOperationW` + `FOF_ALLOWUNDO`** 送回收站。
- **19 批 × 每批 ≤10 个**，逐批验证无残留；用 `$Recycle.Bin` 的 `$I` 元数据确认原路径记录，**回收站增量 186 与清单一致**；**全程未使用 `rm` / `del`**。

### 0.3 删除后修复、同步与验证（事实）

| 对象 | 删除前 | 删除后 |
|---|---|---|
| `server/test/contract-coverage.mjs` | 读 `backend/api.py` | 改读冻结快照的 `method_defs` / `method_arities` |
| `server/test/contract-signatures.mjs` | 读 `backend/api.py` | 同上 |
| **3 条 pytest 断言** | 「Python 实现不得先删」「第一批不得物理删测试」等删除前语义 | 改为删除后语义 |
| `frontend/app/docs/PYTHON-CONTRACT-EXIT-PLAN.md` | 删除前状态 | 状态更新为「**步骤 5 已执行**」 |

| 项 | 结果（删除后实测） |
|---|---|
| 统一门禁入口 | **12/12 PASS** |
| 架构门禁 `arch-contract.mjs` | **78/78** |
| server 全量 | **35/35 PASS** |
| 契约差分 r68 | **零漂移** |
| 定向 pytest | **29 passed** |
| `main.py` | 输出明确退役提示且 **rc=0** |
| 全量 `pytest tests/ -q` | **475 passed / 2 skipped / 0 failed**（低负载单独复跑，344.71s，rc=0）。此前高负载并发下出现的位置漂移 F 经本次复跑证实为负载偶发、非代码回归；两文件单独复跑 40 passed，收集期 0 errors / 477 tests。其余门禁：统一入口 12/12、arch 78/78、server 35/35、契约差分 r68 零漂移。 |

`§18.x` 为 `ARCHITECTURE-ASSESSMENT-R69.md` §18.7 中全量回归结果的后续回填小节，结果产出前不预填通过数、失败数与耗时。

### 0.4 核心权衡与边界（判断 + 事实）

**删除后无法再用 Python 运行时做逐字节 oracle，改由冻结快照承担**：门禁从「双实现差分」变为「单实现 ↔ 冻结面差分」，冻结快照的生成时机与 `api_py_sha256` 成为新的信任根，须与 git tag、物理副本共同承担可回滚验证。这不是等价替代，而是有代价的移交（判断），不以「零漂移」字样掩盖 oracle 性质的变化。

| 项 | 状态 |
|---|---|
| 推送 | **未推送**（R60 口径） |
| pywebview 桌面链 | **已废弃**，Node/Electron 为唯一运行链 |
| `dist/` 下既有 exe | **未删除** |
| 可恢复性 | 回收站可恢复 + `git tag r69-pre-deletion` 可回滚 |

**⚠️ 此操作非常危险，可能导致不可逆的数据丢失！**

删除对象为项目源码与运行时入口，不是临时文件。按既有资产「只增不删」约定，本轮**未执行任何删除**。

## 1. 受影响文件总数

| 类别 | 数量 |
|---|---|
| `backend/**/*.py`（Python 契约层 / 域服务 / 工具） | 112 |
| 耦合 `import backend` 的 pytest 文件 | 74 |
| **未登记的额外活动依赖（必须先改造，不能只删）** | **25** |
| 合计涉及 | 211 |

## 2. 深扫描发现的两类真问题（均已修复/登记）

1. **Node 隐身方法漏注册**：Python `_V12_EXTRA` 116 项，Node 只注册 114 项，缺 `memory_context_build` / `memory_audit_query`。`contract-golden.mjs` 只校验 51 个公开方法，是长期盲区。已在 `pybridge.js` 补实现、`registry.js` 补注册，并由 `server/test/method-surface.mjs` 静态双向门永久守护（51+116=167 零差集）。
2. **删除方案不完整**：v1 的 186 文件清单漏了下列 25 个活动依赖。其中 `tests/conftest.py` 在 pytest 收集期加载、`main.py` 是 pywebview 应用入口、4 个 Node 门禁与多个工具直接读 `backend/api.py`。直接删除会让全量测试与运行时同时失效。

## 3. 具体风险

1. **契约 oracle 消失**：`tests/test_api_contract.py` 逐字节比对 legacy 与 new，删 Python 后无法再证明零漂移。
2. **pytest 收集期崩溃**：`tests/conftest.py` 与 `tests/helpers/state_reset.py` 仍 `import backend`。
3. **门禁体系失效**：`contract-golden` / `contract-coverage` / `domain-equivalence` / `method-surface` / `contract_diff.py` / `gen_test_disposition.py` 等直接依赖 Python 源码。
4. **运行时入口断裂**：`main.py` / `main_v1.0.0_legacy.py` 是 pywebview 桌面链；`server/src/registry.js` 与 `pybridge.js` 读 `backend/api.py` 做校验。
5. **门禁自相矛盾**：现有 `arch-contract.mjs` 含「不得删除 pytest 文件」断言，删除后立刻判红。

## 4. 执行前置条件（缺一不可）

- 用户**明确、单独**授权删除，并确认 pywebview 降级链一并废弃；
- 先重构第 5.3 节的 25 个活动依赖（改为不依赖 `backend/`），否则删除后不可验证；
- batch4 中 1277 个 `needs-human-review` 钉完成逐条人工复核；
- 冻结 golden 快照、确认 Node 运行时 167 方法等价；
- 完整备份（`git tag` + 工作区副本）并验证可回滚；删除走回收站、每批 ≤10 文件、逐批验证；
- 删除与测试/门禁改造**同一次提交**。

## 5. 全量文件清单

### 5.1 耦合 pytest 文件（74）

- `tests/test_agent_guard_chain.py`
- `tests/test_api_contract.py`
- `tests/test_builtin_experts_import.py`
- `tests/test_collaboration_config.py`
- `tests/test_connect_merge.py`
- `tests/test_expert_package_api.py`
- `tests/test_expert_package_security.py`
- `tests/test_expert_package_service.py`
- `tests/test_freetoken_preset.py`
- `tests/test_glm_1211_rescue.py`
- `tests/test_group_files.py`
- `tests/test_harbor_fix.py`
- `tests/test_history_dir_purge.py`
- `tests/test_local_proxy.py`
- `tests/test_mcp_floor_rules.py`
- `tests/test_memory_db.py`
- `tests/test_memory_panel.py`
- `tests/test_model_prefs.py`
- `tests/test_modern_backend_architecture.py`
- `tests/test_modern_build.py`
- `tests/test_modern_scheduler.py`
- `tests/test_native_ui.py`
- `tests/test_plan_service.py`
- `tests/test_prompts_w0.py`
- `tests/test_qa_builtin_body_not_duplicated.py`
- `tests/test_r40_k10.py`
- `tests/test_r41_registry_pipe.py`
- `tests/test_r42_notes.py`
- `tests/test_r43_snapshot.py`
- `tests/test_r44_injection.py`
- `tests/test_r44_mcp_fold.py`
- `tests/test_r46_final.py`
- `tests/test_r48_scanfix.py`
- `tests/test_r49_scanfix.py`
- `tests/test_r56_concurrency.py`
- `tests/test_r57_conflicts.py`
- `tests/test_r59_deps.py`
- `tests/test_release_discipline.py`
- `tests/test_review_batch2.py`
- `tests/test_review_fixes.py`
- `tests/test_round6_adversarial.py`
- `tests/test_sandbox.py`
- `tests/test_security_fixes.py`
- `tests/test_t9_sandbox_smoke.py`
- `tests/test_tool_validator.py`
- `tests/test_v12_features.py`
- `tests/test_v13_mcp.py`
- `tests/test_v13_qa.py`
- `tests/test_v14_experience.py`
- `tests/test_v15_known_bugs.py`
- `tests/test_v15_reserved.py`
- `tests/test_v15_wire.py`
- `tests/test_v16_batch1.py`
- `tests/test_v16_batch2.py`
- `tests/test_v16_github_catalog.py`
- `tests/test_v16_leftover.py`
- `tests/test_v18_search_adapters.py`
- `tests/test_v18_search_service.py`
- `tests/test_v18_software_hybrid.py`
- `tests/test_v18_tools_wiring.py`
- `tests/test_v19_browser.py`
- `tests/test_v19_checkpoint.py`
- `tests/test_v19_driver.py`
- `tests/test_v19_gate.py`
- `tests/test_v19_mac.py`
- `tests/test_v19_mcp_reverify.py`
- `tests/test_v19_paths.py`
- `tests/test_v19_prompts.py`
- `tests/test_v19_reader.py`
- `tests/test_v19_search_upgrade.py`
- `tests/test_v19_wiring.py`
- `tests/test_w11_memory_f1_reflect.py`
- `tests/test_w1_trace_w2_readiness.py`
- `tests/test_w6p1_parallel_gate.py`

### 5.2 Python 实现文件（112）

- `backend/__init__.py`
- `backend/api.py`
- `backend/application/__init__.py`
- `backend/application/native_ui.py`
- `backend/application/operation.py`
- `backend/application/registry.py`
- `backend/application/scheduler.py`
- `backend/application/session.py`
- `backend/application/task.py`
- `backend/bootstrap/__init__.py`
- `backend/bootstrap/container.py`
- `backend/domains/__init__.py`
- `backend/domains/expert/__init__.py`
- `backend/domains/expert/builtin_importer.py`
- `backend/domains/expert/frontmatter.py`
- `backend/domains/expert/jsonio.py`
- `backend/domains/expert/model.py`
- `backend/domains/expert/package.py`
- `backend/domains/expert/service.py`
- `backend/domains/expert/validator.py`
- `backend/domains/integrations/__init__.py`
- `backend/domains/integrations/browser/__init__.py`
- `backend/domains/integrations/browser/adapters.py`
- `backend/domains/integrations/browser/driver.py`
- `backend/domains/integrations/browser/extract.py`
- `backend/domains/integrations/browser/native_port.py`
- `backend/domains/integrations/browser/platform/__init__.py`
- `backend/domains/integrations/browser/platform/base.py`
- `backend/domains/integrations/browser/platform/mac.py`
- `backend/domains/integrations/browser/platform/win.py`
- `backend/domains/integrations/browser/service.py`
- `backend/domains/integrations/browser/session_base.py`
- `backend/domains/integrations/browser/session_headless.py`
- `backend/domains/integrations/browser/session_mac.py`
- `backend/domains/integrations/browser/session_win.py`
- `backend/domains/integrations/browser/snapshot.py`
- `backend/domains/integrations/browser/win_capture.py`
- `backend/domains/integrations/mcp/__init__.py`
- `backend/domains/integrations/mcp/mcp_client.py`
- `backend/domains/integrations/mcp/mcp_config_service.py`
- `backend/domains/integrations/mcp/mcp_dpapi.py`
- `backend/domains/integrations/mcp/mcp_pool.py`
- `backend/domains/integrations/mcp/mcp_service.py`
- `backend/domains/integrations/mcp/mcp_transport_http.py`
- `backend/domains/integrations/mcp/mcp_transport_stdio.py`
- `backend/domains/integrations/software_service.py`
- `backend/domains/integrations/update_service.py`
- `backend/domains/integrations/webdav_service.py`
- `backend/domains/memory/__init__.py`
- `backend/domains/memory/db_service.py`
- `backend/domains/observability/__init__.py`
- `backend/domains/observability/trace_service.py`
- `backend/domains/planning/__init__.py`
- `backend/domains/planning/checkpoint_service.py`
- `backend/domains/planning/plan_service.py`
- `backend/domains/planning/repository.py`
- `backend/domains/providers/__init__.py`
- `backend/domains/providers/hybrid_router.py`
- `backend/domains/providers/local_model_service.py`
- `backend/domains/providers/local_proxy.py`
- `backend/domains/providers/prompt_loader.py`
- `backend/domains/providers/provenance.py`
- `backend/domains/providers/provider_service.py`
- `backend/domains/providers/search_reader.py`
- `backend/domains/security/__init__.py`
- `backend/domains/security/audit_chain.py`
- `backend/domains/security/guard_service.py`
- `backend/domains/security/tool_validator.py`
- `backend/domains/settings/__init__.py`
- `backend/domains/settings/config_service.py`
- `backend/domains/settings/memory_service.py`
- `backend/domains/settings/model_prefs_service.py`
- `backend/domains/workspace/__init__.py`
- `backend/domains/workspace/clipboard_service.py`
- `backend/domains/workspace/cmd_service.py`
- `backend/domains/workspace/file_service.py`
- `backend/domains/workspace/group_files_service.py`
- `backend/domains/workspace/notes_service.py`
- `backend/domains/workspace/process_service.py`
- `backend/domains/workspace/sandbox_service.py`
- `backend/domains/workspace/screenshot_service.py`
- `backend/domains/workspace/toolcache_service.py`
- `backend/domains/workspace/workspace_service.py`
- `backend/errors.py`
- `backend/experts_builtin/qa-testing/skills/qa-testing-cn/scripts/calculate_metrics.py`
- `backend/experts_builtin/qa-testing/skills/qa-testing-cn/scripts/init_qa_project.py`
- `backend/experts_builtin/senior-developer/skills/frontend-dev/scripts/minimax_image.py`
- `backend/experts_builtin/senior-developer/skills/frontend-dev/scripts/minimax_music.py`
- `backend/experts_builtin/senior-developer/skills/frontend-dev/scripts/minimax_tts.py`
- `backend/experts_builtin/senior-developer/skills/frontend-dev/scripts/minimax_video.py`
- `backend/experts_builtin/valorant-perler-expert/skills/perler-repair/scripts/repair.py`
- `backend/experts_builtin/valorant-perler-expert/skills/valorant-perler/scripts/alignment_search.py`
- `backend/experts_builtin/valorant-perler-expert/skills/valorant-perler/scripts/build_html_blueprint.py`
- `backend/experts_builtin/valorant-perler-expert/skills/valorant-perler/scripts/direct_pixelize.py`
- `backend/experts_builtin/valorant-perler-expert/skills/valorant-perler/scripts/gen_and_recover.py`
- `backend/experts_builtin/valorant-perler-expert/skills/valorant-perler/scripts/grid_recover.py`
- `backend/experts_builtin/valorant-perler-expert/skills/valorant-perler/scripts/image_render.py`
- `backend/experts_builtin/valorant-perler-expert/skills/valorant-perler/scripts/image_to_perler.py`
- `backend/experts_builtin/valorant-perler-expert/skills/valorant-perler/scripts/login.py`
- `backend/experts_builtin/valorant-perler-expert/skills/valorant-perler/scripts/make_overview.py`
- `backend/experts_builtin/valorant-perler-expert/skills/valorant-perler/scripts/quantize_vote.py`
- `backend/experts_builtin/valorant-perler-expert/skills/valorant-perler/scripts/val_perler/__init__.py`
- `backend/experts_builtin/valorant-perler-expert/skills/valorant-perler/scripts/val_perler/__main__.py`
- `backend/experts_builtin/valorant-perler-expert/skills/valorant-perler/scripts/val_perler/cli.py`
- `backend/experts_builtin/valorant-perler-expert/skills/valorant-perler/scripts/val_perler/guard.py`
- `backend/experts_builtin/valorant-perler-expert/skills/valorant-perler/scripts/val_perler/names.py`
- `backend/experts_builtin/valorant-perler-expert/skills/valorant-perler/scripts/val_perler.py`
- `backend/fio.py`
- `backend/logging_setup.py`
- `backend/paths.py`
- `backend/runtime.py`
- `backend/tools_schema.py`

### 5.3 必须先改造的额外活动依赖（25，v2 新增）

- `deliverables/design/make_preview.py`
- `deliverables/design/make_preview_v3.py`
- `frontend/app/src/services/bridge.js`
- `frontend/app/tests/arch-contract.mjs`
- `main.py`
- `server/src/registry.js`
- `server/src/services/pybridge.js`
- `server/test/contract-coverage.mjs`
- `server/test/contract-golden.mjs`
- `server/test/domain-equivalence.mjs`
- `server/test/method-surface.mjs`
- `tests/conftest.py`
- `tests/helpers/state_reset.py`
- `tools/check_release.py`
- `tools/classify_remaining_pins.py`
- `tools/contract_diff.py`
- `tools/diag/state_probe.py`
- `tools/diff/extract_rpc_defaults.py`
- `tools/diff/python_driver.py`
- `tools/gen_api_reference.py`
- `tools/gen_test_disposition.py`
- `tools/perf_benchmark.py`
- `tools/perf_w6p1.py`
- `tools/review_all_remaining.py`
- `tools/verify-dpapi-interop.mjs`
