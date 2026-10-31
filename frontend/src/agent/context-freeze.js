/* ================= P1 冻结式压缩（缓存友好） ================= */
function ensureMsgId(m) { return m.id || (m.id = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)); }
function frozenForm(m) {
  // 修复 S25：多模态压缩分支移到 user 判断之前——原第 4 行对 user 无条件 return，
  // 使 U8 分支成死代码（旧任务的图片 base64 每轮全量重发，token 成本远超设计）。
  if (Array.isArray(m.content)) {       // U8: 旧任务多模态压占位，图片不再每轮重发（只压 image_url/video_url part）
    return m.content.map(p =>
      p.type === 'text' ? String(p.text || '').slice(0, 300) :
      p.type === 'image_url' ? '[图片]' :
      p.type === 'video_url' ? '[视频]' : '').filter(Boolean).join('\n');
  }
  if (m.role === 'user') return null;   // 用户内容(含上传文档)永远全量保留（多模态数组已在上方处理）
  if (m.role === 'tool' && m.content) {
    if (m.__tool === 'read_file' || m.__tool === 'read_more') return null;   // 原文永久保留
    return '[工具结果已固化摘要,原文 ' + String(m.content).length + ' 字] ' + String(m.content).slice(0, 120);
  }
  if (m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 1500)
    return m.content.slice(0, 600) + '…(旧回复已压缩)';
  return null;
}
function freezeBeforeCurrentTask(s) {
  if (!s.apiFrozen) s.apiFrozen = {};
  const msgs = s.messages || [];
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === 'user') { lastUserIdx = i; break; } }
  for (let i = 0; i < lastUserIdx; i++) {
    const m = msgs[i];
    const id = ensureMsgId(m);
    if (!(id in s.apiFrozen)) {
      const f = frozenForm(m);
      if (f) s.apiFrozen[id] = f;
    }
  }
}
function buildMessagesForAPI(msgs) {
  const s = (typeof getCurrentSession === 'function') ? getCurrentSession() : null;
  const frozen = s && s.apiFrozen ? s.apiFrozen : {};
  const out = [];
  for (const m of msgs) {
    if (m.role === 'assistant' && !m.tool_calls && (m.content === null || m.content === '')) continue;
    const copy = { role: m.role };
    if (m.role === 'tool') {
      copy.tool_call_id = m.tool_call_id; copy.content = m.content ?? '';
      // 修复 fe-H3（四轮）：透传 __tool——原副本不带该字段，30-history-shrink 的
      // read_file/read_more 豁免（m.__tool !== 'read_file'）对副本恒真，「原文永久
      // 保留」承诺被后置瘦身破坏（AI 被禁止重读又拿不到原文，只能凭残片幻觉）。
      // 该字段仅瘦身高层内部使用，shrinkHistoryForApi 出口处剥离、不进 API 请求体。
      if (m.__tool !== undefined) copy.__tool = m.__tool;
    }
    else if (m.role === 'assistant') {
      copy.content = typeof m.content === 'string' ? m.content : null;
      if (m.tool_calls && m.tool_calls.length) copy.tool_calls = m.tool_calls;
    } else copy.content = m.content ?? '';
    const mid = m.id;
    if (mid && frozen[mid] !== undefined && copy.content != null) {
      copy.content = frozen[mid];
    }
    out.push(copy);
  }
  return out;
}
