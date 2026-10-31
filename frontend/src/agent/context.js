/* ================= A2 历史瘦身（发送副本瘦身，原始历史保留） ================= */
/* 修复 TOK-3（v1.4）：收紧一档——keepTail 8→6 / toolMax 600→450 / aiMax 1200→900。
 * 收紧与 UX-1 透明化（弱化标记 + 可恢复备份）同批上线，标记可见对冲「AI 忘了」反噬。
 * read_file/read_more 豁免规则一字不动（原文保留机制不变）。 */
const SHRINK = { keepTail: 6, toolMax: 450, aiMax: 900 };
const SHRINK_LEN = { toolHead: 300, toolTail: 120, aiHead: 500, aiTail: 150 };

/** 工具结果瘦身副本（shrinkHistoryForApi 与 UX-1 标记共用同一口径，防两处漂移） */
function shrinkToolCopy(c) {
  return c.slice(0, SHRINK_LEN.toolHead) +
    '\n…[旧工具结果已瘦身省 token,原' + c.length + '字;需精确原文请重新调用对应工具(read_file 传 force=true)]…\n' +
    c.slice(-SHRINK_LEN.toolTail);
}
/** AI 回复瘦身副本（同上） */
function shrinkAiCopy(c) {
  return c.slice(0, SHRINK_LEN.aiHead) + '\n…[旧回复已瘦身,原' + c.length + '字]…\n' +
    c.slice(-SHRINK_LEN.aiTail);
}
/** 剥离 __tool 内部标记（fe-H3/四轮）：豁免判定完成后调用——该字段是
 * buildMessagesForAPI 为本模块透传的内部元数据，不得进 API 请求体
 * （严格端点会拒未知字段）。仅对带标记的消息做浅拷贝，其余按引用原样返回。 */
function _stripToolTags(msgs) {
  let out = null;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m && m.__tool !== undefined) {
      if (!out) out = msgs.slice();
      const c = Object.assign({}, m);
      delete c.__tool;
      out[i] = c;
    }
  }
  return out || msgs;
}

function shrinkHistoryForApi(msgs) {
  if (!Array.isArray(msgs) || msgs.length <= SHRINK.keepTail) return _stripToolTags(msgs);
  const cut = msgs.length - SHRINK.keepTail;
  const out = msgs.slice();
  for (let i = 0; i < cut; i++) {
    const m = out[i];
    if (!m) continue;
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > SHRINK.toolMax && m.__tool !== 'read_file' && m.__tool !== 'read_more') {
      out[i] = Object.assign({}, m, { content: shrinkToolCopy(m.content) });
    } else if (m.role === 'assistant' && typeof m.content === 'string' && m.content.length > SHRINK.aiMax) {
      out[i] = Object.assign({}, m, { content: shrinkAiCopy(m.content) });
    }
  }
  return _stripToolTags(out);
}

/**
 * 系统消息归一化（v1.6 修复：Ollama + Qwen 系 chat template 的
 * 「Jinja Exception: System message must be at the beginning」HTTP 500）。
 *
 * 背景：首轮会话会把【工作日志】以 role='system' **追加到历史末尾**（100-send.js），
 * 而主请求在前面又塞了一条 system 系统提示词（60-agent-loop.js），
 * 于是发给本地模型的 messages 形如 [system, user, system]；Qwen 的 Jinja 模板要求
 * 所有 system 必须在数组最前、且通常只允许一条，直接 raise → 500。
 *
 * 规则（普适正确，不区分端点）：
 * - 收集所有 role==='system' 的消息，按原有相对顺序用 '\n\n' 拼成**一条**放到数组最前；
 * - 其余消息保持原相对顺序；
 * - 0/1 条 system：原样返回**入参数组引用**（零行为变化，不影响既有调用方的引用语义）；
 * - 空白/纯空白的 system 内容跳过，不产生空 system 消息。
 *
 * 幂等：对已归一化的数组再次调用结果等价（不会重复拼接）。
 *
 * @param {Array<Object>} msgs 待发送消息数组（函数不修改入参）
 * @return {Array<Object>} 归一化后的消息数组（>1 条 system 时为新数组，否则为入参本身）
 */
function normalizeSystemMessages(msgs) {
  if (!Array.isArray(msgs)) return msgs;
  const sysParts = [];
  const rest = [];
  let sysCount = 0;
  let firstSys = null;   // 保留首条 system 的非 content 附加字段（如 usage/id），合并后不丢元数据
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || m.role !== 'system') { rest.push(m); continue; }
    sysCount++;
    if (!firstSys) firstSys = m;
    // content 可能是字符串，也可能是多模态 part 数组（provider 兼容写法）：取文本部分拼接
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content.map(p => (p && typeof p.text === 'string') ? p.text : '').filter(Boolean).join('\n');
    }
    if (text && text.trim()) sysParts.push(text);   // 空白 system 直接丢弃（不产生空 system）
  }
  if (sysCount <= 1) return msgs;                   // 零行为变化：0/1 条 system 不重排不复制
  if (sysParts.length === 0) return rest;           // 只有空白 system：整条丢弃，不留空壳
  const merged = Object.assign({}, firstSys, { role: 'system', content: sysParts.join('\n\n') });
  return [merged, ...rest];
}

/**
 * 修复 UX-1（v1.4）：发送副本瘦身透明化——与 shrinkHistoryForApi 同口径计算哪些消息
 * 在发送副本里会被瘦身，在对应消息元素（data-midx）上打弱化标记，
 * hover 显示摘要开头。AI 实际收到的与 UI 展示的差异从此可见（「AI 忘了」困惑的对冲）。
 */
function applyShrinkMarkers(msgs) {
  const box = document.getElementById('chatContainer');
  if (!box) return;
  const clear = () => box.querySelectorAll('[data-shrunk]').forEach(el => {
    el.removeAttribute('data-shrunk');
    const b = el.querySelector('.shrink-badge');
    if (b) b.remove();
  });
  clear();
  if (!Array.isArray(msgs) || msgs.length <= SHRINK.keepTail) return;
  const cut = msgs.length - SHRINK.keepTail;
  for (let i = 0; i < cut; i++) {
    const m = msgs[i];
    if (!m) continue;
    let shrunkLen = 0, head = '';
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > SHRINK.toolMax && m.__tool !== 'read_file' && m.__tool !== 'read_more') {
      shrunkLen = shrinkToolCopy(m.content).length; head = m.content.slice(0, 60);
    } else if (m.role === 'assistant' && typeof m.content === 'string' && m.content.length > SHRINK.aiMax) {
      shrunkLen = shrinkAiCopy(m.content).length; head = m.content.slice(0, 60);
    }
    if (!shrunkLen) continue;
    const el = box.querySelector('[data-midx="' + i + '"]');
    if (!el || el.hasAttribute('data-shrunk')) continue;
    el.setAttribute('data-shrunk', '1');
    const badge = document.createElement('div');
    badge.className = 'shrink-badge';
    badge.textContent = '已瘦身 · 原文 ' + m.content.length + ' 字 → 发送约 ' + shrunkLen + ' 字';
    badge.title = '发送给 AI 的副本已瘦身；摘要开头：' + head + '…';
    el.appendChild(badge);
  }
}
