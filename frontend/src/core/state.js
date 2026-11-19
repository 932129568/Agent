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
const guardTrusted = new Set();        // R2：会话内已信任的护栏操作（R57 起 per-sid 持久——切会话不清，见 sessions/controller.js）
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
/* ================= R59 M3/M4：跨域共享的可变计数/载荷（下沉至叶，拆互绕环） ================= */
// R59 M3：MCP 服务器面板修订号（原 mcp-panel.js 私有——generative/fixtures 数据源
// 新鲜度读取它形成 fixtures↔mcp-panel 互绕；叶化后两侧单向引用）
let mcpServersRevision = 0;
// R59 M4：记忆面板 last-wins 请求序号 + 最近列表载荷（原 settings/memory.js 私有，
// generative/fixtures 的 memory.items 数据源读取——叶化拆 memory↔fixtures 环）
let memoryReqSeq = 0;          // last-wins 请求序号（每次触发递增，旧请求失效）
let mmLastItems = [];          // 最近一次列表载荷（搜索过滤/重渲染用）
/* R59 M2：ws 快捷条刷新钩子宿主（早位叶——utils 调用、quick 注册，
 * 拆 utils↔quick 互绕环的控制流反转缝） */
let _wsQuickRefreshHook = null;
function setWsQuickRefreshHook(fn) { _wsQuickRefreshHook = fn; }
function wsQuickRefreshHookCall() {
  try { if (typeof _wsQuickRefreshHook === 'function') _wsQuickRefreshHook(); } catch (e) {}
}
/* R59 M7：专家一次性选择态（原 expert/center.js 私有——controller 会话切换要
 * clearExpertSelection，形成 controller→center 前向边；叶化后三方单向引用） */
let expertNextSelection = null;        // 一次性消费：下一次发送走专家 run
let expertSelectionSessionId = '';     // 选择时的会话（切换会话即失效）
let expertSelectionLabelText = '';     // 输入框左挂的专家徽标文案
/* chip 置隐是 DOM 行为，叶模块不摸 DOM——center.js 启动时注册钩子（与 R59 缝模式同构） */
let _expertChipResetHook = null;
function setExpertChipResetHook(fn) { _expertChipResetHook = fn; }
function clearExpertSelection() {
  expertNextSelection = null; expertSelectionSessionId = ''; expertSelectionLabelText = '';
  try { if (typeof _expertChipResetHook === 'function') _expertChipResetHook(); } catch (e) {}
}
