# -*- coding: utf-8 -*-
"""v1.9.0 M1.3 · 平台服务抽象（PlatformServices + 七接口签名）。

设计文档 §A3.2：M6 macOS 实现对映；本期仅 Windows 实现（platform/win.py）。
七接口（Secrets/Sandbox/Screen/Trash/Paths/Process/Notify）全部为 ABC——
各方法 docstring 即返回契约（前端与 M6 实现对照的唯一事实源）。

降级永不阻断（B8.9）：七接口实现一律返回结构化载荷，禁异常穿透——
Notify 明示「永不抛」；Secrets 不可用 → SECRETS_UNAVAILABLE；Sandbox
不可用 → SANDBOX_UNAVAILABLE（fail-closed 语义由载荷承载）。
"""
from abc import ABC, abstractmethod


class PlatformServices(ABC):
    """平台服务抽象（M6 macOS 实现对映；本期仅 win）。"""

    name = 'abstract'   # 'win' | 'mac'

    @abstractmethod
    def secrets(self):
        """→ Secrets（系统钥匙串）。"""

    @abstractmethod
    def sandbox(self):
        """→ Sandbox（Job Object 进程隔离）。"""

    @abstractmethod
    def screen(self):
        """→ Screen（截屏）。"""

    @abstractmethod
    def trash(self):
        """→ Trash（回收站/删除）。"""

    @abstractmethod
    def paths(self):
        """→ Paths（目录口径）。"""

    @abstractmethod
    def process(self):
        """→ Process（进程枚举/强杀）。"""

    @abstractmethod
    def notify(self):
        """→ Notify（系统通知）。"""


class Secrets(ABC):
    """系统钥匙串（Win DPAPI / mac Keychain M6.1）。

    存储落 ``~/.glm-chat/platform/secrets.json``（值均加密；config.json
    零污染铁律——独立文件）。
    """

    @abstractmethod
    def set(self, service, account, secret):
        """写入 → ``{ok}`` | ``{ok: False, error}``（如 SECRETS_UNAVAILABLE）。"""

    @abstractmethod
    def get(self, service, account):
        """读取 → ``{ok, secret}`` | ``{ok: False, error: 'NOT_FOUND'}``。"""

    @abstractmethod
    def delete(self, service, account):
        """删除 → ``{ok, removed}``（幂等：不存在 removed=False 不报错）。"""


class Sandbox(ABC):
    """进程沙箱（Win Job Object；委托 sandbox_service）。"""

    @abstractmethod
    def available(self):
        """当前平台沙箱是否可用 → bool。"""

    @abstractmethod
    def limits_for(self, command_class):
        """命令类别 → 限制字典；None = 不沙箱（disabled 或该类别 off）。

        委托 sandbox_service.SandboxService.limits_for。
        """

    @abstractmethod
    def run(self, args, shell=False, cwd=None, timeout=60, limits=None):
        """沙箱内执行 → ``{ok, returncode, stdout, stderr, timed_out, sandboxed}``
        或 ``{ok: False, error: 'SANDBOX_UNAVAILABLE', message}``（禁抛）。

        委托 sandbox_service.run_in_sandbox。
        """


class Screen(ABC):
    """截屏（Win PIL.ImageGrab；委托 screenshot_service）。"""

    @abstractmethod
    def capture(self, left=None, top=None, width=None, height=None):
        """截屏（可传区域）→ ``{ok, path, size?}`` | ``{ok: False, error}``。

        落 screenshots/ 目录（paths.SCREENSHOTS_DIR）。
        """


class Trash(ABC):
    """回收站（Win send2trash；缺失 → 永久删除 + 警示）。"""

    @abstractmethod
    def trash(self, path):
        """删除路径 → ``{ok, path, mode: 'recycle'|'delete', warning?}``。

        与 file_service.delete_path(recycle=True) 同口径：send2trash 缺失
        或回收站故障 → mode='delete' + warning（禁静默永久删）。
        """


class Paths(ABC):
    """目录口径（Win ~/.glm-chat；mac M6.7 ~/Library/Application Support/Harbor）。"""

    @abstractmethod
    def config_dir(self):
        """配置目录（Win: ~/.glm-chat）。"""

    @abstractmethod
    def data_dir(self):
        """数据目录（Harbor 口径：与配置同目录）。"""

    @abstractmethod
    def profiles_dir(self):
        """浏览器 profile 根（paths.BROWSER_PROFILE_DIR；与主窗 webview_data 隔离）。"""


class Process(ABC):
    """进程管理（Win tasklist/taskkill；委托 process_service）。"""

    @abstractmethod
    def list(self, keyword=''):
        """进程枚举（按内存降序）→ list[str]（展示行；失败 → []）。"""

    @abstractmethod
    def kill(self, pid=None, name=None):
        """结束进程 → 委托 kill_process 载荷（含保护名单拒绝）。"""

    @abstractmethod
    def resolve_name(self, pid):
        """pid → 进程名；查不到/失败 → None。"""


class Notify(ABC):
    """系统通知（Win PowerShell WinRT toast；best-effort）。"""

    @abstractmethod
    def notify(self, title, message):
        """弹系统通知 → ``{ok}`` | ``{ok: False, error: 'NOTIFY_UNAVAILABLE'}``。

        永不抛（B8.9：通知失败禁阻断主流程）；超时 3s、禁阻塞启动。
        """
