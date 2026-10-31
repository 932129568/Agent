# Harbor

本地优先的 GLM AI 对话客户端 —— 单文件 HTML + pywebview 桌面壳，零第三方运行时依赖（Python stdlib only），配置与数据全部留在本机 `~/.glm-chat/`。

**当前版本：v1.9.0**（应用版本见窗口标题；js_api 契约版本独立维护，恒为 v1.0.0）

---

## 功能特性

### 核心对话
- GLM 全系模型（glm-5.3 / glm-5 / flash 等）+ 思考深度档位（off / min / low / medium / high / max）
- 流式输出、思考过程单独展示、usage 明细（输入/输出/缓存命中/费用）
- 图片、视频与文本附件输入；实际多模态能力取决于所选模型与端点
- 自定义 OpenAI 兼容端点（设置 → 连接与模型，自动剥离 GLM 专属字段）
- 智能档路由（按问题复杂度自动选模型/思考档）

### Agent 工具链（本地执行，全部受护栏管辖）
| 工具 | 说明 |
|---|---|
| `read_file` / `write_file` / `edit_file` | 文件读写（行号制编辑） |
| `list_dir` / `search_files` | 目录枚举 / 文件名+内容搜索 |
| `run_command` | 白名单命令执行（含写操作去重拦截） |
| `screenshot` / `clipboard_read` / `clipboard_write` | 截屏 / 剪贴板 |
| `kill_process` | 进程查杀（pid 权威反查 + 内置关键进程保护名单） |
| `open_path` / `pick_path` | 资源管理器定位 / 文件选择对话框 |

### 护栏与成本防御（信任版）
- **三档护栏矩阵**（always / session / off）：破坏性操作确认、会话信任态、confirm-token 一次性令牌防重放
- **预算硬停**：会话级单调计数器（token/费用），耗尽即暂停发起新请求（进行中的工具跑完）
- **熔断保护**：同工具同参数 ×3 无进展 / 15 步无进展自动停
- **错误人话**：HTTP 错误码 / 本地端点特情（503 模型加载中、404 模型不存在等）全覆盖

### MCP 支持（v1.3）
- Streamable HTTP + stdio 双传输，协议钉死 `2025-06-18`
- 连接池（v1.5.1）：keep-alive 复用、空闲 60s 回收、错误连接不污染池
- stdio 温启：启用即预热，首调用零延迟；状态面板显示冷启耗时
- 分层护栏：服务器默认关、工具三档注解推导（readOnly→session / 无注解→always）、后端二次 enforce、全量审计
- 凭证 DPAPI 字段级加密（`~/.glm-chat/mcp_servers.json`，Claude 配置兼容）

### 本地模型（v1.5）
- 五预设探测：Ollama / LM Studio / vLLM / llama.cpp / LocalAI（四端口并行，≤1s）
- 元数据四级来源：内置精确表 → `/api/tags` 服务器声明 → 前缀启发式 → 保守默认
- 上下文自适应压缩：阈值 = 模型窗口 × 档位比例（0.4/0.6/0.8）
- 工具能力降级：400 特征错误自动去 tools 重发；`tool_capable=off` 不发 tools
- 慢推理适配：首字节等待态（每秒刷新）、120s 停滞 watchdog、max_tokens 默认 4096
- 本地模式零费计费 + MCP 保守策略（确认框追加幻觉风险提示）

### 数据主权（WebDAV 导出与恢复）
- WebDAV 备份：config + sessions + 审计日志，manifest 逐文件 sha256
- 三方冲突合并（本地/云端/基线）：ask / local_wins / remote_wins / keep_both 四策略
- 凭证独立文件 + DPAPI 加密，https 强制（localhost 除外）

### 其他
- **压缩透明化**（v1.4）：发送副本瘦身弱化标记、就地压缩单份可恢复备份（上限 50 条）
- **会话搜索**（v1.4）：侧栏即时过滤
- **会话导出 Markdown**：前端 Blob，零后端
- **自动更新**：检查更新 / 下载 / 备份替换 / 失败回滚
- **v4 UI**：极光背景、crossfade 面板切换、毛玻璃、按压反馈、数字滚动

### 命令沙箱（v1.6）
- Job Object 进程隔离：命令整树收编、内存/进程数/CPU 三限、超时内核级清剿
- 无竞业收编（挂起态 assign），KILL_ON_JOB_CLOSE 防孤儿；fail-closed 不裸跑

---

## 快速开始

### 方式一：安装程序安装（推荐，v1.7 起）

1. 双击 `dist/Harbor-Setup-1.9.0.exe`（其他版本对应 `Harbor-Setup-<version>.exe`）
2. 向导两步：确认欢迎页 → 选择安装位置（默认 `%LOCALAPPDATA%\Programs\Harbor`，可浏览修改）
3. 等待安装完成，可勾选「立即运行 Harbor」

安装特性：**每用户安装、无需管理员权限（不弹 UAC）**；开始菜单 + 桌面快捷方式；
可通过系统「应用与功能」或安装目录里的 `Uninstall.exe` 卸载（用户数据 `~/.glm-chat` 默认保留）。

静默安装（脚本/批量场景）：

```bash
Harbor-Setup-1.9.0.exe /S                                  # 默认目录
Harbor-Setup-1.9.0.exe /S --dir "D:\Apps\Harbor"           # 指定目录
Harbor-Setup-1.9.0.exe --uninstall /S                      # 静默卸载（保留数据）
Harbor-Setup-1.9.0.exe --uninstall /S --purge              # 静默卸载并删除用户数据
```

### 方式二：直接运行 exe（免安装）

1. 从 `dist/` 取 `Harbor.exe`（PyInstaller onefile，约 24MB）
2. 双击运行（需 WebView2 Runtime，Windows 11 自带）
3. 设置 → 连接与模型 → 填入 GLM API Key

### 方式三：源码运行

```bash
# 依赖：Python 3.10+ 与 pywebview
pip install pywebview

python main.py
```

### 构建

```bash
pip install pyinstaller send2trash pillow
python -m PyInstaller Harbor.spec --noconfirm
# 产物在 dist/Harbor.exe
```

构建带安装器的完整发布包（应用 + 卸载器 + 安装器三个 exe）：

```bash
python installer/build_setup.py        # 全量：dist/Harbor.exe + Harbor-Uninstall.exe + Harbor-Setup-<version>.exe
python installer/build_setup.py --app-only   # 仅应用 exe
```

---

## 使用说明

### 首次配置
1. **API Key**：设置（右上角齿轮）→ 模型服务商 → 填入 Key → 保存
2. **本地模型**（可选）：设置 → 本地模型 → 「探测本机」自动发现 Ollama/LM Studio 等 → 选模型 → 测试连接 → 开启本地模式
3. **MCP**（可选）：设置 → MCP 服务器 → 添加服务器（HTTP 填 URL / stdio 填命令）→ 测试连接 → 启用
4. **WebDAV 备份**（可选）：设置 → 数据与备份 → 填 WebDAV 地址 → 保存配置 → 导出/恢复

### 会话与工具
- 新会话 / 切换 / 删除：左侧栏；搜索框即时过滤
- 工具调用：AI 自动发起，破坏性操作弹确认框（可勾选「本会话内不再提示」）
- 压缩：自动（token 阈值 + 缓存命中率双条件）或手动 `/compact`
- 导出：侧栏「导出」按钮 → Markdown 文件

### 配置与数据位置
| 文件 | 内容 |
|---|---|
| `~/.glm-chat/config.json` | 主配置（Key、模型参数、偏好） |
| `~/.glm-chat/sessions.json` | 会话历史 |
| `~/.glm-chat/mcp_servers.json` | MCP 服务器（DPAPI 加密凭证） |
| `~/.glm-chat/webdav.json` | WebDAV 配置（DPAPI 加密密码） |
| `~/.glm-chat/audit_log.jsonl` | 工具调用审计日志 |
| `~/.glm-chat/logs/harbor.log` | 运行日志 |

---

## 项目结构

```
Harbor/
├── main.py                  # 入口（装配 backend + pywebview 窗口）
├── main_v1.0.0_legacy.py    # v1.0.0 legacy 单体（契约差分测试基线，勿删）
├── Harbor.spec            # PyInstaller 打包配置
├── VERSION                  # 应用版本号
├── harbor.html            # 前端构建产物（node frontend/build.js 生成）
├── backend/                 # Python 后端（协议门面 + application + domains）
│   ├── api.py               # js_api 协议适配（契约差分测试对象）
│   ├── application/         # Session / Operation 应用协调器
│   ├── bootstrap/           # 唯一 ServiceContainer 组合根
│   └── domains/             # settings/workspace/security/planning/providers/integrations
├── frontend/
│   ├── index.template.html  # HTML 模板
│   ├── manifest.json        # JS/CSS 显式顺序与依赖清单
│   ├── src/                 # core/agent/sessions/settings/providers/integrations 等领域模块
│   ├── styles/              # 确定性合并的样式源
│   └── build.js             # 零依赖 manifest 构建脚本
├── tests/                   # pytest 自动化回归
├── deliverables/            # 设计文档 / PRD / 路线图 / 审查报告
└── dist/                    # 打包产物
```

## 测试

```bash
pip install pytest
python -m pytest tests/ -q          # 全量回归（结果以当次 QA 运行为准）
python deliverables/design/check_contract.py   # UI/契约校验
node frontend/build.js              # 前端构建（含语法校验）
```

## 技术要点

- **契约零变更**：`get_api_info` 输出逐字节钉死（legacy vs new 差分），新方法全部隐身（`_V12_EXTRA`）
- **零运行时依赖**：后端纯 stdlib（http.client / ctypes / json…），MCP 客户端手写
- **UI 契约**：40 DOM id / 13 onclick / 43 callApi / 39 CSS 类 / 21 主题变量（只增不改）
- **前端构建铁律**：改 `frontend/index.template.html` / `frontend/src` / `frontend/styles` 后同步 `frontend/manifest.json`，只用 `node frontend/build.js` 重建

## 已知问题与遗留

见 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)。

## 生成式 UiSpec（G1）

- 唯一协议为 Harbor 原生 UiSpec；5 种布局、8 个只读组件，P0 不执行 actions，不接第二 renderer。
- 运行时 schema 依赖仅 `zod@4.6.7`（MIT）；`esbuild@0.28.2` 仅用于开发期打包（MIT）。
- 重建离线 bundle：`npm install` 后运行 `npm run build:ui-schema`，产物与许可位于 `libs/ui-schema.*`。
- 普通前端构建只消费已提交的 `libs/ui-schema.bundle.js`，没有 `node_modules` 也可运行 `node frontend/build.js`；不使用 CDN、iframe 或在线字体。

## License

私有项目，保留所有权利。
