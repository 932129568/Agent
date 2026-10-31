# -*- coding: utf-8 -*-
"""Explicit Harbor composition root and process-level service ownership."""
import threading

from .. import paths
from ..application.native_ui import NativeUiDispatcher
from ..application.operation import OperationCoordinator
from ..application.registry import TaskRegistry
from ..application.scheduler import DomainScheduler
from ..application.session import SessionCoordinator
from ..domains.integrations.browser.driver import BrowserService
from ..domains.integrations.browser.service import SearchService
from ..domains.integrations.mcp.mcp_config_service import McpConfigService
from ..domains.integrations.mcp.mcp_service import McpService
from ..domains.expert.builtin_importer import WorkBuddyBuiltinImporter
from ..domains.expert.service import ExpertPackageService
from ..domains.integrations.software_service import SoftwareService
from ..domains.integrations.update_service import UpdateService
from ..domains.integrations.webdav_service import WebDAVService
from ..domains.integrations import update_service as update_module
from ..domains.planning.checkpoint_service import CheckpointService
from ..domains.planning.plan_service import PlanService
from ..domains.providers.hybrid_router import HybridRouter
from ..domains.providers.local_model_service import LocalModelService
from ..domains.providers.local_proxy import get_proxy, shutdown_proxy
from ..domains.providers.provider_service import ProviderService
from ..domains.providers.search_reader import SearchReader
from ..domains.security.guard_service import GuardService
from ..domains.settings.config_service import ConfigService
from ..domains.settings.model_prefs_service import ModelPrefsService
from ..domains.workspace.clipboard_service import ClipboardService
from ..domains.workspace.cmd_service import CmdService
from ..domains.workspace.file_service import FileService
from ..domains.workspace.process_service import ProcessService
from ..domains.workspace.sandbox_service import SandboxService
from ..domains.workspace.screenshot_service import ScreenshotService
from ..domains.workspace.toolcache_service import ToolcacheService
from ..domains.workspace.workspace_service import WorkspaceService
from ..logging_setup import get_logger
from ..runtime import RuntimeState

# Builtin WorkBuddy experts are read-only application assets. Import them once
# per process; repeated Api()/ServiceContainer.build() calls in tests must not
# reconvert and re-stage the same eight packages.
_BUILTIN_EXPERTS_READY = False


class ServiceContainer:
    """Build each service once and expose a private assembly registry to Api."""

    SERVICE_NAMES = (
        'runtime', 'config', 'workspace', 'toolcache', 'guard', 'update',
        'provider', 'files', 'cmds', 'clipboard', 'process', 'screenshot',
        'mcp_config', 'mcp', 'local', 'webdav', 'sandbox', 'software',
        'hybrid', 'reader', 'model_prefs', 'checkpoints', 'search', 'driver',
        'plans', 'session', 'operation', 'task_registry', 'scheduler', 'native_ui', 'expert',
    )
    API_ALIASES = {
        '_runtime': 'runtime', '_config': 'config', '_workspace': 'workspace',
        '_toolcache': 'toolcache', '_guard': 'guard', '_update': 'update',
        '_provider': 'provider', '_files': 'files', '_cmds': 'cmds',
        '_clipboard': 'clipboard', '_process': 'process', '_screenshot': 'screenshot',
        '_mcp_cfg': 'mcp_config', '_mcp': 'mcp', '_local': 'local',
        '_webdav': 'webdav', '_sandbox': 'sandbox', '_software': 'software',
        '_hybrid': 'hybrid', '_reader': 'reader', '_model_prefs': 'model_prefs',
        '_checkpoint': 'checkpoints', '_search': 'search', '_driver': 'driver',
        '_plan': 'plans', '_session': 'session', '_operation': 'operation',
        '_registry': 'task_registry', '_scheduler': 'scheduler', '_native_ui': 'native_ui',
        '_expert': 'expert',
    }

    def __init__(self):
        self._log = get_logger()
        self._shutdown = False

    @classmethod
    def build(cls):
        container = cls()
        container._assemble()
        return container

    def _assemble(self):
        """Preserve the legacy construction order without involving Api."""
        paths.ensure_dirs()
        self.runtime = RuntimeState()
        self.config = ConfigService()
        self.workspace = WorkspaceService(self.runtime, self.config)
        self.toolcache = ToolcacheService()
        self.guard = GuardService()
        self.update = UpdateService()
        self.provider = ProviderService()
        self.files = FileService(self.runtime, self.workspace)
        self.cmds = CmdService(self.workspace, self.toolcache)
        self.clipboard = ClipboardService()
        self.process = ProcessService()
        self.screenshot = ScreenshotService()
        self.mcp_config = McpConfigService()
        self.mcp = McpService(self.mcp_config, self.guard, self.toolcache)
        self.session = SessionCoordinator(self.runtime, self.guard, self.mcp)
        self.operation = OperationCoordinator(self.runtime, self.guard)
        self.task_registry = TaskRegistry()
        self.scheduler = DomainScheduler(self.task_registry)
        self.native_ui = NativeUiDispatcher()
        self.guard.set_trace_hook(self.session.current_trace)
        self.local = LocalModelService()
        try:
            get_proxy().ensure_running()
        except Exception as error:
            self._log.warning('本地 CORS 代理启动失败（本地端点将回落直连）: %r', error)
        self.webdav = WebDAVService()
        self.sandbox = SandboxService()
        self.software = SoftwareService(
            guard=self.guard, sandbox=self.sandbox,
            ws_root=lambda: self.workspace.effective_root(self.runtime.get_current_sid()))
        self.hybrid = HybridRouter()
        self.reader = SearchReader(router=self.hybrid)
        self.model_prefs = ModelPrefsService()
        self.checkpoints = CheckpointService()
        self.expert = ExpertPackageService()
        global _BUILTIN_EXPERTS_READY
        if not _BUILTIN_EXPERTS_READY:
            _BUILTIN_EXPERTS_READY = True
            try:
                builtin_experts = WorkBuddyBuiltinImporter(self.expert).import_all()
                if not builtin_experts.get('ok'):
                    self._log.warning('内置专家包导入不完整: %r', builtin_experts)
            except Exception as error:
                self._log.warning('内置专家包导入失败: %r', error)
        self.guard.set_identity_hook(
            lambda: {'sid': str(self.runtime.get_current_sid() or ''), 'principal': 'user'})
        self.search = SearchService(guard=self.guard, reader=self.reader,
                                    dispatcher=self.native_ui)

        def driver_open_external(url):
            try:
                import webbrowser
                webbrowser.open(str(url))
            except Exception:
                pass
            try:
                self.guard.audit('browser_external', {'url': str(url)[:200]},
                                 'decision', 'allow')
            except Exception:
                pass

        self.driver = BrowserService(on_external=driver_open_external,
                                     dispatcher=self.native_ui)
        self.plans = PlanService(checkpoint=self.checkpoints)
        self.scheduler.register_domain('settings', lambda: self.config)
        self._export_paths = set()
        self._export_paths_lock = threading.Lock()
        update_module.set_before_exit_hook(self.mcp.shutdown)

    def api_aliases(self):
        """Return internal attribute aliases, never a public js_api payload."""
        return {alias: getattr(self, name) for alias, name in self.API_ALIASES.items()}

    def registry(self):
        """Return the single-container inventory used by architecture checks."""
        return {name: getattr(self, name) for name in self.SERVICE_NAMES}

    def shutdown(self):
        """Close resources in the previous atexit reverse-registration order."""
        if self._shutdown:
            return {'ok': True, 'errors': []}
        self._shutdown = True
        errors = []
        for name, closer in (
            ('scheduler', self.scheduler.close),
            ('native_ui', self.native_ui.shutdown),
            ('search', self.search.shutdown),
            ('local_proxy', shutdown_proxy),
            ('driver', self.driver.shutdown),
            ('mcp', self.mcp.shutdown),
        ):
            try:
                result = closer()
                if name in {'scheduler', 'native_ui'} and result.get('status') != 'OK':
                    errors.append({'service': name, 'error': result})
            except Exception as error:
                errors.append({'service': name, 'error': str(error)})
        return {'ok': not errors, 'errors': errors}
