# Harbor v1.9.0 (R97) 源码全量清单

> 生成时间：2026-11-18　口径：排除 `node_modules` / `dist*` / `.git` / `__pycache__`。
> 本文件是交接文档的附件，逐文件给出路径与行数；仓库根 = 项目根。

**合计：447 文件 / 91125 行**

## frontend/src — 117 文件 / 26896 行

> 前端逻辑层（单文件应用的源码树，构建时按依赖序拼接进 harbor.html）

| # | 文件 | 行数 |
|---|---|---|
| 1 | `frontend/src/agent/budget.js` | 142 |
| 2 | `frontend/src/agent/compact-command.js` | 279 |
| 3 | `frontend/src/agent/compaction.js` | 80 |
| 4 | `frontend/src/agent/context-freeze.js` | 65 |
| 5 | `frontend/src/agent/context.js` | 132 |
| 6 | `frontend/src/agent/guard.js` | 350 |
| 7 | `frontend/src/agent/model-executor.js` | 136 |
| 8 | `frontend/src/agent/request-builder.js` | 33 |
| 9 | `frontend/src/agent/resume.js` | 220 |
| 10 | `frontend/src/agent/router.js` | 82 |
| 11 | `frontend/src/agent/run-controller-base.js` | 109 |
| 12 | `frontend/src/agent/run-controller-utils.js` | 61 |
| 13 | `frontend/src/agent/run-controller.js` | 1364 |
| 14 | `frontend/src/agent/run-registry.js` | 132 |
| 15 | `frontend/src/agent/sse-parser.js` | 74 |
| 16 | `frontend/src/agent/text-compress.js` | 98 |
| 17 | `frontend/src/agent/tool-executor.js` | 567 |
| 18 | `frontend/src/agent/tool-runtime.js` | 37 |
| 19 | `frontend/src/analytics/cost.js` | 158 |
| 20 | `frontend/src/analytics/expert.js` | 50 |
| 21 | `frontend/src/analytics/panel.js` | 307 |
| 22 | `frontend/src/analytics/tokens.js` | 177 |
| 23 | `frontend/src/chat/attachments.js` | 286 |
| 24 | `frontend/src/chat/composer.js` | 318 |
| 25 | `frontend/src/chat/navigation.js` | 149 |
| 26 | `frontend/src/chat/screenshot.js` | 43 |
| 27 | `frontend/src/chat/send.js` | 493 |
| 28 | `frontend/src/collaboration/budget.js` | 96 |
| 29 | `frontend/src/collaboration/config.js` | 48 |
| 30 | `frontend/src/collaboration/controller.js` | 253 |
| 31 | `frontend/src/collaboration/endpoint.js` | 121 |
| 32 | `frontend/src/collaboration/plan.js` | 80 |
| 33 | `frontend/src/collaboration/privacy.js` | 44 |
| 34 | `frontend/src/collaboration/recovery.js` | 87 |
| 35 | `frontend/src/collaboration/router.js` | 39 |
| 36 | `frontend/src/collaboration/schemas.js` | 149 |
| 37 | `frontend/src/collaboration/timeline.js` | 85 |
| 38 | `frontend/src/collaboration/ui.js` | 194 |
| 39 | `frontend/src/components/context-menu.js` | 88 |
| 40 | `frontend/src/components/markdown.js` | 432 |
| 41 | `frontend/src/components/overlays.js` | 374 |
| 42 | `frontend/src/components/select.js` | 121 |
| 43 | `frontend/src/core/app-state.js` | 30 |
| 44 | `frontend/src/core/bootstrap.js` | 306 |
| 45 | `frontend/src/core/bridge.js` | 93 |
| 46 | `frontend/src/core/motion.js` | 62 |
| 47 | `frontend/src/core/state.js` | 50 |
| 48 | `frontend/src/core/tokens-est.js` | 95 |
| 49 | `frontend/src/core/utils.js` | 229 |
| 50 | `frontend/src/expert/center.js` | 341 |
| 51 | `frontend/src/expert/context.js` | 130 |
| 52 | `frontend/src/expert/controller.js` | 216 |
| 53 | `frontend/src/expert/events.js` | 59 |
| 54 | `frontend/src/expert/mailbox.js` | 35 |
| 55 | `frontend/src/expert/orchestrator.js` | 278 |
| 56 | `frontend/src/expert/package-store.js` | 50 |
| 57 | `frontend/src/expert/projection.js` | 18 |
| 58 | `frontend/src/expert/recovery.js` | 35 |
| 59 | `frontend/src/expert/schemas.js` | 98 |
| 60 | `frontend/src/expert/timeline.js` | 97 |
| 61 | `frontend/src/generative/actions.js` | 104 |
| 62 | `frontend/src/generative/artifact.js` | 192 |
| 63 | `frontend/src/generative/chat-auto.js` | 750 |
| 64 | `frontend/src/generative/controller.js` | 325 |
| 65 | `frontend/src/generative/data-ref.js` | 304 |
| 66 | `frontend/src/generative/fixtures.js` | 178 |
| 67 | `frontend/src/generative/projection.js` | 206 |
| 68 | `frontend/src/generative/registry.js` | 474 |
| 69 | `frontend/src/generative/schemas.js` | 101 |
| 70 | `frontend/src/generative/settings.js` | 74 |
| 71 | `frontend/src/generative/state.js` | 158 |
| 72 | `frontend/src/group/endpoints.js` | 123 |
| 73 | `frontend/src/group/files.js` | 365 |
| 74 | `frontend/src/group/group.js` | 1527 |
| 75 | `frontend/src/group/mention.js` | 194 |
| 76 | `frontend/src/integrations/browser-driver.js` | 246 |
| 77 | `frontend/src/integrations/mcp-exec.js` | 133 |
| 78 | `frontend/src/integrations/mcp-panel.js` | 814 |
| 79 | `frontend/src/integrations/software.js` | 473 |
| 80 | `frontend/src/planning/card.js` | 691 |
| 81 | `frontend/src/planning/checkpoints.js` | 98 |
| 82 | `frontend/src/providers/hybrid.js` | 423 |
| 83 | `frontend/src/providers/provider.js` | 147 |
| 84 | `frontend/src/providers/request.js` | 225 |
| 85 | `frontend/src/search/panel-state.js` | 55 |
| 86 | `frontend/src/search/panel.js` | 553 |
| 87 | `frontend/src/sessions/controller-base.js` | 546 |
| 88 | `frontend/src/sessions/controller-meta.js` | 11 |
| 89 | `frontend/src/sessions/controller.js` | 782 |
| 90 | `frontend/src/sessions/search.js` | 163 |
| 91 | `frontend/src/sessions/store-api.js` | 9 |
| 92 | `frontend/src/sessions/store.js` | 373 |
| 93 | `frontend/src/settings/connection-base.js` | 298 |
| 94 | `frontend/src/settings/connection-presets.js` | 223 |
| 95 | `frontend/src/settings/connection.js` | 498 |
| 96 | `frontend/src/settings/features.js` | 137 |
| 97 | `frontend/src/settings/local-model.js` | 382 |
| 98 | `frontend/src/settings/memory.js` | 575 |
| 99 | `frontend/src/settings/navigation.js` | 134 |
| 100 | `frontend/src/settings/sandbox.js` | 177 |
| 101 | `frontend/src/settings/store.js` | 95 |
| 102 | `frontend/src/settings/update.js` | 113 |
| 103 | `frontend/src/settings/webdav.js` | 204 |
| 104 | `frontend/src/shell/audit.js` | 160 |
| 105 | `frontend/src/shell/composer-hub.js` | 424 |
| 106 | `frontend/src/shell/grants.js` | 453 |
| 107 | `frontend/src/shell/hub-catalog.js` | 83 |
| 108 | `frontend/src/shell/hub-connector.js` | 189 |
| 109 | `frontend/src/shell/hub-market.js` | 413 |
| 110 | `frontend/src/shell/island-host.js` | 70 |
| 111 | `frontend/src/shell/navigation.js` | 294 |
| 112 | `frontend/src/shell/onboarding.js` | 282 |
| 113 | `frontend/src/shell/panels.js` | 70 |
| 114 | `frontend/src/shell/platform.js` | 92 |
| 115 | `frontend/src/shell/shortcuts.js` | 91 |
| 116 | `frontend/src/shell/theme.js` | 29 |
| 117 | `frontend/src/workspace/quick.js` | 218 |

## frontend/styles — 14 文件 / 4995 行

> 样式层（14 个 CSS 按 frontend/manifest.json 顺序内联）

| # | 文件 | 行数 |
|---|---|---|
| 1 | `frontend/styles/base.css` | 21 |
| 2 | `frontend/styles/components.css` | 149 |
| 3 | `frontend/styles/features/chat.css` | 524 |
| 4 | `frontend/styles/features/collaboration.css` | 21 |
| 5 | `frontend/styles/features/expert.css` | 64 |
| 6 | `frontend/styles/features/generative.css` | 230 |
| 7 | `frontend/styles/features/mcp.css` | 30 |
| 8 | `frontend/styles/features/memory.css` | 23 |
| 9 | `frontend/styles/features/overlays.css` | 32 |
| 10 | `frontend/styles/features/plan.css` | 53 |
| 11 | `frontend/styles/legacy.css` | 2993 |
| 12 | `frontend/styles/responsive.css` | 682 |
| 13 | `frontend/styles/shell.css` | 84 |
| 14 | `frontend/styles/tokens.css` | 89 |

## frontend/react — 23 文件 / 4876 行

> React 岛（构建为 iife，供壳内局部挂载；generated/ 为模板自动生成）

| # | 文件 | 行数 |
|---|---|---|
| 1 | `frontend/react/build.mjs` | 36 |
| 2 | `frontend/react/dist/harbor-island.iife.js` | 308 |
| 3 | `frontend/react/package-lock.json` | 534 |
| 4 | `frontend/react/package.json` | 24 |
| 5 | `frontend/react/src/AgentProcessPanel.jsx` | 98 |
| 6 | `frontend/react/src/ParallelRuns.jsx` | 50 |
| 7 | `frontend/react/src/SessionHistory.jsx` | 230 |
| 8 | `frontend/react/src/generated/App.jsx` | 34 |
| 9 | `frontend/react/src/generated/AuroraBg.jsx` | 15 |
| 10 | `frontend/react/src/generated/ExpertCenter.jsx` | 47 |
| 11 | `frontend/react/src/generated/HubMarket.jsx` | 76 |
| 12 | `frontend/react/src/generated/IconDefs.jsx` | 146 |
| 13 | `frontend/react/src/generated/MainShell.jsx` | 1627 |
| 14 | `frontend/react/src/generated/ProjectModal.jsx` | 50 |
| 15 | `frontend/react/src/generated/Rail.jsx` | 117 |
| 16 | `frontend/react/src/generated/Sidebar.jsx` | 54 |
| 17 | `frontend/react/src/generated/SidebarBackdrop.jsx` | 11 |
| 18 | `frontend/react/src/generated/StreamBar.jsx` | 11 |
| 19 | `frontend/react/src/generated/ids.json` | 640 |
| 20 | `frontend/react/src/index.jsx` | 206 |
| 21 | `frontend/react/src/island.css` | 208 |
| 22 | `frontend/react/src/store.js` | 85 |
| 23 | `frontend/react/tools/html-to-jsx.mjs` | 269 |

## server/src — 46 文件 / 11460 行

> Node 服务层（js_api 实现 51 公开 / 117 隐身方法 + Electron 侧后端）

| # | 文件 | 行数 |
|---|---|---|
| 1 | `server/src/app.js` | 82 |
| 2 | `server/src/auth.js` | 59 |
| 3 | `server/src/cli/migrate-legacy.mjs` | 38 |
| 4 | `server/src/config.js` | 44 |
| 5 | `server/src/db.js` | 145 |
| 6 | `server/src/host.js` | 55 |
| 7 | `server/src/index.js` | 53 |
| 8 | `server/src/logger.js` | 43 |
| 9 | `server/src/paths.js` | 130 |
| 10 | `server/src/registry.js` | 545 |
| 11 | `server/src/routes/auth.js` | 38 |
| 12 | `server/src/routes/jsapi.js` | 120 |
| 13 | `server/src/routes/storage-status.js` | 33 |
| 14 | `server/src/runtime.js` | 85 |
| 15 | `server/src/services/browser-agent.js` | 188 |
| 16 | `server/src/services/browser.js` | 499 |
| 17 | `server/src/services/commands.js` | 342 |
| 18 | `server/src/services/config-specs.js` | 203 |
| 19 | `server/src/services/config.js` | 43 |
| 20 | `server/src/services/dpapi-migrate.js` | 107 |
| 21 | `server/src/services/dpapi.js` | 270 |
| 22 | `server/src/services/expert-builtin.js` | 392 |
| 23 | `server/src/services/experts.js` | 477 |
| 24 | `server/src/services/files.js` | 419 |
| 25 | `server/src/services/guard.js` | 728 |
| 26 | `server/src/services/harness/executionGuardrails.mjs` | 543 |
| 27 | `server/src/services/harness/progressiveToolRegistry.mjs` | 282 |
| 28 | `server/src/services/harness/providerBridge.mjs` | 134 |
| 29 | `server/src/services/jail.js` | 60 |
| 30 | `server/src/services/jsonstore.js` | 154 |
| 31 | `server/src/services/local-proxy.js` | 284 |
| 32 | `server/src/services/mcp.js` | 361 |
| 33 | `server/src/services/memory.js` | 197 |
| 34 | `server/src/services/misc.js` | 286 |
| 35 | `server/src/services/plans.js` | 300 |
| 36 | `server/src/services/provider.js` | 671 |
| 37 | `server/src/services/pybridge.js` | 991 |
| 38 | `server/src/services/session-migrate.js` | 198 |
| 39 | `server/src/services/sessions.js` | 106 |
| 40 | `server/src/services/software.js` | 399 |
| 41 | `server/src/services/system.js` | 408 |
| 42 | `server/src/services/update.js` | 196 |
| 43 | `server/src/services/webdav.js` | 290 |
| 44 | `server/src/services/worklog.js` | 58 |
| 45 | `server/src/services/workspace.js` | 273 |
| 46 | `server/src/session-context.js` | 131 |

## electron — 4 文件 / 1161 行

> Electron 主进程 / preload / 壁纸合成

| # | 文件 | 行数 |
|---|---|---|
| 1 | `electron/main.js` | 589 |
| 2 | `electron/preload.js` | 86 |
| 3 | `electron/test-wallpaper.cjs` | 118 |
| 4 | `electron/wallpaper.js` | 368 |

## tests — 95 文件 / 16124 行

> pytest 回归测试（506 passed / 2 skipped）

| # | 文件 | 行数 |
|---|---|---|
| 1 | `tests/conftest.py` | 500 |
| 2 | `tests/fixtures/tokens_pre_r30.js` | 126 |
| 3 | `tests/fixtures/v18/article_page.html` | 74 |
| 4 | `tests/fixtures/v18/article_page_selector.html` | 76 |
| 5 | `tests/fixtures/v18/baidu_results.html` | 45 |
| 6 | `tests/fixtures/v18/bing_dual.html` | 40 |
| 7 | `tests/fixtures/v18/bing_results.html` | 92 |
| 8 | `tests/fixtures/v18/ddg_results.html` | 51 |
| 9 | `tests/fixtures/v18/google_results.html` | 42 |
| 10 | `tests/harness/conftest.py` | 10 |
| 11 | `tests/harness/test_v4_harness.py` | 1167 |
| 12 | `tests/helpers/frontend.py` | 178 |
| 13 | `tests/helpers/legacy_vm.py` | 215 |
| 14 | `tests/helpers/order-pinned.json` | 15 |
| 15 | `tests/helpers/state_reset.py` | 86 |
| 16 | `tests/test_agent_memory.py` | 347 |
| 17 | `tests/test_api_surface_consistency.py` | 104 |
| 18 | `tests/test_chat_log_centering.py` | 93 |
| 19 | `tests/test_ci_tooling.py` | 153 |
| 20 | `tests/test_collaboration_budget.py` | 66 |
| 21 | `tests/test_collaboration_flow.py` | 181 |
| 22 | `tests/test_collaboration_privacy.py` | 56 |
| 23 | `tests/test_collaboration_recovery.py` | 101 |
| 24 | `tests/test_collaboration_schema.py` | 97 |
| 25 | `tests/test_collaboration_ui.py` | 101 |
| 26 | `tests/test_collaboration_visual.py` | 28 |
| 27 | `tests/test_contract_diff.py` | 183 |
| 28 | `tests/test_contract_golden.py` | 53 |
| 29 | `tests/test_est_calibration.py` | 166 |
| 30 | `tests/test_expert_agent.py` | 132 |
| 31 | `tests/test_expert_agent_security.py` | 86 |
| 32 | `tests/test_expert_center.py` | 140 |
| 33 | `tests/test_expert_mailbox.py` | 50 |
| 34 | `tests/test_expert_recovery.py` | 33 |
| 35 | `tests/test_expert_team.py` | 109 |
| 36 | `tests/test_expert_timeline.py` | 48 |
| 37 | `tests/test_expert_visual.py` | 37 |
| 38 | `tests/test_frontend_tree.py` | 173 |
| 39 | `tests/test_generative_artifact.py` | 221 |
| 40 | `tests/test_generative_data_ref.py` | 201 |
| 41 | `tests/test_generative_dom.py` | 133 |
| 42 | `tests/test_generative_registry.py` | 310 |
| 43 | `tests/test_generative_state.py` | 138 |
| 44 | `tests/test_generative_visual.py` | 62 |
| 45 | `tests/test_glm_preset_real_models.py` | 87 |
| 46 | `tests/test_glm_proxy_route.py` | 115 |
| 47 | `tests/test_group_endpoint_bridge.py` | 41 |
| 48 | `tests/test_group_endpoints.py` | 153 |
| 49 | `tests/test_group_mention.py` | 201 |
| 50 | `tests/test_group_persistence.py` | 70 |
| 51 | `tests/test_group_unlimited_relay.py` | 121 |
| 52 | `tests/test_icon_system.py` | 96 |
| 53 | `tests/test_installer.py` | 246 |
| 54 | `tests/test_model_executor.py` | 251 |
| 55 | `tests/test_model_executor_foundation.py` | 247 |
| 56 | `tests/test_modern_frontend_state.py` | 229 |
| 57 | `tests/test_nemotron_preset.py` | 94 |
| 58 | `tests/test_onboarding_harness.py` | 115 |
| 59 | `tests/test_perf_guards.py` | 42 |
| 60 | `tests/test_perf_protocol_v2.py` | 245 |
| 61 | `tests/test_qa_generative_adversarial.py` | 208 |
| 62 | `tests/test_qa_generative_qa2_boundaries.py` | 168 |
| 63 | `tests/test_qa_generative_reverify.py` | 108 |
| 64 | `tests/test_qa_w9_adversarial.py` | 60 |
| 65 | `tests/test_r20_scan_fixes.py` | 85 |
| 66 | `tests/test_r23_clipboard_flag.py` | 97 |
| 67 | `tests/test_r27_upgrades.py` | 197 |
| 68 | `tests/test_r30_upgrades.py` | 280 |
| 69 | `tests/test_r31_parallel.py` | 327 |
| 70 | `tests/test_r32_hub.py` | 213 |
| 71 | `tests/test_r33_market.py` | 181 |
| 72 | `tests/test_r34_market_sections.py` | 135 |
| 73 | `tests/test_r35_hub_market.py` | 272 |
| 74 | `tests/test_r40_desktop_protocol.py` | 44 |
| 75 | `tests/test_r43_evals.py` | 140 |
| 76 | `tests/test_r45_steering_expert.py` | 114 |
| 77 | `tests/test_r47_perf.py` | 31 |
| 78 | `tests/test_r58_conversation.py` | 363 |
| 79 | `tests/test_r63_frontend_fixes.py` | 112 |
| 80 | `tests/test_r67_react_migration.py` | 139 |
| 81 | `tests/test_r68_arch_contract.py` | 648 |
| 82 | `tests/test_resume.py` | 249 |
| 83 | `tests/test_round7_adversarial.py` | 1247 |
| 84 | `tests/test_session_project_redesign.py` | 239 |
| 85 | `tests/test_settings_navigation.py` | 110 |
| 86 | `tests/test_sidebar_run_status.py` | 208 |
| 87 | `tests/test_v15_frontend_link.py` | 363 |
| 88 | `tests/test_v16_mcp_resources_ui.py` | 394 |
| 89 | `tests/test_v19_performance_protocol.py` | 130 |
| 90 | `tests/test_virtual_chat.py` | 160 |
| 91 | `tests/test_w4a_visual.py` | 86 |
| 92 | `tests/test_w4b_visual.py` | 92 |
| 93 | `tests/test_w7_w8_gate.py` | 25 |
| 94 | `tests/test_w9_fix_boundaries.py` | 107 |
| 95 | `tests/test_windows_packaging_dependencies.py` | 120 |

## qa — 53 文件 / 12956 行

> QA 探针与验收证据（Playwright/CDP，非 pytest）

| # | 文件 | 行数 |
|---|---|---|
| 1 | `qa/r90/skin-probe.mjs` | 524 |
| 2 | `qa/r90/verify-asar.mjs` | 88 |
| 3 | `qa/r92/extract-asar-html.mjs` | 80 |
| 4 | `qa/r92/liquid-switch-probe.mjs` | 156 |
| 5 | `qa/r92/optics-dynamic-probe.mjs` | 206 |
| 6 | `qa/r92/optics-dynamic.json` | 201 |
| 7 | `qa/r92/optics-fps.json` | 935 |
| 8 | `qa/r92/optics-null-control.mjs` | 158 |
| 9 | `qa/r92/optics-null.json` | 247 |
| 10 | `qa/r92/optics-pixel-probe.mjs` | 121 |
| 11 | `qa/r92/optics-pixel.json` | 32 |
| 12 | `qa/r92/optics-probe.mjs` | 407 |
| 13 | `qa/r92/shots/final/README.md` | 134 |
| 14 | `qa/r92/shots/final/_before-r94/measurements.json` | 708 |
| 15 | `qa/r92/shots/final/capture.mjs` | 217 |
| 16 | `qa/r92/shots/final/measurements.json` | 708 |
| 17 | `qa/r92/shots/views/README.md` | 38 |
| 18 | `qa/r92/verify-pack-semantics.mjs` | 71 |
| 19 | `qa/r92/views-probe.mjs` | 382 |
| 20 | `qa/r95/click-acting-probe.mjs` | 182 |
| 21 | `qa/r95/fix-candidates.mjs` | 138 |
| 22 | `qa/r95/fix-verify.mjs` | 137 |
| 23 | `qa/r95/layout-diag.mjs` | 206 |
| 24 | `qa/r95/real-app-launch-probe.mjs` | 144 |
| 25 | `qa/r95/real-app-probe.mjs` | 136 |
| 26 | `qa/r95/scan-overlap.mjs` | 179 |
| 27 | `qa/r95/scroll-ghost-probe.mjs` | 100 |
| 28 | `qa/r96/actions-card-probe.mjs` | 280 |
| 29 | `qa/r96/assistant-clearance-probe.mjs` | 234 |
| 30 | `qa/r96/bottom-sweep-probe.mjs` | 257 |
| 31 | `qa/r96/bottom-sweep.json` | 152 |
| 32 | `qa/r96/click-acting-probe-on-repo.mjs` | 187 |
| 33 | `qa/r96/data-loss-forensics-db.py` | 55 |
| 34 | `qa/r96/data-loss-forensics-ldb.py` | 56 |
| 35 | `qa/r96/data-loss-forensics.py` | 131 |
| 36 | `qa/r96/gd-transparency-probe.mjs` | 252 |
| 37 | `qa/r96/installed-r96-probe.mjs` | 246 |
| 38 | `qa/r96/make-r95-copy.py` | 36 |
| 39 | `qa/r96/mount-parity-probe.mjs` | 297 |
| 40 | `qa/r96/qa-actions-classic.mjs` | 183 |
| 41 | `qa/r96/qa-gd-page.mjs` | 458 |
| 42 | `qa/r96/qa-lastmsg-clip.mjs` | 147 |
| 43 | `qa/r96/qa-msg-actions.mjs` | 652 |
| 44 | `qa/r96/qa-overlay-scan.json` | 17 |
| 45 | `qa/r96/qa-overlay-scan.mjs` | 271 |
| 46 | `qa/r96/qa-r2-diagnose.mjs` | 134 |
| 47 | `qa/r96/qa-r2-shots.mjs` | 172 |
| 48 | `qa/r96/qa-r2-zorder.mjs` | 406 |
| 49 | `qa/r96/qa-r2b-zorder.mjs` | 384 |
| 50 | `qa/r96/reverse-check-probe.mjs` | 221 |
| 51 | `qa/r96/zorder-click-probe.mjs` | 455 |
| 52 | `qa/r97/diag-bar-owner.mjs` | 100 |
| 53 | `qa/r97/qa-installed.mjs` | 538 |

## scripts — 1 文件 / 97 行

> 构建辅助脚本

| # | 文件 | 行数 |
|---|---|---|
| 1 | `scripts/build-lightwell.mjs` | 97 |

## tools — 94 文件 / 12560 行

> 工具链与门禁脚本

| # | 文件 | 行数 |
|---|---|---|
| 1 | `tools/arch_assessment.py` | 217 |
| 2 | `tools/build_hub_catalog.py` | 572 |
| 3 | `tools/build_ui_schema_bundle.js` | 54 |
| 4 | `tools/cdp_lib.py` | 79 |
| 5 | `tools/check_build_dependencies.py` | 76 |
| 6 | `tools/check_release.py` | 200 |
| 7 | `tools/check_static_paths.py` | 158 |
| 8 | `tools/classify_remaining_pins.py` | 117 |
| 9 | `tools/contract_diff.py` | 271 |
| 10 | `tools/contract_golden_replay.py` | 113 |
| 11 | `tools/data/hub-market-snapshot.json` | 1 |
| 12 | `tools/data/hub-mcp-probe.json` | 1 |
| 13 | `tools/deep_scan.py` | 117 |
| 14 | `tools/dep_graph.py` | 152 |
| 15 | `tools/dep_scan.py` | 206 |
| 16 | `tools/diag/bisect_pollution.py` | 131 |
| 17 | `tools/diag/state_probe.py` | 268 |
| 18 | `tools/diff/diff-config.json` | 42 |
| 19 | `tools/diff/extract_rpc_defaults.py` | 56 |
| 20 | `tools/diff/fakes.py` | 477 |
| 21 | `tools/diff/fixtures/browser/browser-offline-errors.json` | 101 |
| 22 | `tools/diff/fixtures/browser/browser-tier-aligned-errors.json` | 66 |
| 23 | `tools/diff/fixtures/commands/commands-admin-approve.json` | 30 |
| 24 | `tools/diff/fixtures/commands/commands-admin-deny.json` | 28 |
| 25 | `tools/diff/fixtures/commands/commands-guarded.json` | 75 |
| 26 | `tools/diff/fixtures/experts/experts-basic.json` | 25 |
| 27 | `tools/diff/fixtures/export/export-once-path.json` | 54 |
| 28 | `tools/diff/fixtures/files/files-basic.json` | 36 |
| 29 | `tools/diff/fixtures/guard/guard-chain.json` | 155 |
| 30 | `tools/diff/fixtures/history-dir/history-dir-basic.json` | 72 |
| 31 | `tools/diff/fixtures/mcp/mcp-config.json` | 31 |
| 32 | `tools/diff/fixtures/memory/memory-basic.json` | 26 |
| 33 | `tools/diff/fixtures/meta/api-info.json` | 23 |
| 34 | `tools/diff/fixtures/misc-config/config-family.json` | 33 |
| 35 | `tools/diff/fixtures/os-system/clipboard-process.json` | 26 |
| 36 | `tools/diff/fixtures/plans-checkpoints/checkpoints-basic.json` | 69 |
| 37 | `tools/diff/fixtures/plans-checkpoints/plans-basic.json` | 77 |
| 38 | `tools/diff/fixtures/provider/prompts-tools.json` | 144 |
| 39 | `tools/diff/fixtures/rpc/rpc-dispatch.json` | 26 |
| 40 | `tools/diff/fixtures/selftest/default-context-equivalence.json` | 89 |
| 41 | `tools/diff/fixtures/selftest/fixed-shape-canary.json` | 66 |
| 42 | `tools/diff/fixtures/selftest/shape-divergent-classifier.json` | 23 |
| 43 | `tools/diff/fixtures/selftest/shape-mask-classifier.json` | 23 |
| 44 | `tools/diff/fixtures/selftest/value-diff-classifier.json` | 29 |
| 45 | `tools/diff/fixtures/sessions/sessions-basic.json` | 65 |
| 46 | `tools/diff/fixtures/sessions/sessions-validation.json` | 53 |
| 47 | `tools/diff/fixtures/software/software-basic.json` | 74 |
| 48 | `tools/diff/fixtures/update/update-offline.json` | 22 |
| 49 | `tools/diff/fixtures/webdav/webdav-offline.json` | 23 |
| 50 | `tools/diff/fixtures/workspace/workspace-basic.json` | 36 |
| 51 | `tools/diff/intentional-deltas.json` | 140 |
| 52 | `tools/diff/live-replay.mjs` | 441 |
| 53 | `tools/diff/mock-table.json` | 198 |
| 54 | `tools/diff/normalize-rules.json` | 132 |
| 55 | `tools/diff/python_driver.py` | 220 |
| 56 | `tools/diff/uncovered.json` | 114 |
| 57 | `tools/entry_sweep.py` | 183 |
| 58 | `tools/fetch_hub_market.py` | 184 |
| 59 | `tools/fetch_hub_personas.py` | 71 |
| 60 | `tools/function_graph.py` | 262 |
| 61 | `tools/gate_coverage.py` | 254 |
| 62 | `tools/gen_allowlist.mjs` | 73 |
| 63 | `tools/gen_api_reference.py` | 99 |
| 64 | `tools/gen_test_disposition.py` | 227 |
| 65 | `tools/hub_localize.py` | 230 |
| 66 | `tools/import_cost.mjs` | 40 |
| 67 | `tools/lib/js-lexer.mjs` | 92 |
| 68 | `tools/module-inventory.mjs` | 244 |
| 69 | `tools/perf_benchmark.py` | 271 |
| 70 | `tools/perf_cdp.py` | 299 |
| 71 | `tools/perf_confirm_path.js` | 228 |
| 72 | `tools/perf_frontend_benchmark.js` | 285 |
| 73 | `tools/perf_stats.py` | 52 |
| 74 | `tools/perf_system.py` | 106 |
| 75 | `tools/perf_w6p1.py` | 134 |
| 76 | `tools/post_deletion_audit.py` | 420 |
| 77 | `tools/probe_hub_mcp.py` | 117 |
| 78 | `tools/read-session-db.mjs` | 10 |
| 79 | `tools/review_all_remaining.py` | 164 |
| 80 | `tools/round_runner.py` | 206 |
| 81 | `tools/run_normalized_gates.py` | 161 |
| 82 | `tools/scc_ratchet.py` | 61 |
| 83 | `tools/smoke_harbor_island.js` | 66 |
| 84 | `tools/test_bridge_http.mjs` | 88 |
| 85 | `tools/test_island_switch.mjs` | 82 |
| 86 | `tools/test_save_signature.mjs` | 60 |
| 87 | `tools/type_annotation_audit.py` | 182 |
| 88 | `tools/upgrade_audit.py` | 150 |
| 89 | `tools/verify-dpapi-interop.mjs` | 77 |
| 90 | `tools/verify-install-uninstall.mjs` | 301 |
| 91 | `tools/verify-migration.mjs` | 159 |
| 92 | `tools/verify-react-render.mjs` | 287 |
| 93 | `tools/verify-upgrade-e2e.mjs` | 256 |
| 94 | `tools/wave_guard.py` | 226 |
