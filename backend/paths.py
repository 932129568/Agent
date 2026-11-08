# -*- coding: utf-8 -*-
"""路径常量与 PyInstaller frozen 适配。

从 legacy main.py L23-26/L133-134/L1239-1244 原样搬迁。
所有路径在 import 时基于 expanduser('~') 计算（与 legacy 行为一致），
测试通过重定向 USERPROFILE/HOME 环境变量隔离。
"""
import os
import sys

CONFIG_DIR_NAME = '.glm-chat'

CONFIG_DIR = os.path.join(os.path.expanduser('~'), CONFIG_DIR_NAME)
CONFIG_PATH = os.path.join(CONFIG_DIR, 'config.json')
SESSIONS_PATH = os.path.join(CONFIG_DIR, 'sessions.json')
# v1.8.0 历史自选存放（2026-10-21 用户需求）：history.json 独立文件存用户选的
# 目录（config.json 零污染铁律——契约测试比对 config.json）。空/缺失 = 默认
# SESSIONS_PATH（~/.glm-chat/sessions.json）。
HISTORY_FILE = os.path.join(CONFIG_DIR, 'history.json')
MEMORY_PATH = os.path.join(CONFIG_DIR, 'memory.json')
# R38（记忆模块 v2 接入）：SQLite 四层记忆库（R36 开发文档 §8.1；memory.json
# 为 legacy 契约存储保持不动，本库为渐进增强层；迁移器一次性导入 legacy 条目）。
MEMORY_DB_PATH = os.path.join(CONFIG_DIR, 'memory.db')
SESSION_WS_FILE = os.path.join(CONFIG_DIR, 'session_ws.json')
RECENT_WS_FILE = os.path.join(CONFIG_DIR, 'recent_ws.json')
WS_ENABLED_FILE = os.path.join(CONFIG_DIR, 'ws_enabled.json')
# v1.3 MCP：服务器配置独立文件（Claude 兼容结构；不碰 config.json——契约红线）
MCP_SERVERS_FILE = os.path.join(CONFIG_DIR, 'mcp_servers.json')
TOOLCACHE_DIR = os.path.join(CONFIG_DIR, 'toolcache')
SCREENSHOTS_DIR = os.path.join(CONFIG_DIR, 'screenshots')
LOG_DIR = os.path.join(CONFIG_DIR, 'logs')
API_METHODS_LOG = os.path.join(CONFIG_DIR, 'api_methods.log')
WEBVIEW_DATA_DIR = os.path.join(CONFIG_DIR, 'webview_data')
# v1.9.0 新增路径常量（config.json 零污染铁律：新配置一律 ~/.glm-chat/*.json）
BROWSER_SESSIONS_FILE = os.path.join(CONFIG_DIR, 'browser_sessions.json')   # M3 会话池（本期占位声明）
READER_FILE          = os.path.join(CONFIG_DIR, 'reader.json')              # M2.1 读取器配置
AUDIT_CHAIN_FILE     = os.path.join(CONFIG_DIR, 'audit_chain.json')         # M2.6 哈希链 head/len
CHECKPOINTS_FILE     = os.path.join(CONFIG_DIR, 'checkpoints.json')         # M2.7 清单投影（权威在 checkpoints/<tid>/manifest.json）
PLATFORM_DIR         = os.path.join(CONFIG_DIR, 'platform')                 # M1.4 secrets.json 等
BROWSER_PROFILE_DIR  = os.path.join(CONFIG_DIR, 'browser_profile')          # M3 浏览器 profile（与主窗 webview_data 隔离）
MODEL_PREFS_FILE     = os.path.join(CONFIG_DIR, 'model_prefs.json')         # 复核批：推理偏好（思考强度/上下文窗口）
# W5A 专家包：独立注册表与 managed snapshot，不污染 config.json。
EXPERTS_FILE = os.path.join(CONFIG_DIR, 'experts.json')
EXPERTS_DIR = os.path.join(CONFIG_DIR, 'experts')
EXPERT_SNAPSHOTS_DIR = os.path.join(EXPERTS_DIR, 'snapshots')
EXPERT_STAGING_DIR = os.path.join(EXPERTS_DIR, 'staging')


def builtin_experts_dir():
    """Return the read-only builtin WorkBuddy expert assets bundled with Harbor."""
    if getattr(sys, 'frozen', False):
        base = getattr(sys, '_MEIPASS', None)
        if not base:
            raise RuntimeError('frozen build is missing sys._MEIPASS')
        return os.path.join(base, 'backend', 'experts_builtin')
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        'backend', 'experts_builtin')


def ensure_dirs():
    """创建运行必需目录（legacy: 模块级 makedirs webview_data + Api.__init__ 建 config_dir）。"""
    os.makedirs(CONFIG_DIR, exist_ok=True)
    os.makedirs(WEBVIEW_DATA_DIR, exist_ok=True)
    # v1.9.0 M1.4：platform/secrets.json 落盘前置（secrets 写入前目录必须在位）
    os.makedirs(PLATFORM_DIR, exist_ok=True)


def setup_webview_env():
    """固定 WebView2 用户数据目录（legacy L133-135：import 即执行；这里改为入口显式调用，
    使 `import backend` 无副作用、可在无 GUI 环境使用）。

    复核批（2026-10-24 真机实证）：WebView2 默认把「无交互窗口」按后台页处置——
    rAF 停止派发、定时器降频、渲染面挂起（流式生成冻结，直到下一次输入强制
    重绘）。对话应用必须常驻前台渲染，显式关闭三类后台化行为。"""
    os.environ['WEBVIEW2_USER_DATA_FOLDER'] = WEBVIEW_DATA_DIR
    os.environ['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = (
        '--disable-backgrounding-occluded-windows '
        '--disable-renderer-backgrounding '
        '--disable-background-timer-throttling')


def get_html_path():
    """PyInstaller onefile 下 html 在 sys._MEIPASS，开发时在 main.py 同目录。"""
    if getattr(sys, 'frozen', False):
        base = sys._MEIPASS
    else:
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, 'harbor.html')
