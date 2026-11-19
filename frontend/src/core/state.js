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
  // v2.1 M1：清专家选择时同步摘掉输入舱里的原生专家胶囊（否则胶囊与选择态双源不一致）
  composerTokenRemoveBySource(composerActiveSid(), 'builtin_pkg');
}
/* ================= v2.1 M1：单轨输入舱内联胶囊状态（叶模块零 DOM 依赖） =================
 * 统一承接原生专家包（builtin_pkg）、功能市场目录（hub_catalog）与文件引用（file_ref）。
 * 按会话 ID 隔离；空会话态 '' 会在首条消息 ensureSession() 后自动迁移至真实 sid。
 * 叶化纪律：本段不调用任何 hub* 函数、不摸 DOM——渲染侧经 setComposerTokensRenderHook
 * 注册钩子（与 R59 M2/M7 的缝模式同构）。scc_ratchet 余量为 0，多一个符号级环即红。
 * 用 var 而非 const：clearExpertSelection（L47）在本段声明之前就已定义，会话切换时
 * 可能在模块求值尚未走到 L60 就被调用；var 提升为 undefined + 各访问器首行空值守卫，
 * 杜绝 const 的 TDZ 抛错（实测 const 亦能过全部门禁，此处取更保守的写法）。 */
var composerTokensBySid = Object.create(null);
let _composerTokensRenderHook = null;
let _composerTokenSeq = 0;

function setComposerTokensRenderHook(fn) { _composerTokensRenderHook = fn; }
function _composerNotifyTokens() {
  try { if (typeof _composerTokensRenderHook === 'function') _composerTokensRenderHook(); } catch (e) {}
}
function composerActiveSid() {
  // 只用本文件的 currentSessionId，不引用 app-state.js 的 AppState：两者语义等价
  // （app-state.js L6 的 AppState.currentSessionId 就是本文件 currentSessionId 的
  // getter 代理），但 state.js 序 6 早于 app-state.js，引用它会新增一条后向隐藏边，
  // gen_allowlist --check 判「新增未声明前向引用 157→158」而红（实测确认）。
  return (typeof currentSessionId !== 'undefined' && currentSessionId)
    ? String(currentSessionId) : '';
}
function composerGetTokens(sid) {
  if (!composerTokensBySid) return [];
  const key = (sid !== undefined && sid !== null) ? String(sid) : composerActiveSid();
  const orphan = composerTokensBySid[''];
  // 空会话态选的胶囊随首条消息 ensureSession() 迁移到真实 sid，否则发送时查不到
  // （与 hubDirectiveFor 的空键回退同语义；R62 同款问题）。迁移用合并而非覆盖：
  // 先放 '' 桶（选择更早），再按「主角色唯一」保留后者，杜绝两个 expert 并存。
  if (key && key !== '' && Array.isArray(orphan) && orphan.length) {
    const base = Array.isArray(composerTokensBySid[key]) ? composerTokensBySid[key] : [];
    const merged = orphan.concat(base);
    let mainIdx = -1;
    for (let i = merged.length - 1; i >= 0; i--) {
      const t = merged[i];
      if (t && (t.kind === 'expert' || t.kind === 'team')) { mainIdx = i; break; }
    }
    const out = [];
    for (let i = 0; i < merged.length; i++) {
      const t = merged[i];
      if (t && (t.kind === 'expert' || t.kind === 'team') && i !== mainIdx) continue;
      out.push(t);
    }
    composerTokensBySid[key] = out;
    delete composerTokensBySid[''];
  }
  return Array.isArray(composerTokensBySid[key]) ? composerTokensBySid[key] : [];
}
function composerTokenAdd(sid, token) {
  if (!composerTokensBySid || !token) return null;
  const key = (sid !== undefined && sid !== null) ? String(sid) : composerActiveSid();
  if (!Array.isArray(composerTokensBySid[key])) composerTokensBySid[key] = [];
  const list = composerTokensBySid[key];
  const kind = token.kind || 'expert';
  // 主角色唯一：expert/team 新选自动替换旧主角色；skill/connector/file 可叠加
  if (kind === 'expert' || kind === 'team') {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] && (list[i].kind === 'expert' || list[i].kind === 'team')) list.splice(i, 1);
    }
  }
  _composerTokenSeq += 1;
  const item = Object.assign({}, token, {
    uid: token.uid || ('tok_' + Date.now() + '_' + _composerTokenSeq),
    kind: kind,
    label: token.label || token.id || '',
    scope: token.scope === 'session' ? 'session' : 'once',
  });
  list.push(item);
  _composerNotifyTokens();
  return item;
}
function composerTokenRemove(sid, uid) {
  if (!composerTokensBySid || !uid) return false;
  const key = (sid !== undefined && sid !== null) ? String(sid) : composerActiveSid();
  const list = composerTokensBySid[key];
  if (!Array.isArray(list)) return false;
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].uid === uid) { list.splice(i, 1); _composerNotifyTokens(); return true; }
  }
  return false;
}
function composerTokenRemoveBySource(sid, source) {
  if (!composerTokensBySid || !source) return 0;
  const key = (sid !== undefined && sid !== null) ? String(sid) : composerActiveSid();
  const list = composerTokensBySid[key];
  if (!Array.isArray(list)) return 0;
  let removed = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].source === source) { list.splice(i, 1); removed += 1; }
  }
  if (removed) _composerNotifyTokens();
  return removed;
}
function composerConsumeOnceTokens(sid) {
  if (!composerTokensBySid) return [];
  const key = (sid !== undefined && sid !== null) ? String(sid) : composerActiveSid();
  const list = composerTokensBySid[key];
  if (!Array.isArray(list) || !list.length) return [];
  const consumed = [];
  const kept = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (t && t.scope === 'session') kept.push(t); else consumed.push(t);
  }
  if (!consumed.length) return [];
  composerTokensBySid[key] = kept;
  _composerNotifyTokens();
  return consumed;
}
function composerTokenSetScope(sid, uid, scope) {
  if (!composerTokensBySid || !uid) return false;
  const key = (sid !== undefined && sid !== null) ? String(sid) : composerActiveSid();
  const list = composerTokensBySid[key];
  if (!Array.isArray(list)) return false;
  const next = scope === 'session' ? 'session' : 'once';
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (t && t.uid === uid) {
      if (t.scope === next) return true;
      list[i] = Object.assign({}, t, { scope: next });
      _composerNotifyTokens();
      return true;
    }
  }
  return false;
}
