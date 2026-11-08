/* ================= 常量与状态 ================= */
const API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
let lastReqAt = 0;
let pendingShots = [];
let lastShotHash = null;
let currentSessionId = null;
let sessions = [];
let isStreaming = false;
let attachments = [];
let abortController = null;
let backendWarning = null;
/* v1.2 新增状态 */
const guardTrusted = new Set();        // R2：会话内已信任的护栏操作（切会话即清空）
let guardConfig = null;                // R2：护栏配置缓存（boot 时从后端加载）
let providerState = { enabled: false };// R6：当前自定义端点（boot 时从 config 加载）
/* v1.3 MCP 新增状态 */
const mcpTrusted = new Set();          // R3：会话内已信任的 MCP 工具（键 server__tool；
                                       // 修复 W26：切会话/新会话即清空——与「本会话内不再提示」文案对齐）
let mcpServers = [];                   // R5：MCP 服务器面板缓存（loadMcpServers 回填）
// 修复 ㊿（三轮）：MCP 列表加载失败标记（渲染层区分「失败」与「真的没有服务器」）
let mcpLoadFailed = false;
// 生成式 UI 的临时投影状态；业务会话与配置仍由原 owner 管理。
let uiGenerative = { views: {}, toolResults: {}, toolRevision: 0, lastRun: null };
