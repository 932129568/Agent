# P0-1c 修复方案设计：T05 全覆盖新发现 65 项 suspect 的契约对齐

- 日期：2026-10-30
- 作者：架构师（software-architect）
- 输入：P0-1 最终结论 `deliverables/dev-plan/p0-1-conclusions-2026-10-30.md`（65 方法/86 call 三类明细）、QA 终验 `outputs/acceptance-2026-10-30-p0-1-final.md`（安全 4 项源码级核验）、差分报告原文 `outputs/diff/20261030172234/report.md`（86 call 双侧归一输出）、双侧源码复核（本轮设计期间完成：process_service / builtin_importer / file_service / api.py rpc 与 prompt 包装 / container.py / files.js / provider.js / jsonstore.js / system.js 等）
- 交付对象：工程师（寇豆码）
- 模式：与 P0-1b 方案（`design-2026-10-30-p0-1b-fixes.md`）同构——根因聚类 → 逐项清单 → 安全评估专节 → 任务分解 → 复跑防交叉 → 登记收口
- 红线遵守：`API_VERSION='v1.0.0'` 冻结、`get_api_info` 零改动、`config.json` 零污染（各配置仍独立文件）、不碰 `harbor.html`、**Python 侧零文件改动**（§8）、设计非实现（代码片段 ≤30 行示意）

---

## 1. 根因聚类：65 项 → 7 类结构性根因

| 根因 | 描述 | 源码级证据 | 覆盖 suspect |
|---|---|---|---|
| **R1 安全防线缺失** | kill_process 的 Python 四层防线（C1 pid 数字校验 / S2 pid→tasklist 反查且反查权威 / S3 通配符拒绝 / 保护名单含 Harbor 自身）在 Node 全部缺失 | `process_service.py:126-164`（四层逐行）；Node `system.js:181-194`（enforceExec 后直接 taskkill） | clipboard-process/c03（安全级，最高优先级） |
| **R2 功能缺失** | ① expert_list 内置包：Python 容器构造期 `WorkBuddyBuiltinImporter.import_all()` 导入 8 包，Node 无 importer 注册表为空；② local_readiness 评分量表（8 项 name/score/max/detail、总分 16）未移植；③ read_file 的自适应分页/字符预算/超大防护/猜错提示未移植 | `container.py:120-127`；`builtin_importer.py:216+`（`METADATA_PATHS=('.codebuddy-plugin/plugin.json', '.workbuddy-plugin/plugin.json', …)`）；`file_service.py:160-258` | experts/c01+c08+probe、prompts-tools/c14、files/c02-c05 |
| **R3 响应键集/编码方言** | Node 简化实现普遍改写了响应键集：workspace 族（`bound/source/exists/recent` vs `ok/enabled`）、memory（`ts_iso`/`remaining`）、config 族（裸 `{}` 无归一默认）、mcp（`warm/spawn_ms/enabled` 回显）、clipboard（裸文本 vs `{ok,text,len}`）、`build_system_prompt` 返回裸文本 vs Python **JSON 编码字符串**（`ok(text)`=json.dumps） | 各服务双侧源码；`errors.py`：**`ok(payload)=json.dumps(payload)` 纯序列化、不注入 `ok` 键**（键集差异全部来自各服务自己拼的 dict） | workspace 9、memory 6、config 9、mcp 10、clipboard 2、prompts-tools/c01、files/c08-c14 等 |
| **R4 路径口径分叉** | Python 响应普遍回**绝对路径**（make_dir/move/copy/delete/get_file_info/binary 响应/缺文件错误），Node 回相对短路径；`save_workspace_file` 返回**裸路径字符串**（非 JSON）且带 `HHMMSS_` 时间戳前缀（save 与 copy_into_ws 两处）；`copy_into_ws` 同前缀 | `file_service.py`（`path` 变量为 resolved 绝对值）；`workspace_service.py`（attachments 命名） | files/c06/c10-c14、workspace/c10/c16 |
| **R5 配置服务语义缺失** | Python 各配置服务有「defaults 归一 + 保存校验（枚举/范围/必填）+ 归一化整写」，Node `jsonstore.js` 是裸 `{}` 读 + 浅合并写（无校验无默认）；webdav 另有「密码必填才落盘 + configured 态判定」语义 | `jsonstore.js`（readConfigText/mergeConfig）；Python hybrid/model_prefs/reader/sandbox/webdav 各 service | config 18、webdav 7 |
| **R6 文案/顺序/分类学** | mcp 五处文案、错误码分类（`PATH_UNAVAILABLE`/`INVALID_SNAPSHOT_ID`/flat vs info+skipped）、校验顺序（mcp_call_tool 先查服务器启用再谈 decision；rpc **kwargs-only**——非 dict payload 归一 `{}`，绝不做位置展开）、provider 错误分类（超时/拒连的人话文案） | `api.py rpc`（`if not isinstance(args, dict): args = {}` + `func(**args)`）；mcp_service 顺序 | mcp 文案 5、experts/c02/c04、rpc 2、webdav 文案 4、prompts-tools/c11-c13、files/c15 |
| **R7 harness 伪差（偶合缺陷）** | **Python 驱动种子文件用文本模式写入 → Windows 换行翻译 `\n`→`\r\n`**（Node 驱动逐字节写 LF）：a.txt size 30 vs 28、`_glm_worklog.md`/`a.txt` 快照 sha 分歧的直接共因；另 taskkill mock canned 为 UTF-8 字节而业务侧按 GBK 解码产生双侧乱码不一致的隐患 | 差分报告 files/c11 size 30 vs 28；workspace probe sha 差；`process_service.py:161`（GBK 解码） | files 快照、workspace 快照（部分）、files/c02-c04 的 total_lines 差有**双重成因**（R7 + Node split 尾行幻影，见 T02） |

> 判定要点：files/c02/c03/c04 的 `total_lines 2 vs 3` 是**双重成因**——① R7（Python 侧文件 CRLF）；② Node `text.split(/\r?\n/)` 对换行结尾文件产生尾行幻影（Python 用 `splitlines(keepends=True)`）。①②都修才能收敛；只修其一仍 suspect。

---

## 2. 修复总原则与例外裁决

1. **默认：Node 向 Python 契约对齐**（同 P0-1b；Python 武装生产态行为形状为基准）。
2. **例外裁决 3 项（新增 intentional 登记，见 §5）**：
   - **ID-201 build_system_prompt 沙箱尾注**：Python 尾注声明「命令在受限 Job 内执行…」——Node **没有** Job 沙箱，照抄即向模型/用户撒谎（比缺文案更危险）。裁决：编码形态修复对齐（返回 JSON 编码字符串），尾注**不注入**并登记，跟踪 P0-2 沙箱迁移后复评。这是「Node 增强/Python 语义依赖未迁移设施」类例外。
   - **ID-202 get_platform_info 的 `python` 键值**：键集是前端契约（`window.__platformInfo`/data-platform 消费）须保留，值为运行时身份披露——Node 填 node 运行时版本串。与 ID-001（exe 字段）完全同构：键冻结、值披露实际宿主。其余结构（os/win 格式、machine/AMD64 映射、services 七接口、browser_backend）**全部对齐**。
   - **ID-203 网络库错误文案**：`连接失败: <urlopen error [WinError 10061]…>` vs `fetch failed`——嵌入的是 urllib/undici 的库级异常文本（同 ID-104 解析器文案性质）。键集（去掉 url/model/state 回显）与手写分类文案（超时/未监听）对齐，库文本片段登记。
3. **无「Python 侧缺陷」类双向择优**：本轮 65 项复核未发现 Python 行为缺陷（P0-1b 已修完其方言不一致面），**Python 侧零改动成立**（§8）。
4. **Node 增强折叠不登记**（同 P0-1b 先例）：read_file 的 `encoding/offset/returned` 回显键、get_platform_info 的 `os_release/cpus/total_memory`、mcp 的 `headers`/`enabled` 回显——均为未消费的富信息，直接收敛为 Python 键集，增强留内部实现。

---

## 3. 逐项修复清单（86 call → 62 修 + 3 登记 + 21 级联/快照收敛）

> 缩写：〔P1 安全/P2 前端·模型消费/P3 一致性〕；文件相对 `server/`。所有修复同步更新对应 Node 测试（§6 任务内含）。

### 3.1 T01 批：安全与功能缺失（R1/R2）

| call | 差异 | 修复方向 | 风险 |
|---|---|---|---|
| clipboard-process/c03 kill_process | 持 token 可杀任意进程（含 lsass/Harbor 自身）；`name='*'` 批量强杀；响应形状 `{ok,pid,name}` vs `{ok,exit_code,output}` | **K1 四层防线完整复刻**（§4.1 逐层设计）：C1 pid 数字校验→S2 tasklist 反查+权威（resolved 覆盖传入 name；不一致拒绝）→S3 通配符拒绝→保护名单（PROTECTED_PIDS{0,4}+自身 pid、PROTECTED_NAMES 15 项）→`taskkill /PID|/IM <v> /T /F`→输出 **GBK 解码**（iconv-lite，OEM 口径对齐 legacy）截断 2000→`{ok: returncode==0, exit_code, output}`；api 层 `resolve-failed+armed→block` 与 name-spoof 审计点位一并对齐 | **P1（安全级）** |
| —（fixture 扩展） | 现 fixture 只走「反查 None→放行」路径 | 新增 calls：pid=1234+name='chrome.exe'（伪造名拒绝）、pid=1234+name='notepad.exe'（一致→执行）、name='*'（通配符拒绝）、name='lsass.exe'（名单拒绝）、pid='abc'（C1 拒绝）；自身 pid 路径单测覆盖（pid 非确定不入 fixture） | — |
| experts/c01+c08+probe expert_list | Node 注册表空（无 builtin importer） | **E1 builtin importer**（§4.2 设计）：模块级 once 标志 + 发现（`backend/experts_builtin/` 排序目录、`.codebuddy-plugin/plugin.json` 优先）→ metadata 消毒（METADATA_FIELDS+x-harbor- 白名单、skills 缺省发现、team 的 displayName/profession 映射）→ **复用 Node 既有严格导入路径**（`expertImportDirectory` 同语义）逐包导入（source.builtin）→ 失败 warning 不中断；experts.json 持久化形状（schema_version/packages/snapshots/digest/registered_at/warnings）随导入器自然产出 | P2（开箱体验）；打包注意（§4.2-6） |
| experts/c02 import_directory | 错误码/键集：Py `PATH_UNAVAILABLE{message:'路径无法读取',path,details:'FileNotFoundError'}` vs Node `EXPERT_IMPORT_INVALID{message:ENOENT 文本}` | **E2**：目录不可读类 → `PATH_UNAVAILABLE` + `message:'路径无法读取'` + `path` 键 + `details` 键（ENOET→`'FileNotFoundError'` 类名映射，稳定字符串） | P3 |
| experts/c04 read_resource | Py `INVALID_SNAPSHOT_ID{message:'snapshot ID 非法'}` vs Node `RESOURCE_NOT_READABLE{message,path}` | **E3**：非法 snapshot id → `INVALID_SNAPSHOT_ID`（无 path 键）；RESOURCE_NOT_READABLE 保留给「快照合法但资源不可读」场景（对齐 Python 分类） | P3 |

### 3.2 T02 批：前端/模型消费面（R2/R3/R7）

| call | 差异 | 修复方向 | 风险 |
|---|---|---|---|
| files/c02-c04 read_file | 键集（encoding/offset/returned 多余）+ total_lines 尾行幻影 + GBK | **F1 全语义移植**（`file_service.py:160-258` 逐条）：①split 改 keepends 语义（无尾行幻影）；②成功响应键集 `{ok,path(短),total_lines,content(,hint)}`；③`offset>=total` → `{ok,path,total_lines,note:'offset=N 已超出文件末尾（共 M 行）'}`（无 content）；④registry 缺省 limit=800（对齐 api 签名），`limit<=0` 自适应：≤2000 行一次读全、>2000 行分页 1200；⑤240000 字符预算 + `'\n…(超大文件截断，可传 offset 继续读)'`；⑥64MB 预检拒绝；⑦缺文件：difflib 猜错提示（`（最接近的文件: X，可用相对路径直接读取）`，cutoff 0.6、≤2 层深度、≤2000 候选）+ **绝对路径**入错误文本；⑧binary → `{path(绝对),binary:true,info:'二进制文件，read_file 不适用；如需分析请用 run_powershell'}`（**ok/error 语义反转修正**——Python 该路径是信息性载荷非错误）；⑨目录错误文案 `'路径是目录不是文件: <abs>，列目录请用 list_dir'` | **P2（前端文件查看器 + 模型读文件行为直接消费面）** |
| files/c15 read_more | 文案 | **F2**：`'缓存不存在或已清理，请重新执行原命令获取'` | P3 |
| prompts-tools/c01 build_system_prompt | ①编码形态：Py 返回 **JSON 编码字符串**（`ok(text)`=json.dumps）vs Node 裸文本（mixed-kind 根因）；②尾注：Py 有沙箱边界段，Node 无 | **PR1**：Node 返回 `JSON.stringify(text)`（HTTP body 成为 JSON 字符串，形态对齐）；尾注缺失 → **登记 ID-201**（Node 无 Job 沙箱，不注入虚假安全声明；P0-2 复评） | P2（模型行为面） |
| prompts-tools/c03 build_tools | `[16].function.parameters` Node 多 `required` 键 | **PR2**：工具 schema 构建器在 required 为空时**省略键**（Python builder 行为）；工程师定位 tool[16] 并核对 Python 同位工具定义 | **P2（工具面进模型上下文）** |
| prompts-tools/c04 prompt_get | 文本 `\n` vs `\r\n` | **PR3**：Node prompts 库文件换行 LF 归一（读入时 `\r\n`→`\n` 一行修复，不依赖 git autocrlf；另全库 prompt 文件字节对齐 Python `backend/prompts/` 同名文件复核一遍） | P2 |
| prompts-tools/c14 local_readiness | 量表整体分叉（8 项 {id,ok,label}/8 分 vs Py 8 项 {name,score,max,ok,detail}/16 分） | **PR4**：整表移植 Python readiness 评分器（model_tagged/tool_capable/schema_json/iteration_headroom 等八项、逐项 score/max/detail 文案、verdict 口径） | P2 |
| prompts-tools/c11-c13 provider 三项 | 键集回显多余 + 错误分类文案 | **PR5**：①test_provider_endpoint → `{ok:false,error:'连接失败: <库文本>'}`（去 url/model/state 回显；库文本 → **ID-203**）；②local_models → `{ok:false,error:'获取模型清单失败: 端口未监听（服务未启动）'}`（按 ECONNREFUSED 分类）；③local_probe unreachable.error → `'连接超时（端口无响应）'`（按 ETIMEDOUT 分类；其余错误类映射 Python 口径） | P2/P3 |
| prompts-tools/c10 get_local_proxy | `{ok,port,base_url}` vs `{ok,base_url:'…/v1'}` | **PR6**：键集对齐 `{ok,port,base_url}`（port=运行期端口，base_url 无 `/v1` 后缀口径）；harness 增归一规则 `http://127.0.0.1:\d+`→`<PROXY>`（掩 port 值） | P3 |
| prompts-tools/c08 ui_nudge | 多 `visibility` 键 | **PR7**：`{nudged:false,reason:'window-not-ready'}` | P3 |
| —（harness 前置） | R7 伪差 | **H1 newline 三件套**：①Python 驱动种子写入改二进制/`newline=''` 逐字节（`tools/diff/fakes.py`）；②快照哈希前 `\r\n`→`\n` 归一（双侧驱动 snapshot 逻辑——运行时文本模式是环境产物非契约语义）；③若 `_glm_worklog.md` 内嵌时间戳行仍致 sha 分歧 → 行级时间戳掩蔽（N 规则扩展）或 fixture 排除该文件（工程师复核 worklog 文件格式后择一）；**修后必须复跑八族既有 fixture 验证零翻转**（newline 归一只影响 files/workspace 快照与 c02-c04 的期望值路径，理论上只收敛不翻转） | harness（P0 级前置） |

### 3.3 T03 批：形状分叉——工作区/文件/记忆/剪贴板/平台（R3/R4）

| call | 差异（Py → Node 现状） | 修复方向 | 风险 |
|---|---|---|---|
| workspace/c03 | `{sid:null,ws,source:'global',exists}` → `{ok,ws,enabled,bound}` | **W1**：`get_effective_ws` 返回 `{sid,ws,source,exists}`（source ∈ global|session|bound——按 Python workspace_service 口径） | P2 |
| workspace/c04/c05 | set/get_session_ws：`{ok,sid,ws,bound}` / `{ws,bound}`（get **无 ok 键**） | **W2**：键集逐一对齐（get 不带 ok） | P2 |
| workspace/c06/c07 | set/get_ws_enabled：`{ok,enabled}` / `{enabled}`（get 无 ok；set 无 sid 回显） | **W3**：去 `sid` 回显、get 去包 | P2 |
| workspace/c08 | `{ws,bound,enabled,recent:[{path,name,ts}]}` → Node 无 recent 多 exists | **W4**：get_ws_state 补 `recent` 数组（{path,name=目录名,ts}）、去 `ok/exists` | P2 |
| workspace/c09 | list_recent_ws：对象数组 → Node 字符串数组 | **W5**：`[{path,name,ts}]` | P2 |
| workspace/c10 | save_workspace_file：**裸路径字符串** `<WS>\attachments\<HHMMSS>_note.md` → Node `{ok,path}` 无前缀 | **W6**：返回裸绝对路径字符串（mixed-kind 对齐）+ `HHMMSS_` 时间戳前缀 | P2 |
| workspace/c13/c14 | delete_session_ws 去 `sid`；set_ws_dir `{ok,ws}`（非 path） | **W7**：键名对齐 | P3 |
| workspace/c16 | copy_into_ws：`{ok,path(绝对)}` 带 `HHMMSS_` 前缀 → Node 相对无前缀 | **W8**：前缀 + 绝对路径 | P2 |
| workspace 快照 | sha 分歧 | H1②/③ 级联收敛（worklog/a.txt）；`attachments/<TSFN>_` 前缀已归一 | 级联 |
| files/c08 | append_file 缺 `bytes` 键 | **F3**：`{ok,path,bytes}` | P3 |
| files/c10-c13 | make_dir/move/copy 响应路径相对 → Py 绝对 | **F4**：响应路径改为 resolved 绝对路径（`{ok,path}` / `{ok,src,dst}`） | P2（前端回显） |
| files/c11 | get_file_info：`{path(绝对),is_dir,size,mtime}` → Node `{ok,path(相对),exists,…}` | **F5**：去 `ok/exists`、绝对路径（size 30vs28 由 H1① 收敛） | P2 |
| files/c14 | delete_path：`{ok,path(绝对),mode:'回收站'}` → Node `{ok,path,recycled,requested_recycle}` | **F6**：响应改 `{ok,path,mode}`（mode='回收站'/'永久删除…'）；**语义核对**：Node 的回收站实现（PowerShell SendToRecycleBin）在差分环境下的成败要与 Python send2trash 同因同果——回收失败时的 mode 文案对齐 Python 两条降级文案（P0-1b NORM 规则已有归一先例） | P2 |
| memory/c04/c07+probe | 条目缺 `ts_iso` 键（含持久化文件） | **M1**：append/get/持久化统一带 `ts_iso`（ts 的 ISO 展示） | P3 |
| memory/c05 | retrieve：Py 1 项（阈值截断、无 score 键）→ Node 2 项带 score | **M2**：移植 Python 检索算法（关键词评分 + 阈值；输出 items 无 score 键、带 ts_iso） | P2（模型记忆召回面） |
| memory/c06 | delete：`{ok,remaining}` vs `{ok,total}` | **M3**：键名 remaining | P3 |
| memory/c08 | 越界：Py 结构化 `BAD_PARAMS{message:'序号越界：当前共 N 条记忆',hint:'刷新列表后重试；序号从 0 开始'}` vs Node 拍平 | **M4**：结构化对齐 | P3 |
| clipboard/c01 | set：`{ok,len,verified:true}`（写后回读校验）vs `{ok}` | **CL1**：补 len+verified（回读经 PowerShell Get-Clipboard；mock 表剪贴板槽位已有状态语义——P0-1b 已建，核对即可） | P2 |
| clipboard/c02 | get：`{ok,text,len}` vs 裸文本 | **CL2**：包 `{ok,text,len}` | P2 |
| clipboard/c04 | get_platform_info：services 七接口 + browser_backend + os:'win'/machine:'AMD64' vs Node node/arch/cpus… | **PL1**：结构全对齐（services:{secrets,sandbox,screen,trash,paths,process,notify} 各 `{ok,name}` 的 Node 就绪度探测；browser_backend:{platform,win,headless,…} 按 Playwright/Edge 探测；os 'win'、machine 'AMD64'（x64→AMD64 映射））；`python` 键保留、值=node 运行时版本串 → **ID-202** | P2 |

### 3.4 T04 批：配置服务 + webdav + mcp + rpc（R5/R6）

| call | 差异 | 修复方向 | 风险 |
|---|---|---|---|
| config/c01-c03 hybrid | 裸 `{}` 无默认/无校验（非法 strategy 被 Node 静默接受落盘 `{"strategy":"bogus"}`） | **CF1**：配置规格层（新 `src/services/config-specs.js` + jsonstore 扩展 `readConfigNormalized/mergeConfigValidated`）：hybrid 默认 `{strategy:'auto',local_budget_understand_s:5,local_budget_validate_s:3,confidence_gate:0.7,cost_split_display:true}`；校验错误 `BAD_PARAMS{message:"字段 strategy 的值 'bogus' 不合法",hint:"字段 strategy 合法域：…（逐字）"}`；**归一化整写**（probe 收敛：文件=全量归一）；get 响应 `{ok,config,source:'default'\|'file'}`（source 口径按 Python：默认态带 source，保存后回读带 config 无 source——工程师以 Python 服务源码为准） | P2（**安全参数静默接受面**，同 P0-1b c16 性质） |
| config/c04-c06 model_prefs | 同上 | **CF2**：默认 `{thinking:'auto',ctx_k:0}`+文件 `version:1`；thinking 枚举 `auto/off/low/medium/high`，错误 `'thinking 仅支持 auto/off/low/medium/high'`；get `{ok,thinking,ctx_k}` 口径对齐 | P2 |
| config/c07-c09 reader | 同上 | **CF3**：默认七键全量；`budget_s 需为 1-60 的整数` 等校验文案；归一整写 | P2 |
| config/c10/c12+probe sandbox | get `{}` / status `{enabled}` | **CF4**：get 默认 `{enabled,command_profiles{三命令},limits{standard,strict}}`；status `{available:true,platform:'nt',enabled,command_profiles,stats:{jobs_created:0,runs_sandboxed:0,runs_failed_closed:0}}`（Node 无 Job 沙箱——stats 恒 0 是如实陈述；`available:true` 语义=平台支持声明，与 Python 同口径；**沙箱实际能力差异已由 ID-201 跟踪**） | P2 |
| config/c13 search_cache_stats | `{entries,hits,misses,ttl_minutes,ttl_classes,size_kb}` vs `{ok,entries,bytes}` | **CF5**：键集对齐（ttl 类目 {news,general,encyclopedia}；Node 搜索缓存未迁移则全 0 起步——与 Python 空起步一致） | P3 |
| config/c14 search_reader_stats | Python 七键 vs Node `{note,entries}` | **CF6**：`{ok,reader_calls,schema_fail,degrade_count,local_available,configured,last_error,since}`（since=进程起点 epoch → N 规则掩蔽键扩展 `since`；Node 读取器未迁移则 0/false/'' 起步，同 Python 空态） | P3 |
| config/c15 search_status | Node 多 `state/task_id` 回显 | **CF7**：`{ok,active}` | P3 |
| webdav/c01-c03+probe | get `{ok,config:null}`；save **密码必填才落盘**（否则 `'缺少 WebDAV 密码'` 且不写文件→probe null）；Node 裸读浅写 | **WD1**：配置语义移植（configured 态判定=get 完整配置或 null；保存校验；未配置态文件不存在）；get `{ok,config}` | P2 |
| webdav/c04-c06 | `'未配置 WebDAV（设置 → 数据与备份）'` vs `'缺少 WebDAV 密码'` | **WD2**：检测逻辑对齐（configured 检查在前）；export 保留 `plan` 数组、restore 保留 `manifest:{}` 键 | P3 |
| mcp/c02 | save 多 `enabled` 回显 | **MC1**：`{ok,name}` | P3 |
| mcp/c03 | list 条目缺 `warm:false,spawn_ms:null` | **MC2**：补两键 | P3 |
| mcp/c04 | detail.config 键集：缺 `name`、多 `headers` | **MC3**：config=`{name,command,args,env,tierOverrides,enabled,decrypt_failed}` | P3 |
| mcp/c05 | `'档位必须是 always/session/off'` vs `'仅支持'` | **MC4**：文案 | P3 |
| mcp/c06 | reason 缺 `'（可能已禁用或崩溃）'` 从句 | **MC5**：文案 | P3 |
| mcp/c07 | Py flat `{error:'MCP 服务器 X 未启用（…）'}` vs Node `{info,skipped}` | **MC6**：**校验顺序对齐**——服务器启用检查先于 decision 方言（未启用→flat error；info/skipped 方言仅用于「已启用+用户拒绝」路径——工程师核对 Python mcp_service 顺序后对齐） | P2 |
| mcp/c08/c09 | `'MCP 服务器 diff-srv 未启用。'` vs Node 前缀包裹文案 | **MC7**：去 `'MCP 资源列表获取失败: '`/`'MCP 资源读取失败: '` 前缀 | P3 |
| mcp/c11 | `imported:['claude-x']` vs `imported:1` | **MC8**：数组 | P3 |
| mcp/c12 | `'服务器不存在: no-such-srv'` vs Node **undefined 崩溃**（`The "path" argument must be of type string`） | **MC9**：显式不存在错误（当前是防御缺失导致的崩溃文案泄漏——性质同 P0-1b 的 500 泄漏） | P2 |
| rpc/c02 | kwargs 未知键：Py `Api.save_config() got an unexpected keyword argument 'model'` vs Node 静默丢键后按解析失败报错 | **RP1**：rpc kwargs-only 语义对齐：**非 dict payload 归一 `{}`（删除 Node 的数组位置展开分支）**；payload 键 ∉ 方法签名 → 合成 CPython TypeError 固定格式 `'Api.<m>() got an unexpected keyword argument: …'`（格式串稳定，确定性合成非脆弱解析） | P2（rpc 是前端桥动态分发面） |
| rpc/c06 | 数组 payload：Py `'Api.save_sessions() missing 1 required positional argument: 'data''` vs Node 展开后 `'sessions 必须是…'` | **RP2**：同 RP1（归一 {} 后缺参 → 合成 `'Api.<m>() missing 1 required positional argument: '<name>'`（复数 `'arguments: a, b'` 口径同 CPython） | P2 |

---

## 4. 安全评估专节

### 4.1 kill_process 四层防线完整设计（K1，最高优先级）

对齐 `process_service.py:126-164` 逐层（含常量迁移），Node `system.js` 重写 `killProcess`：

```js
// 常量（逐字迁移，含注释口径）
const PROTECTED_NAMES = new Set(['system', 'system idle process', 'idle', 'smss.exe',
  'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe', 'lsass.exe', 'svchost.exe',
  'explorer.exe', 'dwm.exe', 'sihost.exe', 'taskhostw.exe', 'ctfmon.exe'])
const PROTECTED_PIDS = new Set([0, 4])          // Idle/System；自身 pid 运行期加入
// 层序（顺序即安全语义，不得调换）：
// C1  pid 非数字 → {error:'pid 必须是数字: %r'}
// S2  tasklist /fi "PID eq N" /fo csv /nh 反查（OEM 解码，扫描 parts[1]===pid）
//     resolved 存在 → 与传入 name 不一致（忽略大小写）→ 拒绝（防伪造名绕过名单）
//     一致或未传 name → name = resolved（反查权威：后续名单按真实名判）
// S3  name 含 '*' 或 '?' → 拒绝（taskkill /IM 通配符可批量强杀）
// P4  pid ∈ PROTECTED_PIDS 或 === process.pid → '系统关键进程或 Harbor 自身' 拒绝
//     name ∈ PROTECTED_NAMES → '属于系统关键进程' 拒绝（文案+'（保护名单）'）
// X5  taskkill ['/PID'|'/IM', v, '/T', '/F'] → stdout/stderr GBK 解码 → 截 2000
//     → {ok: returncode===0, exit_code, output}
```

- **执行点顺序**：enforceExec 护栏（既有）→ 四层 → 执行。api 层（`api.py:620-639`）的 `resolved is None && guard.armed → block 'resolve-failed'` 与 name-spoof 审计点位同步对齐（未武装差分环境放行——与 P0-1b armed 语义一致）。
- **GBK 解码**：iconv-lite（依赖已在）按 `'gbk'` 解码 taskkill 输出（legacy OEM 口径）；mock 表 taskkill canned 改 **GBK 字节**，双侧解码后一致（消除当前 UTF-8/GBK 乱码不对称）。
- **安全论证**：四层全部是**收紧**（现状 Node 持 token 可杀任意进程）；保护名单是 token 之后仍生效的硬防线（用户确认也不能杀系统进程/Harbor 自身）——与 Python 生产语义逐层同构。反查失败的降级（None→仅 pid 名单检查）与 Python 同款，不额外收紧。

### 4.2 expert_list 内置包导入器设计（E1）

- **位置**：新 `server/src/services/expert-builtin.js`（experts.js 首次 registry 初始化时调用，模块级 once 标志对齐 `_BUILTIN_EXPERTS_READY`）。
- **发现**：`<项目根>/backend/experts_builtin/`（相对 server 定位 `../../backend/experts_builtin`，可用 env 覆盖——打包注意见下）排序遍历子目录；元数据按 `METADATA_PATHS` 顺序探测（`.codebuddy-plugin/plugin.json` → `.workbuddy-plugin/plugin.json`，8 包实测全部为前者）。
- **消毒**（移植 `_sanitize_metadata`）：name 必填；skills 缺省自动发现（`skills/<dir>/SKILL.md`）；team 型补 displayName/profession 双语映射；字段白名单 `METADATA_FIELDS ∪ x-harbor-*`；agents 缺省 `'./agents/'`。
- **导入**：**复用 Node 既有严格导入路径**（`expertImportDirectory` 同语义）逐包导入——AGENT_LIMIT_INTERSECTED 等 warnings 由既有校验自然产出（差分 fixture 复跑验证 warnings 数组收敛）；`source:{kind:'builtin',name}` 标记。
- **失败容忍**：单包导入失败 → 日志 warning 继续（对齐 Python）；registry 初始化不因 builtin 失败而崩溃。
- **幂等**：once 标志防重复导入；experts.json 持久化形状（schema_version/packages/snapshots/digest/registered_at）由既有存储逻辑产出，probe 收敛为验收。
- **打包注意（P0-4 交接）**：Electron 打包需含 `backend/experts_builtin/` 资产目录（或迁移到 server 侧资产目录——**本轮不动**，路径 env 化即可，登记 P0-4 打包清单）。

### 4.3 其余安全相关

- **CF1-CF3（配置校验缺失）**：与 P0-1b 的 guard task_grant bogus scope 同性质——安全参数（hybrid 策略/预算、reader 预算）被 Node 静默接受落盘。补校验=收紧。
- **MC9（mcp_test_server 崩溃）**：undefined 解引用暴露内部错误文案，属防御缺失（同 P0-1b 500 泄漏类），显式错误=修复。
- **MC6（call_tool 顺序）**：未启用服务器必须先于 decision 方言拒绝（Python 同序）——防止「以用户拒绝话术掩盖服务器未启用」的误导性回执。
- **RP1（rpc kwargs 未知键）**：Node 现状静默丢键继续执行（Python 报错拒绝）——对齐后 unknown kwarg 显式报错，属收紧。

---

## 5. intentional 登记新增（3 项，待 team-lead 签核）

| 登记号 | fixture/call | 理由 | 前端/模型兼容论证 | 跟踪 |
|---|---|---|---|---|
| ID-201 | prompts-tools/c01 | build_system_prompt 沙箱尾注缺失：Python 尾注声明 Job 沙箱限制，Node 未迁移沙箱设施（无 Job 对象/资源上限），照抄=向模型与用户做虚假安全声明；编码形态（JSON 字符串）仍修复对齐，仅尾注内容差异登记 | 尾注是安全告知非功能契约；模型行为影响=Node 侧更保守（无沙箱声明→模型对命令副作用更谨慎）；P0-2 沙箱迁移后注入真实尾注并撤销登记 | P0-2（沙箱服务迁移） |
| ID-202 | clipboard-process/c04 | get_platform_info 的 `python` 键值：键集为前端契约（`window.__platformInfo` 消费），值为运行时身份披露——Node 填 node 运行时版本串；结构（os/machine/services 七接口/browser_backend）与格式（'win'/'AMD64'）全对齐 | 前端若展示运行时版本，展示的即真实宿主（Node）——与 ID-001 exe 字段同构：键冻结、值披露实际宿主 | 永久（运行时身份） |
| ID-203 | prompts-tools/c11 | test_provider_endpoint 错误文本内嵌网络库异常片段（urllib `<urlopen error [WinError 10061]…>` vs undici `fetch failed`）；键集与外层文案 `'连接失败: '` 对齐，仅库文本片段差异 | 前端仅展示 error 字符串；库文本是运行时实现细节（同 ID-104 解析器文案先例） | 永久（库实现细节） |

> 判断说明（回应 team-lead 提问）：**provider 提示词正文与工具描述集内容差异不登记**——c01 正文经 PR1 编码修复后与 Python 逐字节一致（尾注除外→ID-201）；c03 工具集经 PR2 后仅剩 required 键缺失（修复项）；`prompt_get` 的 `\r\n` 是数据文件换行不一致（PR3 修复）。**内容层唯一登记项=沙箱尾注**（因其依赖未迁移设施）。工具描述集若复核后发现描述文案字面差（当前 diffPath 只报 required 键），按「文案=修复、语义=登记」二分处理。

---

## 6. 任务分解（5 任务，先安全后消费面后形状后文案；每批验收=族差分收敛 + 16 组测试 + Python 全量 0 failed）

### T01：kill_process 四层防线 + expert 内置导入器（安全/功能缺失批）

- **文件**：`server/src/services/system.js`（K1 重写 killProcess + GBK 解码）、`server/src/services/expert-builtin.js`（E1 新建）、`server/src/services/experts.js`（E2/E3 错误形状 + 初始化挂接）、`tools/diff/mock-table.json`（taskkill GBK canned + tasklist 既有复用）、`tools/diff/fixtures/os-system/clipboard-process.json`（kill 五路径扩展 calls）、`tools/diff/fixtures/experts/experts-basic.json`（保持——builtin 导入后自动覆盖 c01/c08/probe）、`server/test/system-misc.mjs` + `server/test/experts.mjs`（断言更新）
- **依赖**：无（harness H1 不阻塞本批——kill/experts 不受 newline 影响）
- **验收**：①`npm run diff -- os-system experts`：c03 + experts 5 项全部收敛（kill 新增五路径 call 全 match；experts/c01/c08 packages=8 且 warnings 对齐、probe experts.json 形状一致）；②四层防线单测（伪造名/通配符/名单/非数字 pid/自身 pid）；③`test:system`+`test:experts` 全绿；④`npm run diff`（八族）零翻转
- **风险**：experts warnings 数组较长（AGENT_LIMIT_INTERSECTED 等）——由既有校验产出即收敛；若 Node 校验器与 Python 有字面差（如截断口径），以 Python validator 源码为准逐字对齐

### T02：消费面批（read_file 全语义 + 工具面 + provider + harness newline 前置）

- **文件**：`server/src/services/files.js`（F1/F2 + registry 缺省 limit 协同）、`server/src/services/provider.js`（PR1/PR4/PR5/PR6/PR7）、`server/src/services/provider.js` 或 prompts 工具构建处（PR2 required 省略）、prompts 库文件（PR3 LF 归一——读入归一一行 + 文件字节复核）、`tools/diff/fakes.py`（H1① 二进制种子写入）、`server/test/diff/node-driver.mjs` + `tools/diff/python_driver.py`（H1② 快照哈希 LF 归一 + `<PROXY>`/`since` N 规则配套）、`tools/diff/normalize-rules.json`（mask 键扩展 since、URL 掩蔽 PROXY）、`server/test/files.mjs` + `server/test/provider.mjs`（断言更新）
- **依赖**：T01（无强依赖，但按 QA 优先级串行；H1 落地后须先复跑八族验证零翻转再进入本批业务修复）
- **验收**：①H1 后八族零翻转（唯 files/workspace 快照与 read_file 期望值路径白名单式变化——须逐项归因记录）；②`npm run diff -- files provider`：files 13 项（read_file 5 + F2-F6 + 快照级联）与 prompts-tools 9 项（c01 转 ID-201 登记、c03/c04 修复、c08/c10-c14 修复）全部收敛或登记；③read_file 单测：keepends 尾行、offset-oob note、auto-limit 2000/1200、BUDGET 截断、64MB、difflib 猜错、binary ok 语义；④`test:files`+`test:provider` 全绿
- **风险**：H1 是 harness 变更——影响面=种子字节与快照哈希；执行纪律=先 H1 后复跑归因，再动业务代码（防伪差与真差混批不可归因）

### T03：形状批一（工作区/记忆/剪贴板/平台）

- **文件**：`server/src/services/workspace.js`（W1-W8）、`server/src/services/memory.js`（M1-M4）、`server/src/services/system.js`（CL1/CL2/PL1）、`server/src/services/files.js`（F3-F6 若 T02 未覆盖完）、`server/test/state-services.mjs`（断言更新）
- **依赖**：T02（workspace 快照依赖 H1②）
- **验收**：①`npm run diff -- workspace memory`：workspace 12 + memory 6 全收敛（快照经 H1 + W6/W8 前缀对齐后 sha 一致；`_glm_worklog.md` 若内嵌时间戳→行级掩蔽规则并归因记录）；②`npm run diff -- os-system`：clipboard 2 + platform（ID-202 登记）收敛；③`test:state` 全绿；④save_workspace_file 返回裸路径字符串的 bridge 消费核对（前端 callApi 返回值直接当路径用——P0-4 消费点确认，登记交接）
- **风险**：W6 裸字符串返回（mixed-kind）会改变 Node 自身前端消费预期——legacy 前端本就按 Python 口径消费，属修复而非破坏；React 侧若有按 `{ok,path}` 解析的调用点属 P0-3 范围（登记交接）

### T04：配置服务批 + webdav + mcp + rpc

- **文件**：`server/src/services/config-specs.js`（CF1-CF7 规格层新建）、`server/src/services/jsonstore.js`（readConfigNormalized/mergeConfigValidated 扩展）、`server/src/registry.js`（config 族通用注册改规格化调用 + RP1/RP2 rpc 语义）、`server/src/services/webdav.js`（WD1/WD2）、`server/src/services/mcp.js`（MC1-MC9）、`server/test/webdav.mjs` + `server/test/mcp.mjs` + `server/test/smoke.mjs`（config 断言）断言更新
- **依赖**：T03（批序；代码面独立）
- **验收**：①`npm run diff -- misc-config webdav mcp rpc`：config 18 + webdav 7 + mcp 10 + rpc 2 全收敛；②配置校验单测（非法 strategy/thinking/budget 拒绝且不落盘——probe 验证文件未被污染）；③rpc 单测（数组 payload 归一、未知 kwarg 合成错误、缺参合成错误）；④`test:webdav`+`test:mcp` 全绿
- **风险**：config-specs 是新抽象层——保持「规格=数据、读写=两个函数」，禁止按配置名写四个 service 类（过度设计）；sandbox_status 的 `available:true` 与 ID-201 的口径联动（沙箱声明一致性）

### T05：登记收口 + 全量复跑 + 结论归档

- **文件**：`tools/diff/intentional-deltas.json`（ID-201/202/203）、`tools/diff/normalize-rules.json`（终态）、`tools/diff/fixtures/selftest/*`（金丝雀重建——从本轮收敛 suspect 中选 3 例登记为分类器检测用例，恢复「刻意分叉检测」能力，结论文档 §四.6 建议）、`deliverables/dev-plan/p0-1c-fix-conclusions-<日期>.md`（结论：根因→修复→收敛证据 runId→残留 intentional→P0-2/P0-3/P0-4 交接清单）
- **依赖**：T01-T04 全部
- **验收**：①`npm run diff:all`：suspect 86 → 0（match 上升、intentional 5 → 8）、EXIT=0、两次复跑零翻转；②`npm run diff:coverage` exit 0 维持（139 fixture ∪ 13 uncovered 无回退）；③16 组 Node 测试逐组全绿；④Python 全量 1767/0/3/1 基线保持（零改动回归）；⑤新差异逐项归因（报告 diffPath 对照）；⑥结论文档按四分类更新（match 70→~130、intentional 5→8、suspect 65→0、uncovered 6 不变）
- **风险**：selftest 金丝雀重建须选**已修复但易回退**的形状（如 set_current_sid 既有 + 本轮 ts_iso/remaining），不引入未修复分叉

### 任务依赖图

```mermaid
graph LR
    T01[T01 kill四层+expert导入<br/>安全/功能] --> T02[T02 消费面+H1 newline<br/>read_file/工具面/provider]
    T02 --> T03[T03 形状批一<br/>workspace/memory/clipboard/platform]
    T03 --> T04[T04 配置服务批<br/>config/webdav/mcp/rpc]
    T04 --> T05[T05 登记收口+全量复跑<br/>结论归档]
```

### 复跑防交叉策略（同 P0-1b）

1. 批间全量 `npm run diff:all`（逐 call diffPath 使翻转可见可归因）；H1 harness 变更**单独先行提交并复跑八族归因**后才进入业务修复。
2. 同批先语义后文案：T01 先四层后响应形状；T02 先 keepends/分页后错误文案。
3. 登记最后落笔（T05 统一 ID-201/202/203，避免中途登记掩盖真差异）。
4. 每批后 Python raw 抽查 1 项未变（双侧原文保留在 `outputs/diff/<runId>/`）。

---

## 7. Node 侧共享知识更新（对 P0-1b §9 的增量）

1. **`ok(payload)`=纯 json.dumps**：Python 各服务的键集差异全部来自服务自己拼的 dict（含 `{ok:True}` 显式或不带 ok）——对齐时以**服务源码的 dict 字面量**为准，不要从「ok 包装惯例」推断。
2. **路径口径表**：响应回显路径分三类——文件服务类（make_dir/move/copy/delete/binary/缺文件错误）**绝对路径**；read/append 成功响应的 `path` **短路径（相对）**；workspace 绑定类按各方法 Python 源码逐一核对（本方案 §3.3 已列）。
3. **换行三纪律**：种子写二进制逐字节（驱动）；快照哈希 LF 归一（驱动）；prompt 库读入 LF 归一（业务）。Windows 文本模式翻译是环境产物，非契约语义。
4. **mock 表编码纪律**：tasklist/taskkill canned 按业务解码口径供字节（taskkill=GBK）；剪贴板槽位状态机沿用 P0-1b。
5. **rpc 契约**：kwargs-only（非 dict 归一 `{}`）；TypeError 文案按 CPython 固定格式合成（missing/unexpected 两种）。
6. **方言表增量**：`get_session_ws/get_ws_enabled` **无 ok 键**（Python 源码如此）；`save_workspace_file` 返回裸路径字符串；mcp 未启用类错误=flat `{error}`。
7. **测试 seam 清单不变**（HARBOR_GUARD_ARMED/HARBOR_TEST_MSGBOX/HARBOR_TEST_PICKED_PATH + Python 侧两个）；本轮新增 env：builtin experts 目录覆盖（`HARBOR_BUILTIN_EXPERTS_DIR`，缺省项目根相对路径）——生产入口不设置。

---

## 8. Python 侧改动：零（论证）

- 65 项全部为 Node 侧补齐/对齐（R1-R6 的修改面均在 `server/src/` 与 `tools/diff/`）；
- 三处例外（ID-201/202/203）均为登记而非 Python 变更；无「Python 缺陷需双向择优」项（其错误面不一致已在 P0-1b 修完）；
- R7（驱动 newline）是 harness 侧（`tools/diff/fakes.py` 等），非 `backend/` 业务代码；
- **结论：P0-1c 不提交任何 `backend/` 变更；Python 全量 1767/0/3/1 为只读回归基线。**

---

## 9. 待明确事项（需 team-lead / 用户决策）

1. **Q1 沙箱尾注（ID-201）口径**：确认「Node 不注入虚假沙箱声明 + P0-2 迁移后补真实尾注」的处置；替代方案是 Node 先注入措辞弱化的如实声明（如「命令无 OS 级沙箱隔离，敏感操作先确认」）——若选此，登记内容改为文案差异而非缺失，请裁决。
2. **Q2 `get_platform_info` 的 `python` 键（ID-202）**：确认「键冻结、值披露 node 运行时」的 ID-001 同构处置；若前端 About 面板会展示该值，需同步确认展示文案（P0-3 前端范围）。
3. **Q3 rpc TypeError 文案合成**：确认按 CPython 固定格式合成（两种格式串稳定）而非登记 intentional（后者会使 rpc 错误面永久双格式）——我倾向合成，但它是「仿解释器文案」的边界案例，请裁决。
4. **Q4 快照哈希 LF 归一的合规性**：harness 侧对快照文件在哈希前做 `\r\n`→`\n` 归一（理由：运行时文本模式是环境产物非契约）；若你认为文件字节级 newline 本身是契约（例如后续有哈希校验链消费），则改为 Node 业务写入对齐 CRLF——代价是 write_file/append_file/worklog 全部换行改写。请裁决口径。
5. **Q5 builtin experts 打包**：Node 侧读取 `backend/experts_builtin/`（Python 侧资产目录）。P0-4 Electron 打包时该目录需纳入（或迁移到 server 资产目录并双侧同步）——本轮仅 env 化路径，打包决策留给 P0-4 立项。
6. **Q6 kill_process 的 `/T` 树杀口径**：Python 用 `taskkill /T /F`（杀进程树）；Node 现仅 `/F`。对齐含 `/T`（影响面：杀父进程连带子进程——与 Python 生产一致）。确认无异议即按 `/T` 对齐。
7. **Q7 mcp_call_tool 用户拒绝方言**：MC6 顺序对齐后，「已启用+用户拒绝」路径的 info/skipped 方言双侧是否一致需 Python mcp_service 源码复核——若该路径也有字面差，按文案修复处理（不新开登记）。

---

## 附录：P0-2/P0-3/P0-4 交接累积清单（本轮新增）

- **P0-2**：沙箱服务迁移（ID-201 解除条件）；存储语义定案（ID-101/102/103 既有）。
- **P0-3（前端）**：save_workspace_file 裸路径字符串的 React 消费点核对；get_platform_info 展示文案；get_local_proxy base_url 口径消费点。
- **P0-4（桌面）**：builtin experts 资产打包（Q5）；admin Electron 对话框（既有）；browser 正向路径真机验收（既有 P1-2）。
