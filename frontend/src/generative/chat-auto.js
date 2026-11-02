/* 聊天回答自动生成式 UI(2026-11-02 主理人裁定「回答本身自动变成可交互 UI,要真正能用」)。
 * 机制:run 落定 → 取本会话最后一条 assistant 回答 → 二次快速模型调用(strict schema,
 * 复用 generateUiSpec 的生成+修复回路)把回答内容转成 UiSpec → 内联挂载在回答下方,
 * 可折叠回原文。失败静默,绝不影响聊天主链路。安全面:组件只读(14 组件白名单),
 * 数据来自回答文本,不经模型工具面。 */
const CHAT_AUTO = {
  minChars: 240,          // 短回答(寒暄/单句)不值得转 UI
  maxChars: 12000,        // 超长回答截断喂给转换器
  mounts: new WeakSet(),  // 同一消息元素只挂一次(重试/重渲染防护)
};

function chatAutoSessionText(sessionId) {
  const session = (typeof sessions !== 'undefined' && Array.isArray(sessions))
    ? sessions.find(item => item.id === sessionId) : null;
  if (!session || !Array.isArray(session.messages)) return null;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (!m || m.role !== 'assistant') continue;
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const text = c.map(part => (part && typeof part.text === 'string') ? part.text : '').join('\n');
      if (text.trim()) return text;
    }
    return null;
  }
  return null;
}

function chatAutoSeedSpec(sessionId, answer) {
  return {
    schemaVersion: 1,
    specId: 'chat-auto-' + Date.now().toString(36),
    sessionId: String(sessionId || '').slice(0, 128),
    layout: 'card-grid',
    blocks: [{ blockId: 'answer.source', component: 'TextBlock', props: { text: answer.slice(0, 4000) }, actions: [] }],
  };
}

/** 供 run-controller finally 调用的入口(fire-and-forget)。 */
async function chatGenerativeAutoRender(sessionId) {
  try {
    if (typeof UiGenerativeSettings === 'undefined' || !UiGenerativeSettings.enabled) return;
    if (typeof document === 'undefined' || typeof UiProjection === 'undefined'
        || typeof generateUiSpec !== 'function') return;
    const view = (typeof AppState !== 'undefined') ? AppState.currentSessionId : currentSessionId;
    if (view !== sessionId) return;   // 只为当前正在看的会话自动渲染(切走的跳过)
    const el = (function () {
      const all = document.querySelectorAll('#chatContainer .message.assistant');
      return all.length ? all[all.length - 1] : null;
    })();
    if (!el) return;
    const content = el.querySelector('.content');
    if (!content || content.dataset.uiAuto === '1' || CHAT_AUTO.mounts.has(content)) return;
    const answer = chatAutoSessionText(sessionId);
    if (!answer || answer.length < CHAT_AUTO.minChars) return;
    const trimmed = answer.slice(0, CHAT_AUTO.maxChars);
    content.dataset.uiAuto = '1';
    CHAT_AUTO.mounts.add(content);

    const host = document.createElement('div');
    host.className = 'ui-chat-host';
    const bar = document.createElement('div');
    bar.className = 'ui-chat-host-bar';
    const label = document.createElement('span');
    label.className = 'ui-chat-host-label';
    label.textContent = '✦ 生成视图(由本回答自动生成)';
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'ui-chat-host-toggle';
    toggleBtn.textContent = '收起';
    const body = document.createElement('div');
    body.className = 'ui-chat-host-body';
    toggleBtn.addEventListener('click', () => {
      const hidden = body.hidden;
      body.hidden = hidden;
      toggleBtn.textContent = hidden ? '收起' : '展开';
    });
    bar.appendChild(label);
    bar.appendChild(toggleBtn);
    host.appendChild(bar);
    host.appendChild(body);
    content.appendChild(host);

    const controller = generateUiSpec({
      kind: 'chat-answer(把助手回答重构为信息设计出色的可交互视图)',
      fallbackSpec: chatAutoSeedSpec(sessionId, trimmed),
      host: body,
      sessionId: String(sessionId || ''),
      runId: 'chat-auto',
      answerText: trimmed,
      // P0-4 修正：端点快照由本调用方注入（本模块时序在 provider.js 之后，
      // 能拿到带真实密钥的 uiEndpointSnapshot——controller 内联快照密钥恒空）
      endpoint: (typeof uiEndpointSnapshot === 'function') ? uiEndpointSnapshot() : undefined,
      isActive: () => document.contains(host),
    });
    void controller;
  } catch (error) {
    try { console.warn('[gen-ui] 自动视图生成失败(不影响聊天):', error && error.message); } catch (e) {}
  }
}
