/* ================= 会话存储 ================= */
/**
 * 修复 S26：会话列表统一归一化校验。
 * 原实现直接 `JSON.parse(raw)` 赋给 sessions：`{}` 能通过 parse 但后续 `sessions.find` /
 * `s.messages.forEach` 级联 TypeError；坏条目（非对象/缺 messages）也无任何防护。
 */
function _sessionStateRead() {
  return (typeof AppState !== 'undefined') ? AppState.sessions : sessions;
}
function _sessionStateWrite(value) {
  if (typeof AppState !== 'undefined') AppState.sessions = value;
  else sessions = value;
}
function _sessionStateCurrentId() {
  return (typeof AppState !== 'undefined') ? AppState.currentSessionId : currentSessionId;
}

function normalizeSessions(raw) {
  let arr = null;
  try {
    const p = (typeof raw === 'string') ? JSON.parse(raw || '[]') : raw;
    if (Array.isArray(p)) arr = p;
  } catch (e) { arr = null; }
  if (!arr) return [];
  const now = Date.now();
  return arr.filter(x => x && typeof x === 'object').map(x => {
    const s = {
      id: (x.id != null && String(x.id)) || ('s_recover_' + now + '_' + Math.random().toString(36).slice(2, 7)),
      title: (x.title != null) ? String(x.title) : '',
      createdAt: Number(x.createdAt) || now,
      updatedAt: Number(x.updatedAt) || now,
      messages: Array.isArray(x.messages) ? x.messages : []   // 修复 S26：75-token-stat 等消费方级联 TypeError 的源头
    };
    // 保留已知附加字段（压缩态/已读键/预算标记等）
    if (x.apiFrozen && typeof x.apiFrozen === 'object') s.apiFrozen = x.apiFrozen;
    if (Array.isArray(x._readKeys)) s._readKeys = x._readKeys;
    if (typeof x.worklogInjected === 'boolean') s.worklogInjected = x.worklogInjected;
    if (typeof x.autoResume === 'number') s.autoResume = x.autoResume;
    if (typeof x.__budgetWarned === 'boolean') s.__budgetWarned = x.__budgetWarned;
    if (x.runStatus === 'working' || x.runStatus === 'completed' ||
        x.runStatus === 'paused' || x.runStatus === 'failed') {
      s.runStatus = x.runStatus;
    }
    // 修复 S8（二轮）遗漏 + UX-1（v1.4）：单调花费计数器与压缩备份必须跨重启保留——
    // 原 normalizeSessions 白名单会静默丢弃这两个顶层键（计数器丢→预算硬停被压缩
    // 洗白的防护重启即失效；备份丢→「恢复原文」跨重启失效）
    if (typeof x._spentCost === 'number') s._spentCost = x._spentCost;
    if (typeof x._spentTokens === 'number') s._spentTokens = x._spentTokens;
    if (x._compactBackup && typeof x._compactBackup === 'object' && Array.isArray(x._compactBackup.msgs)) {
      s._compactBackup = x._compactBackup;
    }
    // v1.8.0 M3：计划 task_id 白名单放行（100-send 批准后落库；85-session-mgmt
    // 真删 session_purge 的 taskIds 数据源——原白名单会静默丢弃导致恒 '[]'）
    if (x.plan && typeof x.plan === 'object' && x.plan.task_id) s.plan = { task_id: String(x.plan.task_id) };
    if (x.expert && typeof x.expert === 'object' && !Array.isArray(x.expert)) s.expert = x.expert;
    // 项目空间绑定：项目会话跨重启保留项目身份与专属文件夹，普通任务三字段为空。
    if (x.projectId != null && String(x.projectId).trim()) s.projectId = String(x.projectId).trim();
    if (x.projectName != null && String(x.projectName).trim()) s.projectName = String(x.projectName).trim();
    if (x.projectWorkspace != null && String(x.projectWorkspace).trim()) {
      s.projectWorkspace = String(x.projectWorkspace).trim();
    }
    // 生成式 UI 只恢复非秘密的 spec 引用；不保存正文、工具结果或凭证。
    if (x.uiGenerative && typeof x.uiGenerative === 'object' &&
        Array.isArray(x.uiGenerative.specs)) {
      const specs = x.uiGenerative.specs.slice(0, 24).map(spec => {
        if (!spec || typeof spec !== 'object' || !spec.specId) return null;
        const item = { specId: String(spec.specId).slice(0, 128),
          revision: Number.isInteger(spec.revision) && spec.revision >= 0 ? spec.revision : 0 };
        if (typeof spec.layout === 'string') item.layout = spec.layout.slice(0, 32);
        return item;
      }).filter(Boolean);
      if (specs.length) s.uiGenerative = { specs };
    }
    // 群聊协作（Beta, Round 8 立项）：群配置跨重启保留——members/turn/phase/
    // handoffs 缺一不可（丢了群聊退化成普通会话）。
    if (x.group && typeof x.group === 'object' && Array.isArray(x.group.members)) {
      s.group = {
        members: x.group.members.filter(m => m && typeof m === 'object' && m.id && m.name)
          .slice(0, 6).map(m => ({ id: String(m.id), name: String(m.name).slice(0, 12),
            model: typeof m.model === 'string' ? m.model : '',
            role: typeof m.role === 'string' ? m.role.slice(0, 2000) : '',
            host: m.host === true })),
        turn: typeof x.group.turn === 'string' ? x.group.turn : '',
        phase: x.group.phase === 'running' ? 'paused' : (x.group.phase === 'paused' ? 'paused' : 'idle'),
        round: Number(x.group.round) || 0,
        autoRelay: x.group.autoRelay !== false,
      };
      // Round 15 优化①：跨端点 Key 快照必须跨重启保留——原白名单静默丢弃
      // group.endpoints，重启后绑了 deepseek:: 的成员全部报「缺端点」。
      // Key 与 config.json 同级信任域（后端 sessions.json），可存；localStorage
      // 镜像在 _sessionsMirrorProjection 里剥 Key（W29 纪律不破）。
      if (x.group.endpoints && typeof x.group.endpoints === 'object') {
        const eps = {};
        Object.keys(x.group.endpoints).forEach(k => {
          const ep = x.group.endpoints[k];
          if (ep && typeof ep === 'object' && ep.base_url) {
            eps[k] = { name: String(ep.name || k).slice(0, 40),
              base_url: String(ep.base_url).slice(0, 300),
              api_key: String(ep.api_key || '').slice(0, 300) };
          }
        });
        if (Object.keys(eps).length) s.group.endpoints = eps;
      }
      // Round 15 优化②：显式 @ 队列（成员 id 序列）跨重启保留——暂停后关应用，
      // 重开「继续接力」仍按群主点名顺序把余下成员走完
      if (Array.isArray(x.group.mentionQueue)) {
        const q = x.group.mentionQueue.filter(id => typeof id === 'string' && id).slice(0, 6);
        if (q.length) s.group.mentionQueue = q;
      }
      if (s.group.members.length < 2) delete s.group;   // 成员残缺 → 退化普通会话
    }
    return s;
  });
}
async function loadSessions() {
  // 修复 W30：双源按 updatedAt 合并——原「后端优先、失败回退本地」在后端写失败时会静默丢新会话
  let backend = [];
  let local = [];
  let backendOk = false;   // 实现 v1.6 W27：后端读取成败标志——墓碑清理只在读成功后进行
  try {
    // P0-4 修正：HTTP 桥（Electron）同样从 DB 读会话——原门控使新装端会话列表为空
    if ((window.pywebview && window.pywebview.api) || window.HARBOR_API_BASE) {
      backend = normalizeSessions(await callApi('get_sessions', []));
      backendOk = true;
    }
  } catch (e) {}
  try { local = normalizeSessions(localStorage.getItem('glm_sessions')); } catch (e) {}
  // 修复 W24（二轮）：删除墓碑——后端写失败时下次启动合并会把已删会话复活；
  // 墓碑记录在 localStorage（本地删除即生效，不依赖后端成功），合并时过滤；
  // 后端列表已不含的 id 出棺（防墓碑无限膨胀）
  // 修复 W27（v1.6）：原无脑按 backendIds 过滤墓碑——后端读取失败（异常/无
  // pywebview）时 backendIds 恒空 → 墓碑被清空 → 已删对话在下次成功读取时
  // 复活。仅在 backendOk 时执行出棺。
  let tomb = [];
  try { tomb = JSON.parse(localStorage.getItem('glm_deleted_ids') || '[]'); } catch (e) { tomb = []; }
  const tombSet = new Set(tomb.filter(x => x && typeof x === 'string'));
  if (backendOk) {
    const backendIds = new Set(backend.map(s => s.id));
    const keptTomb = tomb.filter(id => backendIds.has(id));
    try { localStorage.setItem('glm_deleted_ids', JSON.stringify(keptTomb)); } catch (e) {}
  }
  const byId = new Map();
  const put = (list) => list.forEach(s => {
    if (tombSet.has(s.id)) return;   // 修复 W24：墓碑中的 id 不参与合并
    const prev = byId.get(s.id);
    if (!prev || (s.updatedAt || 0) > (prev.updatedAt || 0)) byId.set(s.id, s);
  });
  // Round 7 时序修正：先 backend 后 local——两侧同 updatedAt 时（saveSessions
  // 同一对象双写，必然相等）必须取**后端完整版**：本地镜像是配额投影（最近 24
  // 条+正文 2k 截断），先入会让截断版压制完整版，且随后被写回后端=永久丢正文。
  // W30 场景不受影响：后端写失败/读失败时本地新版靠 updatedAt 严格大于胜出。
  put(backend); put(local);   // 同 id 时取 updatedAt 较新的一侧（平局=后端完整版）
  _sessionStateWrite([...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 60));
}
// 修复 建议㉜（三轮）：saveSessions 串行化——原并发调用可让旧快照后落盘覆盖新快照
let _saveChain = Promise.resolve();
// 修复 ㉚（三轮）：全量序列化节流——流式/连续保存（每消息、每工具调用）原每次都对
// 全量 sessions 做 JSON 双序列化 + 双端写（localStorage + 后端）。现合并窗口：
// 首次立即执行，窗口内后续调用合并为一次 trailing 落盘；await 语义不变（返回的
// promise 仍在其实际写入完成后 resolve），末态必达，丢的只是中间快照。
//
// 2026-10-30（确认响应缓慢根因治理）：实测 60 会话×160 消息的单次全量落盘为
// 89.6ms 主线程同步占用 / 17.3MB 载荷（tools/perf_confirm_path.js）。三处收敛：
//   ① 单次 stringify——原 `JSON.parse(JSON.stringify(x, replacer))` 先深克隆再序列化，
//      同一个 replacer 跑两遍；直接 stringify 可省掉一整趟遍历与一份全量副本。
//   ② 未变更短路——保存前比对每会话廉价的变更签名（updatedAt/消息数/状态/标题/
//      计划/项目），与上次成功落盘完全一致则直接返回：重复的状态刷新不再付出
//      序列化成本。
//   ③ 活动运行期间拉长合并窗口（300ms→900ms）——工具批次密集时后端写入频次降 3 倍，
//      减少 guard_check / guard_confirm_token 等确认 RPC 与 17MB 写盘争 GIL 的概率。
//      trailing 语义不变：末态必达。
const SAVE_THROTTLE_MS = 300;
const SAVE_THROTTLE_BUSY_MS = 900;
// 本地镜像（localStorage）是后端写失败时的恢复源，不是主存储：按 Chromium ~10MB
// 配额做压缩投影，避免每次保存都触发 QuotaExceeded（原 17MB 必经失败路径）。
const LOCAL_MIRROR_MAX_SESSIONS = 24;
const LOCAL_MIRROR_MAX_CHARS = 2000;
let _saveLastRun = 0;
let _saveTrailer = null;
let _savedSignatures = null;   // id → 签名；null 表示尚无成功落盘基线
function _enqueueSave(run) {
  _saveChain = _saveChain.then(run).catch(() => {});
  return _saveChain;
}
/** 会话变更签名：只读标量与计数，不触碰消息正文（零序列化成本）。
 *
 * 字段清单必须与 normalizeSessions 保留的持久化字段对齐——漏一个字段，
 * 该字段单独变化时就会被误判为「未变更」而跳过落盘（重启后丢状态）。
 * 已覆盖：基础四件 + runStatus/autoResume/plan/project* + 单调花费计数 +
 * apiFrozen（冻结参数）+ _readKeys（已读键）+ worklogInjected + expert +
 * _compactBackup + uiGenerative。 */
function _sessionSaveSignature(s) {
  if (!s || !s.id) return '';
  const readKeys = Array.isArray(s._readKeys) ? s._readKeys : null;
  return [
    s.updatedAt || 0,
    s.messages ? s.messages.length : 0,
    s.runStatus || '',
    s.title || '',
    s.autoResume || 0,
    (s.plan && s.plan.task_id) || '',
    s.projectId || '',
    // R37 修复（D9）：projectName/projectWorkspace/_spentCost 也在持久化白名单
    // 里（normalizeSessions），原签名漏记——单独改项目名/工作区/花费时被
    // 「未变更短路」跳过落盘，重启回退。
    s.projectName || '',
    s.projectWorkspace || '',
    typeof s._spentTokens === 'number' ? s._spentTokens : '',
    typeof s._spentCost === 'number' ? s._spentCost : '',
    // apiFrozen 是小型参数对象，直接序列化（每个会话仅一次，成本可忽略）
    s.apiFrozen ? JSON.stringify(s.apiFrozen) : '',
    // R20 扫描修复：群聊配置改动（成员/端点 Key/点名队列）原不在签名里——
    // 「未变更短路」命中 → 改完成员身份不发言直接关应用 → 重启全丢
    s.group ? JSON.stringify(s.group) : '',
    readKeys ? readKeys.length + ':' + readKeys[readKeys.length - 1] : '',
    s.worklogInjected === true ? 1 : '',
    s.__budgetWarned === true ? 1 : '',
    // Round 7 修复[2]：expert.events 进签名——expert 对象实际只装事件日志
    // （expert/events.js:8 唯一写法），原签名只认 expert.id/name（无人写入恒
    // 空）→ journal appendOnce 后签名零变化，未变更短路整跳过，事件日志只能
    // 搭载其他字段的变更落盘；纯事件轮（失败/取消早退、无 usage 端点）重启即丢。
    (s.expert && s.expert.events && s.expert.events.length
      ? s.expert.events.length + ':' + ((s.expert.events[s.expert.events.length - 1] || {}).eventId || '')
      : (s.expert && (s.expert.id || s.expert.name)) || ''),
    (s._compactBackup && s._compactBackup.msgs && s._compactBackup.msgs.length) || '',
    (s.uiGenerative && s.uiGenerative.specs && s.uiGenerative.specs.length) || '',
    // 生成式UI 视图变更计数（2026-11-03）：uiSpec 的写入/打卡只改消息对象内部，
    // 不碰 updatedAt/消息数——不在这里记一笔，那次 saveSessions 会被「未变更短路」
    // 直接跳过，重启后视图与打卡态全丢（真机实证）。
    s._uiSpecRev || '',
  ].join('\u0001');
}
function _sessionSignatures(list) {
  const map = new Map();
  (list || []).forEach(s => { if (s && s.id) map.set(s.id, _sessionSaveSignature(s)); });
  return map;
}
function _allSignaturesEqual(current, saved) {
  if (!saved || current.size !== saved.size) return false;
  for (const [id, sig] of current) { if (saved.get(id) !== sig) return false; }
  return true;
}
/** 落盘用瘦身 replacer（后端全文，单串上限 30k；图片/视频只留占位）。 */
function _sessionsPersistReplacer(key, v) {
  if (v && typeof v === 'object') {
    if (v.type === 'image_url') return { type: 'text', text: '[图片]' };
    if (v.type === 'video_url') return { type: 'text', text: '[视频]' };
  }
  if (typeof v === 'string' && v.length > 30000) return v.slice(0, 30000) + '…(存储截断)';
  return v;
}
/** R38-R3（F2b 调研）：逐会话序列化缓存——全量 stringify（60 会话×160 消息
 * 实测 17.3MB/89.6ms 主线程）的根治。payload 契约不变（save_sessions 恒
 * 全量数组）：未变更会话直接复用上次序列化串，仅重串变更会话。缓存键=
 * 既有变更签名（与「未变更短路」同一判定，语义严格等价——签名已覆盖全部
 * 持久化字段）；JSON.stringify(数组) 的元素拼接与逐元素 stringify 逐字节一致。
 * 容量治理：会话集合收缩时清理失联 id。 */
let _sessionJsonCache = new Map();   // id -> {sig, json}
function _serializeSessions(sessions) {
  const parts = new Array(sessions.length);
  const seen = new Set();
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const sig = _sessionSaveSignature(s);
    const hit = _sessionJsonCache.get(s.id);
    if (hit && hit.sig === sig) {
      parts[i] = hit.json;
    } else {
      const json = JSON.stringify(s, _sessionsPersistReplacer);
      _sessionJsonCache.set(s.id, { sig, json });
      parts[i] = json;
    }
    seen.add(s.id);
  }
  if (_sessionJsonCache.size > seen.size + 16) {
    for (const id of Array.from(_sessionJsonCache.keys())) {
      if (!seen.has(id)) _sessionJsonCache.delete(id);
    }
  }
  return '[' + parts.join(',') + ']';
}
/** 本地镜像投影：仅保留最近 N 条会话 + 正文按 2k 截断，确保落在配额内。 */
function _sessionsMirrorProjection(list) {
  const recent = (list || []).slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, LOCAL_MIRROR_MAX_SESSIONS);
  return JSON.stringify(recent, (key, v) => {
    if (v && typeof v === 'object') {
      if (v.type === 'image_url') return { type: 'text', text: '[图片]' };
      if (v.type === 'video_url') return { type: 'text', text: '[视频]' };
    }
    // W29 纪律：localStorage 镜像永不落明文 Key（group.endpoints 的跨端点 Key
    // 只存后端 sessions.json；本地镜像剥掉——丢镜像不丢安全）
    if (key === 'api_key') return '';
    if (typeof v === 'string' && v.length > LOCAL_MIRROR_MAX_CHARS) {
      return v.slice(0, LOCAL_MIRROR_MAX_CHARS) + '…(镜像截断)';
    }
    return v;
  });
}
async function saveSessions() {
  const run = async () => {
  let currentSessions = _sessionStateRead();
  if (currentSessions.length > 60) {
    currentSessions.sort((a, b) => b.updatedAt - a.updatedAt);
    currentSessions = currentSessions.slice(0, 60);
    _sessionStateWrite(currentSessions);
  }
  // ② 未变更短路：与上次成功落盘的签名完全一致 → 无需序列化与双端写
  const sigs = _sessionSignatures(currentSessions);
  if (_allSignaturesEqual(sigs, _savedSignatures)) return;
  // ① 序列化：R38-R3 起走逐会话缓存（未变更会话复用上串，仅重串变更者；
  // 产物与全量 stringify 逐字节一致，save_sessions 全量数组契约不变）
  const data = _serializeSessions(currentSessions);
  let _backendPersisted = false;
  try { localStorage.setItem('glm_sessions', _sessionsMirrorProjection(currentSessions)); }
  catch (e) { toast('本地会话缓存写入失败（浏览器存储可能已满）: ' + e.message, 'warn'); }   // 修复 建议㊶（二轮）：原完全静默
  try {
    // P0-4 修正：HTTP 桥（Electron）同样落盘（R4 纪律：恒提交全量数组）
    if ((window.pywebview && window.pywebview.api) || window.HARBOR_API_BASE) {
      await callApi('save_sessions', [data]);
      _savedSignatures = sigs;   // 仅在后端写成功后更新基线（失败时下次仍全量重试）
      _backendPersisted = true;
    }
  } catch (e) { toast('会话历史保存失败：' + e.message, 'warn'); }   // v1.2 R3：静默吞错 → 可见
  // R37 修复（D34）：纯浏览器环境（无 pywebview/HTTP 桥）镜像即权威——原基线
  // 永不更新，签名短路永不命中，每次保存都全量双写。
  if (!_backendPersisted && !((window.pywebview && window.pywebview.api) || window.HARBOR_API_BASE)) {
    _savedSignatures = sigs;
  }
  };
  const now = Date.now();
  // R31：任意会话有在途 run 都走快速节流（后台并行的输出同样不能丢）
  const streaming = (typeof getActiveRuns === 'function')
    ? getActiveRuns().length > 0
    : (typeof isStreaming !== 'undefined' && isStreaming);
  const windowMs = streaming ? SAVE_THROTTLE_BUSY_MS : SAVE_THROTTLE_MS;
  if (now - _saveLastRun >= windowMs) {
    _saveLastRun = now;
    return _enqueueSave(run);
  }
  // 窗口内：合并为一次 trailing 执行（run 在执行时才读全局 sessions，落的是最新末态）
  if (!_saveTrailer) {
    _saveTrailer = new Promise((resolve) => {
      setTimeout(() => {
        _saveTrailer = null;
        _saveLastRun = Date.now();
        resolve(_enqueueSave(run));
      }, windowMs - (now - _saveLastRun));
    });
  }
  return _saveTrailer;
}
function getCurrentSession() {
  const currentId = _sessionStateCurrentId();
  return _sessionStateRead().find(s => s.id === currentId);
}

function rememberDeletedSession(id) {
  // 修复 W24（二轮）：删除写入墓碑——saveSessions 后端写失败时，下次启动的双源合并
  // 不再把该 id 从后端旧列表里复活
  try {
    let tomb = [];
    try { tomb = JSON.parse(localStorage.getItem('glm_deleted_ids') || '[]'); } catch (e) {}
    if (!tomb.includes(id)) { tomb.push(id); localStorage.setItem('glm_deleted_ids', JSON.stringify(tomb)); }
  } catch (e) {}
}

