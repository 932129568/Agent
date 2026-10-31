/* ================= SessionStore 门面 =================
 * 仅包装 sessions/store.js 的既有函数，不创建第二存储。 */
const SessionStore = Object.freeze({
  normalize: normalizeSessions,
  load: loadSessions,
  save: saveSessions,
  current: getCurrentSession,
  rememberDeleted: rememberDeletedSession,
});
