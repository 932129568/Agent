# -*- coding: utf-8 -*-
"""工具 schema 唯一数据源（legacy Api.build_tools L1083-1237 逐字搬迁）。

内容一字未改——AI 已适配 v1.0.0 措辞，改文案 = 行为漂移。
ws_on 由调用方（Api 门面）从 RuntimeState 取后传入，本模块无状态、可单测。

v1.3：新增可选参数 mcp_tools——仅当 role=='full' 且 mcp_tools 非空时在列表尾部追加
（mcp_tools=None 默认 → 与 legacy 逐字节一致，契约差分测试天然通过）。

v1.8.0 C 域（实现 v1.8.0 C1）：新增可选参数 include_agent（+ is_glm_endpoint 端点判据）——
include_agent=True 且 role=='full' 时追加 Agent 工具族（browser_search /
browser_open / software_call 三条定义；B 域 5 个 js_api 中面向模型侧的即
此三条——面板面 software_list/probe 不进工具集）。R11 裁决（端点过滤）：
GLM 端点（is_glm_endpoint=True）时 browser_* 定义不进工具集（云端原生
web_search 由前端按既有口径追加，两个搜索工具永不并存）；非 GLM 全量追加。
默认路径（include_agent=False）输出逐字节不变（契约红线）。
"""

import json

_S_READ_MORE = {'type': 'function', 'function': {'name': 'read_more',
    'description': '分页读取之前被截断的工具输出全文',
    'parameters': {'type': 'object', 'properties': {
        'cache_id': {'type': 'string'}, 'offset': {'type': 'integer'},
        'limit': {'type': 'integer'}}, 'required': ['cache_id']}}}

# ---- v1.8.0 C 域：Agent 工具族（include_agent=True 时追加；R11 端点过滤见 build）----
# browser_search / browser_open 请求字段照联调规范 §3.1；software_call 照 §3.2。
_AGENT_BROWSER_SEARCH = {'type': 'function', 'function': {'name': 'browser_search',
    # 三段式对齐 AGENTS.md §3（M5.9 lint 口径=全 AGENT_TOOLS 恰 2 竖线；Round 6 补齐
    # v1.8 三工具——增量面不受 legacy 逐字节锁定，仅名单锁定）
    'description': '需要联网搜索资料或查最新信息时|受控次窗搜索+正文提取+缓存,遇验证页返回 CAPTCHA_REQUIRED 等待人工|已知网址直接抓取用 browser_open,GLM 端点走云端原生 web_search',
    'parameters': {'type': 'object', 'properties': {
        'query': {'type': 'string'}, 'engine': {'type': 'string'},
        'site': {'type': 'string'}, 'filetype': {'type': 'string'},
        'time_range': {'type': 'string'}, 'lang': {'type': 'string'},
        'max_results': {'type': 'integer'}, 'extract': {'type': 'string'}},
        'required': ['query']}}}

_AGENT_BROWSER_OPEN = {'type': 'function', 'function': {'name': 'browser_open',
    'description': '已知URL要读取网页正文时|readability/selector 提取正文,超长自动截断落盘|要搜索发现页面用 browser_search,要点击/填表等交互用 browser_navigate 系',
    'parameters': {'type': 'object', 'properties': {
        'url': {'type': 'string'}, 'selector': {'type': 'string'},
        'max_chars': {'type': 'integer'}}, 'required': ['url']}}}

_AGENT_SOFTWARE_CALL = {'type': 'function', 'function': {'name': 'software_call',
    'description': '要用已注册的外部软件能力时(git/ffmpeg/7z/python/node 等)|action 按注册表执行,参数不符返回 SCHEMA_INVALID+修正示例|普通文件读写用内置文件工具,任意命令用 run_command',
    'parameters': {'type': 'object', 'properties': {
        'software': {'type': 'string'}, 'action': {'type': 'string'},
        'args': {'type': 'object'}, 'timeout': {'type': 'integer'},
        'source': {'type': 'string'}},
        'required': ['software', 'action']}}}

# ---- v1.9.0 M5.1/M5.3：浏览器驱动六原语（include_agent=True 时追加）----
# 描述三段式（M5.9 R44：触发|语义|排除，竖线分隔）；schema strict
# （additionalProperties:false + enum + required——M5.3，只对 v1.9 新工具，
# 既有 v1.8 工具契约锁定不动）。R11 端点过滤（startswith('browser_')）
# 天然覆盖新工具：GLM 端点不进工具集。
_AGENT_BROWSER_DRIVER = (
    {'type': 'function', 'function': {'name': 'browser_navigate',
        'description': '导航浏览器会话到URL并等待就绪|需要渲染页面或后续交互前的定位步骤|纯文本抓取用browser_open,仅支持http(s)公网页面',
        'parameters': {'type': 'object', 'properties': {
            'url': {'type': 'string'}, 'wait_selector': {'type': 'string'},
            'timeout': {'type': 'integer'},
            'mode': {'type': 'string', 'enum': ['hidden', 'visible']}},
            'required': ['url'], 'additionalProperties': False}}},
    {'type': 'function', 'function': {'name': 'browser_extract',
        'description': '提取当前会话页面正文|导航后取结构化内容|未导航时先browser_navigate',
        'parameters': {'type': 'object', 'properties': {
            'selector': {'type': 'string'},
            'mode': {'type': 'string', 'enum': ['markdown', 'text', 'links']}},
            'required': [], 'additionalProperties': False}}},
    {'type': 'function', 'function': {'name': 'browser_snapshot',
        'description': '获取当前页面语义快照(角色/名称/状态修剪树)|点击/填表前定位元素比截图省token且标识稳定|纯读正文用browser_extract,视觉取证用browser_screenshot',
        'parameters': {'type': 'object', 'properties': {
            'selector': {'type': 'string'},
            'max_chars': {'type': 'integer'}},
            'required': [], 'additionalProperties': False}}},
    {'type': 'function', 'function': {'name': 'browser_click',
        'description': '点击页面元素(需确认)|selector或可见文本定位,拒绝视口外/不可见元素|敏感确认弹窗类页面交给用户接管',
        'parameters': {'type': 'object', 'properties': {
            'target': {'type': 'string'}},
            'required': ['target'], 'additionalProperties': False}}},
    {'type': 'function', 'function': {'name': 'browser_fill',
        'description': '填充表单字段(需确认)|selector定位输入框并填入文本|密码/文件字段拒绝填充',
        'parameters': {'type': 'object', 'properties': {
            'selector': {'type': 'string'}, 'text': {'type': 'string'}},
            'required': ['selector', 'text'], 'additionalProperties': False}}},
    {'type': 'function', 'function': {'name': 'browser_screenshot',
        'description': '截取当前会话页面|交互后取证或视觉复核|全屏截图用take_screenshot',
        'parameters': {'type': 'object', 'properties': {
            'full_page': {'type': 'boolean'}},
            'required': [], 'additionalProperties': False}}},
    {'type': 'function', 'function': {'name': 'browser_close',
        'description': '关闭浏览器会话释放资源|任务完成或页面不再需要时|活跃会话不必要关闭',
        'parameters': {'type': 'object', 'properties': {
            'session_id': {'type': 'string'}},
            'required': [], 'additionalProperties': False}}},
)

# ---- R42：记忆工具族（memory_write / memory_search）——2026 前沿共识「记忆是
# 模型主动读写的工具而非被动注入的库」（F2d/轮9：Claude memory tool+context
# editing 组合较基线 +39%）。strict schema + 三段式（M5.3/M5.9 红线）；
# 非 browser_ 前缀 → R11 GLM 端点过滤天然放行（记忆与端点无关）。
_AGENT_MEMORY_TOOLS = (
    {'type': 'function', 'function': {'name': 'memory_write',
        'description': '需要长期记住的用户事实/偏好/项目约束时|写入长期记忆库(门控校验,敏感字段拒写,重复返回去重结果)|临时任务状态用计划卡,单次会话内容不要写入',
        'parameters': {'type': 'object', 'properties': {
            'text': {'type': 'string', 'description': '一句话事实（含主语与具体值）'},
            'kind': {'type': 'string', 'enum': ['fact', 'preference', 'rule']}},
            'required': ['text'], 'additionalProperties': False}}},
    {'type': 'function', 'function': {'name': 'memory_search',
        'description': '回答前怀疑长期记忆里有相关事实/偏好/约束时|按相关度检索记忆库,返回带来源/置信度/命中时间的条目|系统提示已注入的记忆不必重复检索,会话内近期上下文直接引用',
        'parameters': {'type': 'object', 'properties': {
            'query': {'type': 'string'},
            'limit': {'type': 'integer'}},
            'required': ['query'], 'additionalProperties': False}}},
)

# ---- R44（F2d 改进⑤）：MCP 工具面渐进披露——工具数超阈值时不下发全部
# mcp__ 定义（10-30% 上下文吞噬源，调研轮 29），改下发 mcp_search 元工具；
# 模型检索到条目（含 inputSchema 全文）后直接按净化函数名调用 mcp__xxx
# （执行层 mcpExecTool→mcp_call_tool 与 schema 面解耦，动态名天然支持）。
MCP_FOLD_THRESHOLD = 25

_AGENT_MCP_SEARCH = {'type': 'function', 'function': {'name': 'mcp_search',
    'description': '需要调用MCP服务器工具但工具面只有本检索器时|按相关度检索全部MCP工具,返回含参数schema的完整条目,随后直接按name调用|工具面已直接列出的mcp__工具不必检索',
    'parameters': {'type': 'object', 'properties': {
        'query': {'type': 'string'},
        'limit': {'type': 'integer'}},
        'required': ['query'], 'additionalProperties': False}}}

# include_agent=True 的增量全集（R11 过滤前）——L0-3 契约差分断言「增量恰为
# browser_*/software_*/memory_* 工具族」即以此常量为基准（R42 起含记忆工具族）
AGENT_TOOLS = (_AGENT_BROWSER_SEARCH, _AGENT_BROWSER_OPEN, _AGENT_SOFTWARE_CALL
               ) + _AGENT_BROWSER_DRIVER + _AGENT_MEMORY_TOOLS


def build(role='full', ws_on=True, mcp_tools=None, include_agent=False,
          is_glm_endpoint=False):
    """构建工具 schema JSON 字符串。

    v1.8.0 C 域：include_agent=True 且 role=='full' 时尾部追加 Agent 工具族
    （browser_search / browser_open / software_call）。R11 裁决（端点过滤）：
    is_glm_endpoint=True（GLM 端点）时 browser_* 定义不进工具集——云端原生
    web_search 由前端按既有口径追加，两个搜索工具永不并存；software_call
    与搜索通道正交，两端点都保留。默认路径（include_agent=False）与 legacy
    逐字节一致（契约差分测试锁定）。
    """
    if role == 'chat':
        return json.dumps([], ensure_ascii=False)
    tools = [dict(_S_READ_MORE)]
    if role == 'full':
        if ws_on:
            tools += [
                {'type': 'function', 'function': {'name': 'read_file',
                    'description': '读文件(带行号,一次可读2万行,常规文件一次读全;同版本重复读被拦截,需原文传force=true)',
                    'parameters': {'type': 'object', 'properties': {
                        'path': {'type': 'string'}, 'offset': {'type': 'integer'},
                        'limit': {'type': 'integer'}, 'force': {'type': 'boolean'}},
                        'required': ['path']}}},
                {'type': 'function', 'function': {'name': 'write_file',
                    'description': '整文件写入(UTF-8)。已存在且>20KB 会被拒,改用 search_replace',
                    'parameters': {'type': 'object', 'properties': {
                        'path': {'type': 'string'}, 'content': {'type': 'string'}},
                        'required': ['path', 'content']}}},
                {'type': 'function', 'function': {'name': 'append_file',
                    'description': '追加到文件末尾。10 分钟内同文件限 6 次',
                    'parameters': {'type': 'object', 'properties': {
                        'path': {'type': 'string'}, 'content': {'type': 'string'}},
                        'required': ['path', 'content']}}},
                {'type': 'function', 'function': {'name': 'search_replace',
                    'description': '精确原文局部替换,优先于整文件重写',
                    'parameters': {'type': 'object', 'properties': {
                        'path': {'type': 'string'}, 'old': {'type': 'string'},
                        'new': {'type': 'string'}, 'replace_all': {'type': 'boolean'}},
                        'required': ['path', 'old', 'new']}}},
                {'type': 'function', 'function': {'name': 'list_dir',
                    'description': '列目录,超过 200 项只回前 200+总数',
                    'parameters': {'type': 'object', 'properties': {
                        'path': {'type': 'string'}}, 'required': ['path']}}},
                {'type': 'function', 'function': {'name': 'make_dir',
                    'description': '创建文件夹',
                    'parameters': {'type': 'object', 'properties': {
                        'path': {'type': 'string'}}, 'required': ['path']}}},
                {'type': 'function', 'function': {'name': 'delete_path',
                    'description': '删除文件/目录(进回收站)',
                    'parameters': {'type': 'object', 'properties': {
                        'path': {'type': 'string'}}, 'required': ['path']}}},
                {'type': 'function', 'function': {'name': 'move_path',
                    'description': '移动/重命名',
                    'parameters': {'type': 'object', 'properties': {
                        'path': {'type': 'string'}, 'new_path': {'type': 'string'}},
                        'required': ['path', 'new_path']}}},
                {'type': 'function', 'function': {'name': 'copy_path',
                    'description': '复制文件/目录',
                    'parameters': {'type': 'object', 'properties': {
                        'path': {'type': 'string'}, 'new_path': {'type': 'string'}},
                        'required': ['path', 'new_path']}}},
                {'type': 'function', 'function': {'name': 'get_file_info',
                    'description': '文件大小/修改时间',
                    'parameters': {'type': 'object', 'properties': {
                        'path': {'type': 'string'}}, 'required': ['path']}}},
            ]
        tools += [
            {'type': 'function', 'function': {'name': 'run_command',
                'description': '执行 cmd 命令,输出超长自动截断落盘',
                'parameters': {'type': 'object', 'properties': {
                    'cmd': {'type': 'string'}, 'timeout': {'type': 'integer'}},
                    'required': ['cmd']}}},
            {'type': 'function', 'function': {'name': 'run_powershell',
                'description': '执行 PowerShell 命令,输出超长自动截断落盘',
                'parameters': {'type': 'object', 'properties': {
                    'cmd': {'type': 'string'}, 'timeout': {'type': 'integer'}},
                    'required': ['cmd']}}},
            {'type': 'function', 'function': {'name': 'run_admin_command',
                'description': '管理员权限命令,会弹原生确认框',
                'parameters': {'type': 'object', 'properties': {
                    'cmd': {'type': 'string'}}, 'required': ['cmd']}}},
            {'type': 'function', 'function': {'name': 'open_app',
                'description': '打开软件/文件/文件夹',
                'parameters': {'type': 'object', 'properties': {
                    'path': {'type': 'string'}}, 'required': ['path']}}},
            {'type': 'function', 'function': {'name': 'open_url',
                'description': '用默认浏览器打开网页',
                'parameters': {'type': 'object', 'properties': {
                    'url': {'type': 'string'}}, 'required': ['url']}}},
            {'type': 'function', 'function': {'name': 'take_screenshot',
                'description': '截取当前屏幕; 可选区域参数 left/top/width/height',
                'parameters': {'type': 'object', 'properties': {
                    'left': {'type': 'integer'}, 'top': {'type': 'integer'},
                    'width': {'type': 'integer'}, 'height': {'type': 'integer'}}}}},
            {'type': 'function', 'function': {'name': 'clipboard_read',
                'description': '读取系统剪贴板文本',
                'parameters': {'type': 'object', 'properties': {}}}},
            {'type': 'function', 'function': {'name': 'clipboard_write',
                'description': '写入系统剪贴板文本',
                'parameters': {'type': 'object', 'properties': {
                    'text': {'type': 'string'}}, 'required': ['text']}}},
            {'type': 'function', 'function': {'name': 'list_processes',
                'description': '列出进程(按内存降序, 可关键字过滤), 配合 kill_process',
                'parameters': {'type': 'object', 'properties': {
                    'keyword': {'type': 'string'}}, 'required': []}}},
            {'type': 'function', 'function': {'name': 'kill_process',
                'description': '结束进程(按 pid 或进程名), 请先 list_processes 确认再杀',
                'parameters': {'type': 'object', 'properties': {
                    'pid': {'type': 'integer'}, 'name': {'type': 'string'}},
                    'required': []}}},
            {'type': 'function', 'function': {'name': 'append_memory',
                'description': '写入跨会话长期记忆',
                'parameters': {'type': 'object', 'properties': {
                    'content': {'type': 'string'}}, 'required': ['content']}}},
        ]
    elif role == 'ro':
        if ws_on:
            tools += [
                {'type': 'function', 'function': {'name': 'read_file',
                    'description': '读文件片段(带行号)',
                    'parameters': {'type': 'object', 'properties': {
                        'path': {'type': 'string'}, 'offset': {'type': 'integer'},
                        'limit': {'type': 'integer'}, 'force': {'type': 'boolean'}},
                        'required': ['path']}}},
                {'type': 'function', 'function': {'name': 'list_dir',
                    'description': '列目录',
                    'parameters': {'type': 'object', 'properties': {
                        'path': {'type': 'string'}}, 'required': ['path']}}},
                {'type': 'function', 'function': {'name': 'get_file_info',
                    'description': '文件大小/修改时间',
                    'parameters': {'type': 'object', 'properties': {
                        'path': {'type': 'string'}}, 'required': ['path']}}},
            ]
        tools += [
            {'type': 'function', 'function': {'name': 'run_powershell',
                'description': '执行 PowerShell 命令',
                'parameters': {'type': 'object', 'properties': {
                    'cmd': {'type': 'string'}}, 'required': ['cmd']}}},
            {'type': 'function', 'function': {'name': 'open_app',
                'description': '打开软件/文件',
                'parameters': {'type': 'object', 'properties': {
                    'path': {'type': 'string'}}, 'required': ['path']}}},
            {'type': 'function', 'function': {'name': 'take_screenshot',
                'description': '截取当前屏幕',
                'parameters': {'type': 'object', 'properties': {}}}},
            {'type': 'function', 'function': {'name': 'clipboard_read',
                'description': '读取系统剪贴板文本',
                'parameters': {'type': 'object', 'properties': {}}}},
            {'type': 'function', 'function': {'name': 'list_processes',
                'description': '列出进程(按内存降序)',
                'parameters': {'type': 'object', 'properties': {
                    'keyword': {'type': 'string'}}, 'required': []}}},
            {'type': 'function', 'function': {'name': 'append_memory',
                'description': '写入跨会话长期记忆',
                'parameters': {'type': 'object', 'properties': {
                    'content': {'type': 'string'}}, 'required': ['content']}}},
        ]
    # v1.3 MCP：仅 full 角色且调用方显式传入时尾部追加（默认路径零变化）
    if role == 'full' and mcp_tools:
        if len(mcp_tools) > MCP_FOLD_THRESHOLD:
            # R44 渐进披露：超阈值 → 全部 mcp__ 定义折叠为 mcp_search 元工具
            tools += [_AGENT_MCP_SEARCH]
        else:
            tools += list(mcp_tools)
    # v1.8.0 C 域：Agent 工具族（仅 full 角色且显式开启；R11 端点过滤）
    if role == 'full' and include_agent:
        agent = list(AGENT_TOOLS)
        if is_glm_endpoint:
            # R11：GLM 端点只留内置 web_search（前端追加）——browser_* 不进工具集
            agent = [t for t in agent
                     if not str(t['function']['name']).startswith('browser_')]
        tools += agent
    return json.dumps(tools, ensure_ascii=False)
