# -*- coding: utf-8 -*-
"""Api 门面（对外契约层）：50 个 js_api 公开方法，签名/位置参数/返回协议逐字保持 v1.0.0。

红线（重构生命线）：
1. 方法名、参数个数、位置顺序不变——前端 callApi 按位置传参。
2. 三个"方言"原样保留：get_clipboard/set_clipboard（schema 里叫 clipboard_read/write）、
   append_memory(entry_json) 位置参数传 JSON 串。
3. 方法-only 表面：不挂公开可变属性（legacy L168-175 的 4 个公开属性已下沉为私有）。
4. 返回均为 JSON 字符串（get_cwd/get_worklog 裸文本协议保持 legacy 原样）。

v1.2 追加 guard/update/provider 共 10 个、v1.3 追加 mcp_* 共 10 个隐身方法（_V12_EXTRA）。
"""
import json
import os
import sys

from . import tools_schema
from .application.operation import OperationDenied, OperationRequest
from .application.task import TaskEnvelope
from .bootstrap.container import ServiceContainer
from .domains.providers.local_model_service import readiness as local_readiness_score
from .domains.providers.local_proxy import get_proxy
from .errors import err, ok
from .logging_setup import get_logger

API_VERSION = 'v1.0.0'

# rpc 通用分发通道的私有方法白名单（v1.8.0 S 域）：用户自定义软件条目的
# CRUD 经 rpc 暴露（契约 js_api 方法面恰为 software×3——联调规范 §1.2，
# 不新增 _V12_EXTRA 方法、不进 get_api_info 自省面）。仅限这两个已知
# 安全的注册表写入入口，其余私有方法仍一律拒绝（原有防护不放松）。
_RPC_PRIVATE_OK = frozenset({'_software_save', '_software_remove'})

# v1.2 新增的 js_api 方法（guard / update / provider）+ v1.3 MCP（10 个）。
# 它们对 get_api_info() 的方法清单【隐身】：该输出与 legacy 逐字节比对（契约差分测试），
# 因此自省时排除。pywebview 桥接按属性枚举照常暴露这些方法，前端可直接调用。
# v1.5 预留接口（local_* 本地模型 / webdav_* 数据主权）：同样隐身，签名与返回
# shape 为终态（deliverables/dev-plan/reserved-interfaces-v15-2026-10-17.md）。
_V12_EXTRA = frozenset({
    'guard_get_config', 'guard_save_config', 'guard_check', 'guard_audit', 'get_audit_log',
    'guard_confirm_token', 'guard_session_trust',   # 修复 S4①：confirm-token 签发/会话信任登记
    'check_update', 'start_update_download', 'get_update_progress', 'apply_update',
    'test_provider_endpoint',
    # v1.3 MCP（10 个，同样对 get_api_info 隐身）
    'mcp_list_servers', 'mcp_save_server', 'mcp_delete_server', 'mcp_test_server',
    'mcp_get_server_detail', 'mcp_set_tool_tier', 'mcp_check_tool', 'mcp_call_tool',
    'mcp_import_claude', 'mcp_shutdown',
    # v1.5 本地模型预留接口（连接层 A + 适配层 B 判定）
    'local_probe', 'local_models',
    # v1.6 WebDAV 预留接口（数据主权；IO 为 reserved 占位）
    'webdav_get_config', 'webdav_save_config', 'webdav_test', 'webdav_export', 'webdav_restore',
    # 修复 W2（三轮）：任务开始钩子（重置后端命令去重器，与前端 per-task 生命周期对齐）
    'begin_task',
    # v1.6 沙箱（进程隔离/资源限制；配置独立文件 sandbox.json，不碰 config.json）
    'sandbox_get_config', 'sandbox_save_config', 'sandbox_status',
    # v1.6 T12 MCP resources（text 优先；blob 截断落盘；订阅存 mcp_servers.json 可选键）
    'mcp_list_resources', 'mcp_read_resource', 'mcp_save_subscriptions',
    # v1.6 HF-P0：本地 CORS 代理桥方法（file:// 页面直连不输出 CORS 头的本地
    # 模型服务器必被 Chromium 拒；前端 local 模式经此后端代理转发）
    'get_local_proxy',
    # v1.8.0 B 域·浏览器搜索（5 个；§8 两建议新增方法评审通过后追加。
    # get_api_info 零漂移同款隐身；build_tools include_agent 工具面属 C 域批次）
    'browser_search', 'browser_open', 'search_cache_stats',
    'search_status', 'browser_takeover',
    # v1.8.0 S 域·外部软件调用（3 个）+ H 域·混合路由（2 个）
    # + v1.8.5 A 域·任务授权与白名单（6 个，R5 裁决提前插）
    'software_list', 'software_probe', 'software_call',
    'hybrid_get_config', 'hybrid_save_config',
    'guard_task_grant', 'guard_task_revoke', 'guard_task_status',
    'guard_rule_list', 'guard_rule_add', 'guard_rule_remove',
    # v1.8.0 M3 域·Plan-Act 计划执行与检查点（9 个；plans//checkpoints/ 独立目录）
    'plan_create', 'plan_get', 'plan_update', 'plan_list',
    'checkpoint_create', 'checkpoint_rollback', 'checkpoint_list',
    'clarify_collect',
    # v1.8.0 W11 域·记忆 UI（1 个；删 memory.json 第 index 条，边界校验
    # 不静默夹逼；get_api_info 零漂移同款隐身）
    'memory_delete', 'prompt_get', 'trace_new', 'local_readiness',
    'history_dir_get', 'history_dir_set', 'session_purge', 'memory_retrieve',
    # Round 14：群文件（交接文档仓库）
    'group_files_config_get', 'group_files_config_set', 'group_files_write',
    'group_files_list', 'group_files_search',
    # v1.9.0 M1.9 占位（master-plan §6.2；转正时只改实现不改登记）
    'browser_navigate', 'browser_extract', 'browser_click', 'browser_fill',
    'browser_screenshot', 'browser_close', 'get_platform_info',
    'guard_approval_budget', 'search_reader_stats',
    'reader_config_get', 'reader_config_save',
    'pick_save_path', 'save_export_file',
    # 复核批：推理偏好（模型弹层内嵌思考强度/上下文窗口；model_prefs.json 独立文件）
    'model_prefs_get', 'model_prefs_save',
    # v1.9.0 M3/M5 转正后新增（隐身同款）
    'browser_sessions', 'browser_set_mode',
    # 复核批：流式渲染逼帧兜底（WebView2 后台化残余场景；前端流式期间轮询）
    'ui_nudge',
    # W5A 专家包目录导入/快照资源服务（仅包治理，不含 Team/Agent 执行）
    'expert_list', 'expert_get', 'expert_import_directory', 'expert_read_resource',
    'expert_save_preferences', 'expert_set_enabled', 'expert_delete_package',
})


class Api:
    def __init__(self, container=None):
        """Bind the frozen protocol facade to one fully assembled container."""
        self._container = container or ServiceContainer.build()
        for alias, service in self._container.api_aliases().items():
            setattr(self, alias, service)
        self._log = get_logger()
        self._ui_vis_logged = set()
        self._export_paths = self._container._export_paths
        self._export_paths_lock = self._container._export_paths_lock

    def _shutdown(self):
        return self._container.shutdown()

    def _execute_guarded(self, op, detail, token, executor,
                         denial='error', rejection_reason='backend-enforced'):
        """Adapt OperationDenied to the three pre-existing public JSON dialects."""
        request = OperationRequest(
            op=op, detail=detail, token=token,
            sid=self._runtime.get_current_sid() or '')
        try:
            return self._operation.execute(
                request, executor, rejection_reason=rejection_reason)
        except OperationDenied as denied:
            if denied.budget:
                return ok({'ok': False, 'error': denied.budget})
            if denial == 'err':
                return err(denied.reason)
            if denial == 'structured':
                return ok({'ok': False, 'error': {
                    'code': 'CONFIRM_REQUIRED', 'message': denied.reason, 'op': op}})
            return ok({'error': denied.reason})

    def _set_window(self, win):
        """入口装配：窗口引用放 RuntimeState（legacy _RT['win']），不挂 js_api 表面。
        命名为私有：get_api_info 经 dir() 自省，公开方法集合必须与 v1.0.0 逐字一致。
        修复 S4：窗口就绪即武装护栏——此后 always/session 档在执行点强制 token/信任校验。"""
        self._runtime.win = win
        if win is not None:
            self._native_ui.register(win, 'main',
                                     self._native_ui.begin_invoke_adapter(win), bootstrap=True)
        self._guard.arm()

    # ============ 群文件：交接文档仓库（Round 14，2026-11-04 主理人立项）============
    def group_files_config_get(self):
        """群文件目录配置（root=实际使用目录，custom=False 表示默认 ~/.glm-chat/group_files）。"""
        return self._group_files.get_config()

    def group_files_config_set(self, cfg_json):
        """设置群文件目录：{"root": "D:/harbor-group-files"}，空串恢复默认。"""
        return self._group_files.save_config(cfg_json)

    def group_files_write(self, group_id, group_name, member, title, content, meta_json='{}'):
        """归档一份交接文档（.md），返回落盘路径与索引条目。"""
        try:
            meta = json.loads(meta_json or '{}')
        except Exception:
            meta = {}
        return self._group_files.write(group_id, group_name, member, title, content, meta)

    def group_files_list(self, group_id, group_name=''):
        """列出某个群的群文件（最新在前）。"""
        return self._group_files.list(group_id, group_name)

    def group_files_search(self, group_id, query, limit=8):
        """关键词检索群文件：标题/成员/交接对象/关键词/正文加权，返回命中片段。"""
        return self._group_files.search(group_id, query, limit)

    # ============ 历史自选存放 + 真删（2026-10-21 用户需求）============
    def history_dir_get(self):
        """当前历史存放目录（''=默认 ~/.glm-chat/）+ sessions.json 实际路径。"""
        envelope = TaskEnvelope.create(
            'settings', 'history_dir_get', resourceKeys=('cfg:history',),
            sessionId=self._runtime.get_current_sid() or '', timeout_ms=10000)
        result = self._scheduler.submit(envelope).result(envelope.remaining())
        return ok(result)

    def history_dir_set(self, dir_path, migrate=False):
        """设置历史存放目录（空串恢复默认；migrate=True 搬旧 sessions.json）。

        后端校验：目录存在可写、禁系统敏感目录、realpath 归一。
        """
        r = self._config.history_dir_set(dir_path, migrate)
        if 'error' in r:
            return err(r['error'])
        return ok(r)

    # 注：历史目录选择复用 legacy 契约方法 pick_folder(sid)（下方原定义，
    # 工作区与历史目录对话框共用；无窗口环境返回 {ok:False, err:'no window'}，
    # 前端回落手动输入）——不重复定义（同类名后定义覆盖，曾误加死方法）。

    def pick_save_path(self, default_name='export.md'):
        """弹出系统「另存为」对话框（SAVE_DIALOG，带默认文件名）→ {ok, path}。

        导出专用（修复 2026-10-21 P1：blob + a.click() 下载在 WebView2 里弹
        模态下载 UI 阻塞页面消息循环——导出后界面卡死只能重开）。改用保存
        对话框 + 后端 save_export_file 写盘，零下载 UI。无窗口环境 →
        {ok: False, err}（前端 toast 回落）。

        安全（修复 P1 二期）：对话框选中的路径登记进进程内一次性集合
        （normcase+abspath 归一）——save_export_file 仅接受已登记路径，
        杜绝任意路径写（js_api 表面可被模型/前端直接调用）。
        """
        win = getattr(self._runtime, 'win', None)
        if win is None:
            return err('当前环境不支持保存对话框')
        try:
            # pywebview SAVE_DIALOG = 30（FOLDER=10/OPEN=20/SAVE=30；字面量避免
            # api.py 顶层 import webview——无 GUI 环境 import 亦可失败）
            result = win.create_file_dialog(30, directory='', save_filename=default_name)
            if result and len(result) > 0:
                p = str(result[0])
                with self._export_paths_lock:
                    self._export_paths.add(os.path.normcase(os.path.abspath(p)))
                return ok({'ok': True, 'path': p})
            return ok({'ok': False, 'path': ''})     # 用户取消
        except Exception as e:
            return err('保存对话框失败: %s' % e)

    def save_export_file(self, path, content):
        """把导出内容写盘（UTF-8）→ {ok, path, bytes}。

        安全约束（修复 P1 二期）：path 必须由 pick_save_path 对话框登记
        （进程内一次性集合，pop 消费）——否则返回 err('保存路径须由导出
        对话框选择（安全约束）'）。防 js_api 表面被直接调用以后端进程
        权限写任意文件。
        其余校验保留：内容上限 8MB（导出是会话 markdown，防病态大串写爆）+
        父目录存在（防 dialog 异常返回）。写失败 → err 人话。
        审计：与文件内其他 audit 调用同口径（拒绝 decision=unregistered-path，
        成功 decision=saved）。
        """
        p = str(path or '').strip()
        if not p:
            return err('保存路径为空')
        # 复核修正：先校验后消费——原先 pop 一次性路径登记后才验 8MB 上限，
        # 超限时登记已被消费，用户须重走对话框才能重试导出
        text = str(content if content is not None else '')
        if len(text.encode('utf-8')) > 8 * 1024 * 1024:
            return err('导出内容超过 8MB 上限')
        key = os.path.normcase(os.path.abspath(p))
        with self._export_paths_lock:
            registered = key in self._export_paths
            if registered:
                self._export_paths.discard(key)   # 一次性消费
        if not registered:
            self._guard.audit('save_export_file', {'path': p}, 'block',
                              'unregistered-path')
            return err('保存路径须由导出对话框选择（安全约束）')
        parent = os.path.dirname(os.path.abspath(p))
        if not os.path.isdir(parent):
            return err('目标目录不存在: %s' % parent)
        try:
            with open(p, 'w', encoding='utf-8', newline='\n') as f:
                f.write(text)
            self._guard.audit('save_export_file',
                              {'path': p, 'bytes': len(text.encode('utf-8'))},
                              'ok', 'saved')
            return ok({'ok': True, 'path': p,
                       'bytes': len(text.encode('utf-8'))})
        except Exception as e:
            return err('写入失败: %s' % e)

    # ============ v1.9.0 浏览器驱动原语 ============
    def browser_navigate(self, url, wait_selector='', timeout=60,
                         mode='hidden', token=None):
        """M3/M5 转正：新建驱动会话并导航（任意 URL + 等待选择器/硬超时）。

        guard 矩阵（M5.2）：session 档；mode=hidden|visible（M3.8 驱动模式，
        visible=用户可见浏览次窗）。返回含 session_id（后续原语无参作用于
        最近导航的游标会话）。审计 op=browser_navigate。
        """
        detail = {'url': str(url or '')[:200]}
        return self._execute_guarded(
            'browser_navigate', detail, token,
            lambda: ok(self._driver.navigate(url, wait_selector, timeout, mode)),
            denial='structured', rejection_reason=None)

    def browser_extract(self, selector='', mode='markdown', token=None):
        """M3/M5 + M2.1 转正：正文提取（markdown/text/links 三态 + provenance
        经读取器管线——dual-LLM-lite 接入在会话层 digest 场景，本方法直出三态）。
        guard session 档。审计 op=browser_extract。"""
        detail = {'selector': str(selector or '')[:80]}
        return self._execute_guarded(
            'browser_extract', detail, token,
            lambda: ok(self._driver.extract_guarded(selector, mode)),
            denial='structured', rejection_reason=None)

    def browser_click(self, target, token=None):
        """M3/M5 转正（guard=always）：点击（selector|text；前后态截图审计；
        视口外/不可见元素拒点）。审计 op=browser_click。"""
        detail = {'target': str(target or '')[:120]}
        return self._execute_guarded(
            'browser_click', detail, token,
            lambda: ok(self._driver.click(target)),
            denial='structured', rejection_reason=None)

    def browser_fill(self, selector, text, token=None):
        """M3/M5 转正（guard=always）：填充（敏感字段拒填；回传 masked:true
        禁回显原文）。审计 op=browser_fill（evidence 哈希在审计链侧，原文
        不落日志——token 摘要绑 selector+text_len 同口径）。"""
        detail = {'selector': str(selector or '')[:80],
                  'text_len': len(str(text if text is not None else ''))}
        return self._execute_guarded(
            'browser_fill', detail, token,
            lambda: ok(self._driver.fill(selector, text)),
            denial='structured', rejection_reason=None)

    def browser_screenshot(self, full_page=False, token=None):
        """M3/M5 转正（guard=session）：当前页截图（win32 窗口捕获 b64，
        point 坐标系）。审计 op=browser_screenshot。"""
        return self._execute_guarded(
            'browser_screenshot', {}, token,
            lambda: ok(self._driver.screenshot(full_page)),
            denial='structured', rejection_reason=None)

    def browser_close(self, session_id='', token=None):
        """M3/M5 转正：会话池回收（session_id 指定关一个；缺省全部；
        browser_sessions.json 状态同步）。session 档与其他原语同口径；
        token 绑定目标 id，阻断/预算拒绝落审计，成功仍按幂等管理操作处理。"""
        detail = {'session_id': str(session_id or '')}
        return self._execute_guarded(
            'browser_close', detail, token,
            lambda: ok(self._driver.close(session_id)),
            denial='structured', rejection_reason=None)

    def browser_sessions(self):
        """M3：会话池投影视图 {version, sessions[]}（browser_sessions.json
        同构；brw-mode 面板数据源）。读取类不落审计。"""
        return ok(self._driver.sessions())

    def browser_set_mode(self, mode, session_id=''):
        """M3.8：可见/隐藏驱动模式切换（brw-mode 面板/人工接管复检入口；
        win=次窗 show/hide，mac=makeKeyAndOrderFront/orderOut 理论实现）。
        会话管理类不落审计（幂等 UI 操作）。"""
        return ok(self._driver.set_mode(mode, session_id))

    def get_platform_info(self):
        """M6.10 转正：平台探测（os/arch/version/services 七接口就绪度 +
        浏览器后端就绪度）。读取类不落审计（前端 boot/69-platform 数据源：
        window.__platformInfo 缓存后驱动 data-platform 根类与 Cmd 键位映射）。"""
        import platform as _pf
        from .domains.integrations.browser import detect_platform
        from .domains.integrations.browser.platform import get_platform_services
        services = {}
        try:
            ps = get_platform_services()
            for name in ('secrets', 'sandbox', 'screen', 'trash',
                         'paths', 'process', 'notify'):
                try:
                    svc = getattr(ps, name)()
                    probe = getattr(svc, 'available', None)
                    services[name] = {
                        'ok': bool(probe()) if callable(probe) else True,
                        'name': getattr(svc, 'name', name)}
                except Exception as e:
                    services[name] = {'ok': False, 'error': str(e)[:120]}
        except Exception as e:
            services = {'ok': False, 'error': str(e)[:200]}
        browser = {}
        try:
            from .domains.integrations.browser import create_session
            from .domains.integrations.browser.session_mac import mac_backend_available
            browser = {'platform': detect_platform(),
                       'win': True, 'headless': True,
                       'mac': bool(mac_backend_available()),
                       'note': 'mac 后端为理论实现（PyObjC 就绪即启用；'
                               '真机链路验证排期 M9.5）'}
        except Exception as e:
            browser = {'error': str(e)[:200]}
        return ok({'ok': True,
                   'os': detect_platform(),
                   'machine': _pf.machine(),
                   'python': _pf.python_version(),
                   'services': services,
                   'browser_backend': browser})

    def guard_approval_budget(self, limit=None):
        """M2.4 转正：会话级审批预算读/设。

        limit=None 只读 {used, limit, escalated, remaining, grant_active}；
        int 1-100 设置（越界 BAD_PARAMS）。数据源 guard.json 纯增键
        approval_budget（旧文件缺省合并）；used/escalated 会话级。
        """
        r = self._guard.approval_budget(limit)
        if 'error' in r:
            return err(r['error']['message'])
        return ok(r)

    def search_reader_stats(self):
        """M2.1 转正：读取器统计 {reader_calls, schema_fail, degrade_count,
        local_available, configured, last_error, since}。读取类不落审计。"""
        return ok(self._reader.stats())

    def reader_config_get(self):
        """M2.1：读取器配置读取（reader.json 合并缺省；未配置=缺省）。"""
        return ok(self._reader.config())

    def reader_config_save(self, config_json):
        """M2.1：读取器配置保存（budget_s 1-60/schema_mode 枚举越界 BAD_PARAMS）。"""
        try:
            d = json.loads(config_json or '{}')
        except Exception as e:
            return err('reader 配置 JSON 解析失败: %s' % e)
        r = self._reader.save_config(d)
        if 'error' in r:
            return err(r['error'])
        return ok(r)

    def model_prefs_get(self):
        """复核批新增：推理偏好读取（思考强度/上下文窗口）。

        model_prefs.json 独立文件（config.json 零污染铁律）；读取类不落审计
        （模型弹层每次打开都读，同 search_cache_stats 口径）。"""
        return ok(self._model_prefs.get())

    def model_prefs_save(self, prefs_json):
        """复核批新增：推理偏好保存。

        thinking ∈ auto/off/low/medium/high（auto=智能档；off=禁思考；其余
        手动锁定随请求发 reasoning_effort）；ctx_k=0（默认 200K 口径）或
        32/128/256/300/1024K（其他合法输入收敛到最近低档）。审计 op=model_prefs
        （decision=save，设置类与其他保存同口径）。"""
        r = self._model_prefs.save(prefs_json)
        if r.get('error'):
            self._guard.audit('model_prefs', {'thinking': str(r.get('thinking', '')),
                                              'ctx_k': str(r.get('ctx_k', ''))},
                              'block', 'invalid-prefs')
            return err(r['error'])
        self._guard.audit('model_prefs', {'thinking': str(r.get('thinking', '')),
                                          'ctx_k': str(r.get('ctx_k', ''))},
                          'decision', 'save')
        return ok(r)

    def ui_nudge(self, visibility='visible'):
        """复核批新增：流式渲染逼帧兜底——前端流式期间每 ~800ms 调用一次，
        对宿主窗口（含 WebView2 子窗口）做一次原生 RedrawWindow，强制合成器
        present 最新帧（对抗 WebView2 后台化残余的渲染面冻结）。

        visibility：前端 document.visibilityState 原样透传（诊断：首次出现的
        状态记 harbor.log，为「页面被误判 hidden」提供证据）。高频轮询不落
        审计（search_status 同口径）。_V12_EXTRA 隐身。"""
        try:
            win = getattr(self._runtime, 'win', None)
            if win is None:
                return ok({'nudged': False, 'reason': 'window-not-ready'})
            if visibility not in getattr(self, '_ui_vis_logged', set()):
                try:
                    self._ui_vis_logged.add(visibility)
                    self._log.warning('WebView2 visibilityState=%s（逼帧兜底激活）', visibility)
                except Exception:
                    pass
            RDW_INVALIDATE, RDW_ERASE = 0x1, 0x4
            RDW_ALLCHILDREN, RDW_UPDATENOW = 0x80, 0x100
            flags = RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN | RDW_UPDATENOW
            return ok({'nudged': self._native_ui.redraw(win, flags)})
        except Exception as e:
            self._log.warning('ui_nudge 失败: %r', e)
            return ok({'nudged': False, 'error': str(e)})

    def session_purge(self, sid, task_ids_json='[]'):
        """真删一条会话的全部痕迹：sessions.json 条目 + session_ws 绑定 +
        关联 plan json + 关联 checkpoint 目录。task_ids 由前端传 s.plan.task_id。

        修复 W5：purge 成功后再收口 workspace 内存态——config_service 只保底
        删了 session_ws.json 文件条目，进程内 WorkspaceService 的会话映射/
        ws_enabled 开关不摘会在重启前残留（绑定目录仍对生效 sid 生效）。
        """
        r = self._config.session_purge(sid, task_ids_json)
        if r.get('ok'):
            try:
                self._workspace.delete_session_ws(sid)
            except Exception as e:
                self._log.warning('purge 后 workspace 内存态收口失败: %r', e)
        return ok(r)

    def clear_caches(self):
        self._files.file_fp.clear()
        # 修复 W6（三轮）：不再重置 cmd_deduper——压缩/切会话时调用本方法会把跨轮
        # 写命令去重洗白（重复 del 放行）；去重器生命周期改由 begin_task 对齐前端 per-task
        return 'ok'

    def begin_task(self):
        """修复 W2（三轮）：任务开始重置后端命令去重器——原进程级存活（仅 clear_caches
        清），跨任务「上一条」假拒绝；前端 deduper 是 per-task 预记账，两层生命周期
        经此钩子对齐。前端 runAgentLoop 起始调用（_V12_EXTRA 隐身，契约零漂移）。"""
        self._cmds.cmd_deduper.reset()
        return 'ok'

    # ============ 配置 ============
    def get_config(self):
        return self._config.get_config()

    def save_config(self, config_json):
        return self._config.save_config(config_json)

    def get_sessions(self):
        return self._config.get_sessions()

    def save_sessions(self, data):
        return self._config.save_sessions(data)

    def set_workspace(self, path):
        try:
            if os.path.isdir(path):
                # 复核修正：改走 set_cwd 统一入口（锁内 abspath+落盘）——原
                # 锁外裸赋值与 set_cwd/save_workspace 并发可撕裂
                self._config.set_cwd(path)
                # 修复 ⑦（三轮）：set_workspace 不更新 recent 列表——经 api 直改目录
                # （会话绑定等路径）后 recent 不出现该目录，快捷条/面板下拉缺失
                try:
                    self._workspace.touch_recent_ws(path)
                except Exception:
                    pass
                return ok({'ok': True, 'path': self._config.cwd})
            return err(f'目录不存在: {path}')
        except Exception as e:
            return err(e)

    def get_cwd(self):
        return self._config.cwd

    def get_api_info(self):
        try:
            exe_path = sys.executable if getattr(sys, 'frozen', False) else 'python(main.py)'
        except Exception:
            exe_path = 'unknown'
        methods = sorted(n for n in dir(self)
                         if not n.startswith('_') and callable(getattr(self, n))
                         and n not in _V12_EXTRA)   # v1.2 新方法隐身：契约输出与 legacy 逐字节一致
        return ok({'version': API_VERSION, 'exe': exe_path, 'methods': methods})

    def rpc(self, name, payload_json='{}'):
        try:
            args = json.loads(payload_json or '{}')
        except Exception:
            args = {}
        if not isinstance(args, dict):
            args = {}
        name = str(name)
        func = getattr(self, name, None)
        if name == 'rpc' or name.startswith('_') and name not in _RPC_PRIVATE_OK \
                or not callable(func):
            return ok({'error': '未知方法: %s' % name})
        try:
            return func(**args)
        except Exception as e:
            return err(e)

    # ============ 文件操作 ============
    def list_dir(self, path=None):
        return self._files.list_dir(self._runtime.get_current_sid(), path)

    def read_file(self, path, offset=0, limit=800, force=False):
        return self._files.read_file(self._runtime.get_current_sid(), path, offset, limit, force)

    def write_file(self, path, content):
        return self._files.write_file(self._runtime.get_current_sid(), path, content)

    def append_file(self, path, content):
        return self._files.append_file(self._runtime.get_current_sid(), path, content)

    def search_replace(self, path, old, new, replace_all=False):
        return self._files.search_replace(self._runtime.get_current_sid(), path, old, new, replace_all)

    def make_dir(self, path):
        return self._files.make_dir(self._runtime.get_current_sid(), path)

    def delete_path(self, path, recycle=True, token=None):
        # v1.2 R2：保护名单后端强制执行（默认名单为空 → 行为与 legacy 完全一致）
        # 修复 S4①：武装后 always/session 档强制一次性 token / 会话信任
        # 修复 QA 发现：名单校验需工作区绝对路径——相对路径直接 abspath 会落到
        # 进程 CWD 使保护名单永不命中（相对路径调用下名单形同虚设）
        # 修复 W3（二轮）：护栏校验与执行复用同一次取的 sid（原两次取，
        # 会话切换 TOCTOU 会使名单与目标脱钩）
        sid = self._runtime.get_current_sid()
        abs_p, _ = self._files.resolve_abs(sid, path)
        return self._execute_guarded(
            'delete_path', {'path': path, 'abs_path': abs_p}, token,
            lambda: self._files.delete_path(sid, path, recycle), denial='err')

    def move_path(self, path, new_path):
        return self._files.move_path(self._runtime.get_current_sid(), path, new_path)

    def copy_path(self, path, new_path):
        return self._files.copy_path(self._runtime.get_current_sid(), path, new_path)

    def get_file_info(self, path):
        return self._files.get_file_info(self._runtime.get_current_sid(), path)

    # ============ 命令执行 ============
    def run_command(self, cmd, timeout=60, token=None):
        # 修复 S4②：命令执行纳入护栏后端强制（默认 off 档 → 行为不变）
        def execute():
            self._auto_checkpoint_before_shell('run_command')
            return self._cmds.run_command(
                self._runtime.get_current_sid(), cmd, timeout,
                sandbox=self._sandbox.limits_for('run_command'))
        return self._execute_guarded(
            'run_command', {'cmd': str(cmd or '')[:200]}, token, execute, denial='err')

    def run_powershell(self, cmd, timeout=60, token=None):
        def execute():
            self._auto_checkpoint_before_shell('run_powershell')
            return self._cmds.run_powershell(
                self._runtime.get_current_sid(), cmd, timeout,
                sandbox=self._sandbox.limits_for('run_powershell'))
        return self._execute_guarded(
            'run_powershell', {'cmd': str(cmd or '')[:200]}, token, execute, denial='err')

    def run_admin_command(self, cmd, token=None, timeout=None):
        # 修复 S5/W8（三轮）：timeout 尾参接线——原签名丢 timeout（W13 二轮的「可调」
        # 是死参数），前端 150s 固定桥接超时与后端人审/轮询口径脱节（二次提权根因之一）。
        # 尾参追加保持旧调用形态 run_admin_command(cmd[, token]) 兼容。
        return self._execute_guarded(
            'run_admin_command', {'cmd': str(cmd or '')[:200]}, token,
            lambda: self._cmds.run_admin_command(
                self._runtime.get_current_sid(), cmd, timeout), denial='err')

    # ============ v1.6 沙箱（_V12_EXTRA 隐身）============
    def sandbox_get_config(self):
        """沙箱配置：开关 + 命令类别档位 + 各档限制（sandbox.json 独立存储）。"""
        return self._sandbox.get_config()

    def sandbox_save_config(self, cfg_json):
        return self._sandbox.save_config(cfg_json)

    def sandbox_status(self):
        """可用性（平台/创建能力）+ 启用态 + 进程级统计。"""
        return self._sandbox.status()

    # ============ 剪贴板 ============
    def get_clipboard(self, token=None):
        # 修复 S4②：clipboard_read 补 enforce 挂点（原完全无后端校验）
        return self._execute_guarded(
            'clipboard_read', {}, token,
            lambda: self._clipboard.get_clipboard())

    def set_clipboard(self, text, token=None):
        # 修复 S4②：clipboard_write 补 enforce 挂点
        detail = {'len': len(str(text if text is not None else ''))}
        return self._execute_guarded(
            'clipboard_write', detail, token,
            lambda: self._clipboard.set_clipboard(text))

    # ============ 进程 ============
    def list_processes(self, keyword=None):
        return self._process.list_processes(keyword)

    def kill_process(self, pid=None, name=None, token=None):
        detail = {'pid': pid if pid is not None else '', 'name': name or ''}

        def execute():
            if pid is not None:
                resolved = self._process.resolve_name_by_pid(pid)
                if resolved is None:
                    if self._guard.armed:
                        self._guard.audit('kill_process', detail, 'block', 'resolve-failed')
                        return ok({'error': '无法确认 pid=%s 对应的进程名（tasklist 反查失败），'
                                            '为防误杀系统进程已拒绝执行。' % pid})
                elif name and str(resolved).strip().lower() != str(name).strip().lower():
                    self._guard.audit('kill_process', detail, 'block', 'name-spoofed')
                    return ok({'error': 'pid=%s 实际进程名为 %s，与传入 name=%s 不一致，'
                                        '已拒绝（防伪造 name 绕过名单）' % (pid, resolved, name)})
                if resolved:
                    detail['name'] = resolved
            return self._process.kill_process(pid, name)

        return self._execute_guarded('kill_process', detail, token, execute)

    # ============ 记忆 ============
    def get_memory(self):
        return self._config.get_memory()

    def append_memory(self, entry_json):
        return self._config.append_memory(entry_json)

    def memory_delete(self, index):
        """实现 v1.8.0 W11：删除 memory.json 数组第 index 条（记忆面板「删除」按钮）。

        边界校验不静默夹逼：index 非整数（bool/None/float/非数字串）或越界
        → {ok:false, error:{code:BAD_PARAMS, message, hint}}；删除成功返回
        {ok:true, remaining:N}。审计 op=memory_delete（成功 decision=deleted，
        拒绝 decision=block + code）——与 guard 家族同一审计口径。"""
        r = self._config.delete_memory(index)
        if r.get('error'):
            self._guard.audit('memory_delete', {'index': str(index)}, 'block',
                              r['error'].get('code', 'BAD_PARAMS'))
            return ok({'ok': False, 'error': r['error']})
        self._guard.audit('memory_delete',
                          {'index': r.get('index'), 'remaining': r.get('remaining')},
                          'ok', 'deleted')
        return ok({'ok': True, 'remaining': r.get('remaining', 0)})

    def set_current_sid(self, sid):
        self._session.set_current_sid(sid)
        return '{"ok":true}'

    # ============ W1 trace_id（审计全链路追踪）============
    def _current_trace(self):
        return self._session.current_trace()

    def trace_new(self):
        """强制开启新 trace（js_api 隐身；前端发送入口可显式调用分界请求）。"""
        return ok({'ok': True, 'trace': self._session.trace_new()})

    # ============ 工作区 ============
    def set_session_ws(self, sid, path, enabled=True):
        return self._workspace.set_session_ws(sid, path, enabled)

    def list_recent_ws(self):
        return self._workspace.list_recent_ws()

    def get_session_ws(self, sid):
        return self._workspace.get_session_ws(sid)

    def get_effective_ws(self):
        return self._workspace.get_effective_ws(self._runtime.get_current_sid())

    def set_ws_enabled(self, sid, enabled):
        return self._workspace.set_ws_enabled(sid, enabled)

    def get_ws_enabled(self, sid):
        return self._workspace.get_ws_enabled(sid)

    def get_ws_state(self, sid):
        return self._workspace.get_ws_state(sid)

    def set_ws_dir(self, path):
        return self._workspace.set_ws_dir(path)

    def delete_session_ws(self, sid):
        return self._workspace.delete_session_ws(sid)

    def pick_folder(self, sid=None):
        return self._workspace.pick_folder(sid)

    def copy_into_ws(self, src, name):
        return self._workspace.copy_into_ws(self._runtime.get_current_sid(), src, name)

    def save_workspace_file(self, name, text):
        return self._workspace.save_workspace_file(self._runtime.get_current_sid(), name, text)

    def get_worklog(self):
        return self._workspace.get_worklog(self._runtime.get_current_sid())

    def append_worklog(self, text):
        return self._workspace.append_worklog(self._runtime.get_current_sid(), text)

    # ============ 系统 ============
    def open_billing(self):
        import webbrowser
        webbrowser.open('https://bigmodel.cn/usercenter/billing')
        return '{"ok":true}'

    def open_app(self, path, token=None):
        path = str(path or '').strip()

        def execute():
            dkey = 'open_app ' + path
            try:
                tip = self._cmds.cmd_deduper.check(dkey)
                if tip:
                    return ok({'info': tip, 'skipped': True})
                import re as _re
                if _re.match(r'^https?://', path):
                    import webbrowser
                    webbrowser.open(path)
                    return ok({'ok': True, 'path': path})
                target = path
                if not os.path.isabs(target):
                    import shutil
                    found = shutil.which(target)
                    if found:
                        target = found
                    else:
                        target = os.path.join(
                            self._workspace.effective_root(self._runtime.get_current_sid()), target)
                os.startfile(target)
                return ok({'ok': True, 'path': target})
            except Exception as e:
                try:
                    self._cmds.cmd_deduper.unmark(dkey)
                except Exception:
                    pass
                return err(e)

        return self._execute_guarded(
            'open_app', {'path': path[:200]}, token, execute, denial='err')

    def open_url(self, url):
        """用默认浏览器打开网页"""
        try:
            import webbrowser
            import re as _re
            u = str(url or '').strip()
            if not u:
                return err('缺少 url 参数')
            if not _re.match(r'^https?://', u):
                u = 'https://' + u
            webbrowser.open(u)
            return ok({'ok': True, 'url': u})
        except Exception as e:
            return err(e)

    def take_screenshot(self, left=None, top=None, width=None, height=None, token=None):
        # 修复 S4②：take_screenshot 补 enforce 挂点（原完全无后端校验）
        return self._execute_guarded(
            'take_screenshot', {}, token,
            lambda: self._screenshot.take_screenshot(left, top, width, height))

    # ============ toolcache ============
    def cache_tool_output(self, content):
        cid = self._toolcache.cache(content)
        if not cid:
            return ok({'ok': False, 'error': '落盘失败'})
        return ok({'ok': True, 'id': cid})

    def read_more(self, cache_id, offset=0, limit=400):
        return self._toolcache.read_more(cache_id, offset, limit)

    # ============ system prompt ============
    def build_system_prompt(self, query=''):
        """query 可选（v1.8.0 W11 记忆注入）：传入当前用户消息 → 注入段按相关度
        补充；缺省 ''=只注入常驻的 rule/preference（显式约束）。默认参数向后
        兼容（契约方法名不变，legacy 调用零差异）。"""
        sid = self._runtime.get_current_sid()
        # 修复（2026-10-18）：工作区关闭时不得注入路径/宣称文件能力——原先无条件注入
        # effective_root，导致快捷条显示「未启用工作区」但 AI 仍答「当前工作区: C:\...」
        # 并声称能操作文件夹（工具被裁了，模型却以为有）。
        # 实现 v1.6 T5①：沙箱边界告知段（防 Agent 误判「沙箱=绝对安全」）。
        # 注：本方法在契约 INTENTIONAL_DELTAS 白名单内（v1.1.1 省 token 先例 +
        # v1.6 T5 沙箱段增量），允许与 legacy 不同；单独断言结构而非逐字节。
        # W0 R19（2026-10-21）：静态段改读 backend/prompts/（版本化+sha256 可追溯），
        # 渲染输出与迁移前逐字节一致（文件内容即原文抽取）；动态段（ws_enabled/
        # local/沙箱尾注）保持代码注入。
        from .domains.providers import prompt_loader
        sandbox_notice = ''
        try:
            sandbox_notice = self._sandbox.prompt_notice() or ''
        except Exception:
            sandbox_notice = ''
        tail = ('\n' + sandbox_notice) if sandbox_notice else ''
        # W11 记忆注入（INTENTIONAL_DELTAS 白名单增量段）：rule/preference 常驻
        # （≤3，用户显式约束优先于一切）+ query 相关 top2 补充；无记忆不加段
        # （输出与 legacy 逐字节一致——契约断言只查结构不查内容的前提）。
        tail += self._memory_inject(str(query or ''))
        if not self._runtime.ws_enabled_for(sid, True):
            text, _ = prompt_loader.render('system-ws-off')
            if text:
                return ok(text + tail)
            return ok(
                '你是 Harbor 内置编程助手。当前**未启用工作区**：不要假设或猜测任何工作区路径，'
                '不要主动列出/创建/修改文件或文件夹；用户要求文件/文件夹操作时，'
                '先请其打开输入框上方的「工作区」快捷条启用工作区。\n'
                '硬规则:\n'
                '1. 文件操作只用工具, 禁止用 Get-Content/Set-Content(后端已强制 UTF-8)。\n'
                '2. 写文件串行: 一次一个 write_file/append_file/search_replace, 等返回成功再写下一个。\n'
                '3. 超长命令输出会截断并给缓存 id, 需要全文用 read_more 分段取。' + tail)
        root = self._workspace.effective_root(sid)
        # v1.1.1 省 token：删掉与工具 description 重复的「系统能力」段（每轮省 ~130 字）
        text, _ = prompt_loader.render('system-base', ws_root=root)
        if text:
            return ok(text + tail)
        return ok(
            '你是 Harbor 内置编程助手。当前工作区: ' + root + '\n'
            '硬规则:\n'
            '1. 文件操作只用工具, 禁止用 Get-Content/Set-Content(后端已强制 UTF-8)。\n'
            '2. 写文件串行: 一次一个 write_file/append_file/search_replace, 等返回成功再写下一个。\n'
            '3. 超长命令输出会截断并给缓存 id, 需要全文用 read_more 分段取。' + tail)

    def _memory_inject(self, query):
        """W11：系统提示词记忆注入段（'' = 无记忆/异常——不影响主流程）。"""
        try:
            from .domains.settings.memory_service import (KINDS, inject_block,
                                                         retrieve)
            items = self._config._memory().list()
            if not items:
                return ''
            standing = [x for x in items
                        if x.get('kind') in ('rule', 'preference')][-3:]
            picked = list(standing)
            if query:
                rel = retrieve(query, items, 2)
                picked += [x for x in rel if x not in picked]
            return ('\n\n' + inject_block(picked)) if picked else ''
        except Exception:
            return ''          # 记忆注入失败不阻塞主提示词

    def memory_retrieve(self, query, limit=5):
        """W11：关键词检索 js_api（前端探活/测试用；items 带 kind）。

        v1.9.0 M2.6：记忆检索事件入账（master-plan 2.6）——query 只落
        sha256[:16]（禁原文——隐私口径与搜索 provenance 一致）。
        """
        r = self._config.memory_retrieve(query, limit)
        if 'error' in r:
            return err(r['error'])
        try:
            import hashlib
            self._guard.audit('memory_retrieve',
                              {'query_sha256': hashlib.sha256(
                                  str(query or '').encode('utf-8')
                              ).hexdigest()[:16],
                               'hits': len(r.get('items') or [])},
                              'read', 'ok')
        except Exception:
            pass                        # 审计失败不阻断检索
        return ok(r)

    def prompt_get(self, prompt_id):
        """W0 R19：前端读版本化提示词（efficiency/compact/plan-generate 等）。

        返回 {id, version, text}；未知 id → err（调用方回落内置默认）。
        """
        from .domains.providers import prompt_loader
        text, version = prompt_loader.load(str(prompt_id or ''))
        if not text:
            return err('未知提示词 id: %s' % str(prompt_id or '')[:40])
        return ok({'ok': True, 'id': str(prompt_id), 'version': version, 'text': text})

    # ============ 工具 schema（唯一数据源 tools_schema.py）============
    def build_tools(self, role='full', include_mcp=False, include_agent=False,
                    is_glm_endpoint=False):
        """v1.3：include_mcp=True 且 role='full' 时尾部追加 MCP 工具定义；
        默认路径（include_mcp=False）输出与 legacy 逐字节一致（契约红线）。

        v1.8.0 C 域：include_agent=True 且 role='full' 时尾部追加 Agent
        工具族（browser_search/browser_open/software_call）。R11 裁决
        （端点过滤）：is_glm_endpoint=True 时 browser_* 定义不进工具集
        （GLM 端点只出现前端追加的内置 web_search，两个搜索工具永不并存）；
        非 GLM 全量追加。include_agent=False 默认路径逐字节不变。
        """
        ws_on = self._runtime.ws_enabled_for(self._runtime.get_current_sid(), True)
        mcp_tools = None
        if include_mcp and role == 'full':
            mcp_tools = self._mcp.tool_schemas()
        return tools_schema.build(role, ws_on, mcp_tools,
                                  include_agent=include_agent,
                                  is_glm_endpoint=bool(is_glm_endpoint))

    # ============ v1.2 安全护栏（R2，_V12_EXTRA 隐身）============
    def guard_get_config(self):
        """护栏配置：三档矩阵 + 保护名单（guard.json 独立存储，不碰 config.json 契约）。"""
        return self._guard.get_config()

    def guard_save_config(self, cfg_json):
        return self._guard.save_config(cfg_json)

    def guard_check(self, op, detail_json='{}'):
        """三档判定：返回 {action: allow/confirm/block, reason?}。前端据 action 弹确认框或阻断。"""
        try:
            detail = json.loads(detail_json or '{}')
            if not isinstance(detail, dict):
                detail = {}
        except Exception:
            detail = {}
        r = self._guard.check(op, detail)
        self._guard.audit(op, detail, r.get('action', 'check'))
        return ok(r)

    def guard_audit(self, op, detail_json='{}', decision='allow'):
        """前端上报用户决策（allow/deny/session-trust），落审计日志。"""
        try:
            detail = json.loads(detail_json or '{}')
            if not isinstance(detail, dict):
                detail = {}
        except Exception:
            detail = {}
        return self._guard.audit(op, detail, 'decision', decision)

    def get_audit_log(self, limit=200, offset=0, verify_all=False):
        """审计日志查看器数据源：倒序返回最新 limit 条（纯本地文件，无网络）。

        v1.9.0 M2.6：增 chain 块 {head 首8位+省略号口径由前端裁, len, valid,
        broken_at?}（窗口内快速校验；verify_all=True 全量重算——大日志 O(n)，
        面板默认关）。entries 每项原样透出（含五维与链字段；旧条目没有，
        前端可选渲染——前向兼容）。
        """
        base_raw = self._guard.read_audit(limit, offset)
        try:
            base = json.loads(base_raw) if isinstance(base_raw, str) else base_raw
        except Exception:
            base = {}
        # 复核修正：原连调两次 read_audit（各全量扫描）——10MB 日志每查面板
        # 读两遍文件，且两次读取间轮转/追加会让 entries 与 chain 口径错位
        head = self._guard.audit_chain_head()
        chain = {'head': (head.get('head') or '')[:8],
                 'head_full': head.get('head') or '',
                 'len': head.get('len', 0),
                 'valid': True}
        entries = base.get('entries') if isinstance(base, dict) else None
        if entries is not None:
            vr = self._guard.audit_chain_verify(entries)
            chain['valid'] = bool(vr.get('ok'))
            if not vr.get('ok'):
                chain['broken_at'] = vr.get('broken_at')
        elif verify_all:
            # 全量模式：读全部条目重算（面板显式开启才走——O(n)）
            all_entries = self._all_audit_entries()
            vr = self._guard.audit_chain_verify(all_entries)
            chain['valid'] = bool(vr.get('ok'))
            if not vr.get('ok'):
                chain['broken_at'] = vr.get('broken_at')
        if isinstance(base, dict):
            base['chain'] = chain
            return json.dumps(base, ensure_ascii=False)
        return ok({'entries': base, 'chain': chain})

    def _all_audit_entries(self):
        """全量审计条目（正序；verify_all 用——大日志 O(n)，面板默认关）。"""
        try:
            path = self._guard._audit_path
            out = []
            with open(path, encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        out.append(json.loads(line))
                    except Exception:
                        continue
            return out
        except Exception:
            return []

    def guard_confirm_token(self, op, detail_json='{}'):
        """修复 S4①：前端确认框「允许」后换取一次性 confirm token（TTL 60s，绑定 op+detail 摘要）。
        携带该 token 调实际 op 才能通过武装后的后端强制执行点。"""
        try:
            detail = json.loads(detail_json or '{}')
            if not isinstance(detail, dict):
                detail = {}
        except Exception:
            detail = {}
        r = self._guard.issue_confirm_token(op, detail)
        if r.get('error'):
            return err(r['error'])
        return ok(r)

    def guard_session_trust(self, op):
        """修复 S4①：登记本会话信任（对应确认框「本会话内不再提示」勾选；切会话自动清空）。"""
        r = self._guard.trust_session(op)
        if r.get('error'):
            return err(r['error'])
        return ok(r)

    # ============ v1.2 自动更新（R1，_V12_EXTRA 隐身）============
    def check_update(self, manifest_url=None):
        return self._update.check(manifest_url)

    def start_update_download(self, url, sha256, version=None):
        return self._update.start_download(url, sha256, version)

    def get_update_progress(self):
        return self._update.get_progress()

    def apply_update(self):
        return self._update.apply()

    # ============ v1.2 多模型（R6，_V12_EXTRA 隐身）============
    def test_provider_endpoint(self, base_url, api_key, model, timeout=15, local=False):
        """OpenAI 兼容端点连通性测试（后端 urllib，规避前端跨域）。

        v1.5：local=True 时走本地分支（免 Key 校验 / 超时默认 30s /
        503 冷启动识别为 loading 态而非失败）——roadmap A5：复用本通道，
        不新建测试通道。"""
        if local:
            return ok(self._local.test_local_endpoint(
                base_url, model, timeout=timeout or 30))
        return self._provider.test_endpoint(base_url, api_key, model, timeout=timeout)

    # ============ v1.5 本地模型（预留接口，_V12_EXTRA 隐身）============
    def local_probe(self, ports=None):
        """A2：本地服务器并行探测（11434/1234/8000/8080，各 2s 超时）。

        返回 {ok, reachable:[{base_url,kind,models,latency_ms}], unreachable, elapsed_ms}。
        ports 可传 JSON 数组字符串（如 '[11434,1234]'）或 None（默认四端口）。
        """
        port_list = None
        if ports:
            try:
                port_list = json.loads(ports) if isinstance(ports, str) else list(ports)
            except Exception:
                return err('ports 需要是 JSON 数组，如 [11434,1234]')
        return ok(self._local.probe(ports=port_list))

    def local_models(self, base_url, api_key=''):
        """A3：补拉模型清单（探测过期时用）。

        api_key 可选（v4「连接与模型」单端点合并）：非空时请求带
        `Authorization: Bearer {key}` —— 云端 OpenAI 兼容端点（DeepSeek/Moonshot/
        通义…）的 /models 清单需鉴权；本地服务器免 Key，单参调用行为不变。

        返回 {ok, base_url, models:[{id, ctx_window, tool_capable, estimated}]}。"""
        return ok(self._local.models(base_url, api_key=api_key))

    def local_readiness(self, base_url, model='', api_key=''):
        """W2：本地模型协同就绪度 8 项评分（deep-research W2）。

        管线：local_models 拉元数据 → readiness 纯函数评分（tag 固定/工具
        能力/schema/迭代上限/路径护栏/结构化错误/日志/keep_alive）→
        verdict=full|partial|cloud + 低分项建议（本地做不了的阶段交云端）。
        返回 {ok, score, max, verdict, items[], suggestions[], model}。
        探测失败 → 按不可达保守评分（verdict=cloud），不抛。
        """
        cfg = {}
        try:
            c = self._config.get_config()
            cfg = {'local_model': c.get('local_model'),
                   'local_ctx_window': c.get('local_ctx_window'),
                   'local_max_iter': c.get('local_max_iter')}
        except Exception:
            pass
        meta = {}
        reachable = None
        try:
            lst = self._local.models(base_url, api_key=api_key)
            reachable = bool(lst.get('ok'))
            want = str(model or cfg.get('local_model') or '')
            for m in lst.get('models') or []:
                if m.get('id') == want:
                    meta = m
                    break
            if not meta and (lst.get('models') or []):
                meta = lst['models'][0]      # 未指定模型取清单首个（当前实际加载的）
        except Exception:
            reachable = False
        info = {'reachable': reachable if reachable is not None else False,
                'keep_alive': True,          # 混合路由组包默认带 keep_alive
                'path_guard': True, 'logging_visible': True,
                'schema_json': True}         # 提示词 schema 约束路径恒可用
        r = local_readiness_score(meta, cfg, info)
        r['model'] = meta.get('id') or str(model or cfg.get('local_model') or '')
        return ok(r)

    # ============ v1.6 HF-P0 本地 CORS 代理（_V12_EXTRA 隐身）============
    def get_local_proxy(self):
        """HF-P0：本地 CORS 代理基址——前端 local 模式 fetch 改打代理，
        X-Harbor-Target 请求头携带真实本地 base_url，代理仅转发回环目标
        （安全硬约束：非回环 403，防开放中继）并补齐 CORS 头 + 流式透传。

        返回 {ok, port, base_url}（base_url = http://127.0.0.1:<port>）；
        端口随机（127.0.0.1:0），Api 装配时已启动（幂等单例）。
        """
        return ok(get_proxy().info())

    # ============ v1.8.0 B 域·浏览器搜索（_V12_EXTRA 隐身）============
    @staticmethod
    def _params_dict(params):
        """params 归一（修复 W7：畸形 JSON 入参不再抛异常穿透 js_api）。

        dict 直通；str 尝试 json.loads（失败 → {}，解析结果非对象 → {}）；
        其余（None 等）→ {}。供 browser_search/software_call 预解析用。
        """
        if isinstance(params, dict):
            return params
        if isinstance(params, str) and params.strip():
            try:
                p = json.loads(params)
            except Exception:
                return {}
            return p if isinstance(p, dict) else {}
        return {}

    def browser_search(self, params=None, token=None):
        """B1：浏览器搜索——检索式构造 → 缓存层（TTL 30min）→ 双通道取数
        （次窗优先/urllib 兜底）→ 解析提取 → 校验缓存 → 审计（op=web_search）。

        请求字段/成功响应/错误码见联调规范 §3.1；检出验证页 fail-fast 返回
        CAPTCHA_REQUIRED（error.takeover_id 交前端 63-search-panel 接管 UI，
        流程 2）。params 可为 dict 或 JSON 字符串（修复 W7：经 _params_dict
        防御性归一，畸形 JSON → {} 走参数校验错误码，不抛异常）。

        v1.8.0 §3.3 护栏挂载（2026-10-21）：web_search 默认 session 档——
        后端 enforce_exec 前置校验（deny/allow_rules/task_grant 先于档位；
        session 档需一次性 confirm token 或会话信任）。token 由前端
        agentGuardCheck 确认框换取（guard_confirm_token）。
        """
        p = self._params_dict(params)
        detail = {'query': str((p or {}).get('query') or '')[:120]}
        return self._execute_guarded(
            'web_search', detail, token,
            lambda: ok(self._search.browser_search(p)),
            denial='structured', rejection_reason=None)

    def browser_open(self, params=None):
        """B2：打开 URL 提取正文（selector 覆盖/密度提取；超长截断落 toolcache，
        full_ref 经 read_more 续读）。审计 op=web_open；契约 §3.1。"""
        return ok(self._search.browser_open(params))

    def search_cache_stats(self):
        """B3：搜索缓存统计 {entries, hits, misses, ttl_minutes, size_kb}。
        读取类不落审计（面板脚注/设置区刷新，同 refreshWsCard 模式）。"""
        return ok(self._search.search_cache_stats())

    def search_status(self, task_id=''):
        """B4：搜索进度回报通道（面板 1s 轮询，规范 §2.4 方案 A）。
        task_id 缺省 = 当前活跃搜索；传入时校验归属（任务 id 或 takeover_id）。
        读取类不落审计（1s 轮询不灌爆审计文件）。"""
        return ok(self._search.search_status(str(task_id or '') or None))

    def browser_takeover(self, takeover_id, action):
        """B5：人工接管续跑/放弃（ux-flows 流程 2 步骤 4a/4b）。
        continue = 复检通过后续跑原管线，返回与 browser_search 同构的成功
        载荷（resumed:true）；仍验证页 → CAPTCHA_REQUIRED（retry ≤3）；
        abort → CAPTCHA_ABORTED。审计 op=search_takeover。"""
        return ok(self._search.browser_takeover(takeover_id, action))

    # ============ v1.8.0 S 域·外部软件调用（实现 v1.8.0 S1，_V12_EXTRA 隐身）============
    def software_list(self, status='all'):
        """S1：外部软件注册表列表（status=all|probed|missing；读取类不落审计）。
        响应 {ok, software:[{name, kind, status, version?, source,
        risk_default, actions:[{name, risk, arg_schema}]}]}——联调规范 §3.2。"""
        return ok(self._software.software_list(status))

    def software_probe(self, name=None):
        """S2：探测（PATH 扫描 + winreg 补探测 + --version 验身份）。
        缺省全部；name 未注册 → BAD_PARAMS（hint 回显可用名）。
        审计 op=software_probe。"""
        return ok(self._software.software_probe(name))

    def software_call(self, params=None, token=None):
        """S3：外部软件调用三形态（CLI 沙箱执行 / GUI 标题核验 / URI 协议）。
        参数按 action.arg_schema 硬校验（SCHEMA_INVALID + violations/example
        自校正回显）；exit_code≠0 仍走成功形状。审计 op=software_call。
        params 可为 dict 或 JSON 字符串（修复 W7：经 _params_dict 防御性归一，
        畸形 JSON → {} 走参数校验错误码，不抛异常穿透 js_api）。

        v1.8.0 §4.4 护栏挂载（2026-10-21）：software_call 默认 session 档
        （read/mutate 会话首次确认）；**dangerous action 由 preset risk 标注，
        在调用点强制 always 档**（高危动作每次确认——§4.3 异常矩阵）。
        token 绑定 software+action 摘要（W4，与签发侧同口径）。"""
        p = self._params_dict(params)
        _sw = str((p or {}).get('software') or '')[:60]
        _act = str((p or {}).get('action') or '')[:40]
        # §4.4：dangerous 动作强制每次确认（force_always 无视 op 档与信任态）
        _risk = self._software.action_risk(_sw, _act)
        detail = {'software': _sw, 'action': _act,
                  'force_always': _risk == 'dangerous'}
        return self._execute_guarded(
            'software_call', detail, token,
            lambda: ok(self._software.software_call(p)),
            denial='structured', rejection_reason=None)

    def _software_save(self, name, entry=None):
        """S 域用户自定义条目 CRUD 之写（私有：经 rpc 通用分发通道暴露——
        契约方法面恰为 software×3（联调规范 §1.2），故不进 _V12_EXTRA、
        也不进 get_api_info 自省面）。entry 为 dict 或 JSON 字符串。"""
        if isinstance(entry, str):
            try:
                entry = json.loads(entry or '{}')
            except Exception as e:
                return err('条目解析失败: %s' % e)
        r = self._software.save(name, entry or {})
        if r.get('error'):
            return err(r['error'])
        return ok(r)

    def _software_remove(self, name):
        """S 域用户自定义条目 CRUD 之删（私有，经 rpc 暴露；预设不可删）。"""
        r = self._software.remove(name)
        if r.get('error'):
            return err(r['error'])
        return ok(r)

    # ============ v1.8.0 H 域·混合路由（实现 v1.8.0 H1，_V12_EXTRA 隐身）============
    def hybrid_get_config(self):
        """H1：读混合路由配置（hybrid.json 独立文件；缺失/损坏返回默认 +
        source=default——首启零配置可用，不报错）。读取类不落审计。"""
        return ok(self._hybrid.get_config())

    def hybrid_save_config(self, cfg_json):
        """H2：保存混合路由配置（部分更新语义；字段级校验失败 → BAD_PARAMS，
        hint 指明字段与合法域）。审计 op=hybrid_save_config。"""
        r = self._hybrid.save_config(cfg_json)
        if r.get('error'):
            field = r.get('field')
            hint = ('字段 %s 合法域：strategy auto|saver|quality；'
                    'local_budget_understand_s/local_budget_validate_s 1-30；'
                    'confidence_gate 0.5-0.95；cost_split_display true/false'
                    % field if field else None)
            e = {'code': 'BAD_PARAMS', 'message': r['error']}
            if hint:
                e['hint'] = hint
            return ok({'ok': False, 'error': e})
        return ok(r)

    # ============ v1.8.5 A 域·任务授权与白名单（实现 v1.8.0 A1，R5 裁决提前插；_V12_EXTRA 隐身）============
    def guard_task_grant(self, scope, ttl_seconds=7200):
        """A1：任务授权（进程内状态，不入 guard.json；TTL 默认 7200s（2h 上限
        口径）+ 空闲 30min 自动收回，先到者生效）。scope 枚举数组；
        ttl 60-86400，越界 → BAD_PARAMS（安全参数不静默夹逼）。"""
        r = self._guard.task_grant(scope, ttl_seconds)
        if r.get('error'):
            return err(r['error'])
        return ok(r)

    def guard_task_revoke(self, grant_id=None):
        """A2：收回授权（缺省=当前；幂等）。审计 op=guard_revoke。"""
        r = self._guard.task_revoke(grant_id)
        if r.get('error'):
            return err(r['error'])
        return ok(r)

    def guard_task_status(self):
        """A3：授权状态（#grantIndicator 倒计时校准源；含 idle_deadline 与
        remaining_s=min(expires_at,idle_deadline)-now，剩余 <600s 黄牌）。
        读取类不落审计。"""
        r = self._guard.task_status()
        if r.get('error'):
            return err(r['error'])
        return ok(r)

    def guard_rule_list(self):
        """A4：白名单规则列表（读取类不落审计）。"""
        r = self._guard.rule_list()
        if r.get('error'):
            return err(r['error'])
        return ok(r)

    def guard_rule_add(self, op_pattern, detail_pattern=None, note=None):
        """A5：添加白名单规则（窄规则优先；deny 清单覆盖的创建即拒 →
        GUARD_DENIED；detail 含写动词 → warn 不阻断）。"""
        r = self._guard.rule_add(op_pattern, detail_pattern, note)
        if r.get('error'):
            return err(r['error'])
        return ok(r)

    def guard_rule_remove(self, rule_id):
        """A6：删除白名单规则（幂等；删除即时生效）。"""
        r = self._guard.rule_remove(rule_id)
        if r.get('error'):
            return err(r['error'])
        return ok(r)

    # ============ v1.8.0 M3 域·Plan-Act 计划执行与检查点（_V12_EXTRA 隐身）============
    def plan_create(self, title, steps, task_id=''):
        """M3-B1：创建计划。steps: [{'text','risk'}] 或 [str]。
        落盘 plans/<task_id>.json；status=planning 待用户批准。"""
        return ok(self._plan.create(title, steps, task_id or None))

    def plan_get(self, task_id):
        """M3-B1：读计划（前端刷新/断线重连用）。"""
        r = self._plan.get(task_id)
        return r if r.get('ok') else err(r.get('error', '计划不存在'))

    def plan_update(self, task_id, status='', step_index=None, step_status=''):
        """M3-B1/B2：改计划状态或步骤状态（批准=status approved；todo 推进=step_status）。"""
        r = self._plan.update(task_id,
                              status=(status or None),
                              step_index=step_index,
                              step_status=(step_status or None))
        return r if r.get('ok') else err(r.get('error', '计划更新失败'))

    def plan_list(self, limit=20):
        """M3：计划清单（最近优先；完成摘要/回滚入口数据源）。"""
        return ok(self._plan.list(limit))

    def checkpoint_create(self, task_id, files, ws_dir=''):
        """M3-D1：任务开始建检查点（git HEAD 锚点 / 非 git 文件快照，上限 200MB/500）。"""
        r = self._checkpoint.create(task_id, files, ws_dir or None)
        return r if r.get('ok') else err(r.get('error', '检查点创建失败'))

    def checkpoint_rollback(self, task_id, ws_dir='', confirm=False):
        """M3-D1：回滚到任务开始前。

        v1.9.0 M2.7 ⑤ 确认后端化：confirm=False 默认拒（CONFIRM_REQUIRED）——
        前端三态对话框「清单→确认」后携带 confirm=true 调用，禁误触。
        """
        r = self._checkpoint.rollback(task_id, ws_dir or None,
                                      confirm=bool(confirm))
        # 修复（对抗性复审）：A4 的 git 失败形状（ok=False + mode/restored/failed）
        # 必须原样透传——err() 会拍平成 {'error': '回滚失败'}，而前端 67-plan-card
        # 只读 restored/failed 数组，空数组会被误判为「回滚完成」假成功 toast。
        if not r.get('ok') and 'failed' in r:
            return ok(r)
        if not r.get('ok'):
            e = r.get('error')
            # 结构化 error（dict：CONFIRM_REQUIRED 等）原样透传，禁拍平
            return ok({'ok': False, 'error': e if isinstance(e, dict)
                       else {'code': 'ROLLBACK_FAILED', 'message': str(e or '回滚失败')}})
        return ok(r)

    def checkpoint_list(self, task_id=''):
        """M3-D1：检查点清单（回滚确认浮层展示「将恢复的文件」）。

        v1.9 契约对齐（2026-10-23 核对发现）：前端契约为无参 （列全部），
        原签名 task_id 必填——改为缺省兼容：缺省列全部（v19 检查点面板/
        checkpoints.json 数据源），传 task_id 时按任务过滤（M3-D1 原语义，
        既有调用方零改动）。"""
        return ok(self._checkpoint.list(task_id))

    def _auto_checkpoint_before_shell(self, op):
        """v1.9.0 M2.7 ④ shell 前后快照：命令执行前自动锚点检查点。

        锚点=空 files + git HEAD（零成本；回滚时差异恢复语义由
        checkpoint_rollback 兜底）。失败禁阻断执行——快照是保险不是门槛。
        """
        try:
            sid = self._runtime.get_current_sid() or 'shell'
            tid = 'auto_%s_%s' % (op, str(sid)[:24])
            self._checkpoint.create(tid, [], ws_dir=None,
                                    label='auto-before-%s' % op, mode='auto')
        except Exception:
            pass

    def clarify_collect(self, questions, answers):
        """M3-C1：批量澄清答案收集（缺项用默认值；返回 [{q, answer}]）。
        纯前端状态机的后端数据源（ux-flows 流程 9）。"""
        return ok(self._plan.clarify_collect(questions, answers))

    # ============ W5A 专家包安全服务（仅包治理，_V12_EXTRA 隐身）============
    def expert_list(self, query=''):
        return ok(self._expert.list(query))

    def expert_get(self, package_id, snapshot_id=''):
        return ok(self._expert.get(package_id, snapshot_id))

    def expert_import_directory(self, path):
        return ok(self._expert.import_directory(path))

    def expert_read_resource(self, snapshot_id, path):
        return ok(self._expert.read_resource(snapshot_id, path))

    def expert_save_preferences(self, prefs_json):
        return ok(self._expert.save_preferences(prefs_json))

    def expert_set_enabled(self, package_id, enabled, snapshot_id=''):
        return ok(self._expert.set_enabled(package_id, enabled, snapshot_id))

    def expert_delete_package(self, package_id):
        return ok(self._expert.delete_package(package_id))

    # ============ v1.6 WebDAV 数据主权（预留接口，_V12_EXTRA 隐身）============
    def webdav_get_config(self):
        """[预留] 读取 WebDAV 配置（webdav.json，DPAPI 解密 password）。"""
        return ok(self._webdav.get_config())

    def webdav_save_config(self, cfg_json):
        """[预留] 保存 WebDAV 配置（校验通过；落盘执行器 v1.6 正式版）。"""
        return ok(self._webdav.save_config(cfg_json))

    def webdav_test(self, cfg_json='{}'):
        """[预留] WebDAV 连通性测试（PROPFIND）。"""
        return ok(self._webdav.test(cfg_json))

    def webdav_export(self):
        """导出备份（config+sessions+audit → MKCOL/PUT/manifest；用已存配置）。"""
        return ok(self._webdav.export('{}'))

    def webdav_restore(self, payload_json):
        """从备份恢复（下载 + sha256 对拍 + 三方冲突裁决 + 按策略落盘；用已存配置）。"""
        return ok(self._webdav.restore(payload_json, '{}'))

    # ============ v1.3 MCP（R1-R6，_V12_EXTRA 隐身）============
    @staticmethod
    def _mcp_parse_args(arguments_json):
        """arguments_json → dict（非法 JSON 按空对象，不抛）。"""
        try:
            args = json.loads(arguments_json or '{}')
        except Exception:
            args = {}
        return args if isinstance(args, dict) else {}

    def mcp_list_servers(self):
        """服务器列表（状态灯/工具数/开关数据源）。"""
        return ok({'ok': True, 'servers': self._mcp.list_servers()})

    def mcp_save_server(self, name, config_json):
        """保存服务器配置。enabled=true 时：结构校验 → DPAPI 加密 → 预检测 → 测试连接，
        任一步失败返回 {error: 人话} 且 enabled 不落盘（开关回弹由前端呈现）。"""
        try:
            cfg = json.loads(config_json or '{}')
        except Exception as e:
            return err('配置解析失败: %s' % e)
        if not isinstance(cfg, dict):
            return err('配置必须是 JSON 对象')
        name = str(name or '').strip()
        if not name:
            return err('服务器名称不能为空')
        want_enable = bool(cfg.get('enabled'))
        r = self._mcp.save_server(name, cfg, activate=want_enable)
        if r.get('error'):
            return err(r['error'])
        if not want_enable:
            return ok({'ok': True, 'name': name})
        t = self._mcp.test_server(name)
        if t.get('error'):
            # 测试连接失败 → 回弹 enabled=false（配置已保存，保持停用）
            revert = dict(cfg)
            revert['enabled'] = False
            self._mcp.save_server(name, revert, activate=False)
            return err(t['error'])
        return ok({'ok': True, 'name': name, 'tools': t.get('tools') or []})

    def mcp_delete_server(self, name):
        r = self._mcp_cfg.delete_server(name)
        if r.get('error'):
            return err(r['error'])
        self._mcp.forget(name)
        return ok({'ok': True})

    def mcp_test_server(self, name):
        r = self._mcp.test_server(name)
        if r.get('error'):
            return err(r['error'])
        return ok(r)

    def mcp_get_server_detail(self, name):
        r = self._mcp.get_server_detail(name)
        if r.get('error'):
            return err(r['error'])
        return ok(r)

    def mcp_set_tool_tier(self, server, tool, tier):
        r = self._mcp_cfg.set_tool_tier(server, tool, tier)
        if r.get('error'):
            return err(r['error'])
        return ok({'ok': True})

    def mcp_check_tool(self, server, tool, arguments_json='{}'):
        """护栏定档：{action: allow/confirm/block, tier, tier_source, reason?}；落审计 check。"""
        return ok(self._mcp.check_tool(server, tool, self._mcp_parse_args(arguments_json)))

    def mcp_call_tool(self, server, tool, arguments_json='{}', decision='deny', token=None):
        """执行 MCP 工具（decision 默认 deny；后端二次 enforce + 审计）。
        返回 {ok, output} / {error} / {info, skipped}（用户拒绝/不可用拦截）。
        语义：'deny'=用户拒绝；''/未知=缺失（按 §3.5 矩阵走 enforce 拒绝）。
        修复 S4①：武装后 always/session 档还须一次性 token 或后端会话信任。"""
        r = self._mcp.call_tool(server, tool, self._mcp_parse_args(arguments_json),
                                decision if decision is not None else 'deny', token=token)
        if r.get('skipped'):
            return ok({'info': r.get('info') or '', 'skipped': True})
        if r.get('error') is not None:
            return err(r['error'])
        return ok({'ok': True, 'output': r.get('output') or ''})

    def mcp_import_claude(self, config_json):
        """导入 claude_desktop_config.json：{ok, imported, skipped:[{name, reason}], total}。"""
        r = self._mcp_cfg.import_claude(config_json)
        if r.get('error'):
            return err(r['error'])
        return ok(r)

    def mcp_shutdown(self):
        """关停全部 MCP 传输（main.py atexit 注册 + 测试用）。"""
        return ok(self._mcp.shutdown())

    # ---- v1.6 T12 MCP resources（text 优先；blob 截断落盘；订阅持久化）----
    def mcp_list_resources(self, server):
        """resources/list：{ok, resources:[{uri,name,mimeType,...}], supported}。
        服务器不支持资源（-32601）→ supported=False + 空列表（不算错误）。"""
        r = self._mcp.list_resources(server)
        if r.get('error'):
            return err(r['error'])
        return ok({'ok': True, 'resources': r.get('resources') or [],
                   'supported': r.get('supported', True)})

    def mcp_read_resource(self, server, uri):
        """resources/read：text 类直接返回文本；blob 类落盘 toolcache 并给
        cache_id（read_more 分段取）。全程审计（op=mcp_resource）。"""
        r = self._mcp.read_resource(server, uri)
        if r.get('error'):
            return err(r['error'])
        return ok(r)

    def mcp_save_subscriptions(self, server, uris_json='[]'):
        """保存资源订阅（mcp_servers.json 新可选键 resourceSubs；Claude 兼容忽略）。"""
        r = self._mcp.save_subscriptions(server, uris_json)
        if r.get('error'):
            return err(r['error'])
        return ok(r)
