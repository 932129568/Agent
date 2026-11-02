/* 聊天回答自动生成式 UI(2026-11-02 主理人裁定「回答本身自动变成可交互 UI,要真正能用」)。
 * 机制:run 落定 → 取本会话最后一条 assistant 回答 → 二次快速模型调用(strict schema,
 * 复用 generateUiSpec 的生成+修复回路)把回答内容转成 UiSpec → 内联挂载在回答下方,
 * 可折叠回原文。失败静默,绝不影响聊天主链路。安全面:组件只读(14 组件白名单),
 * 数据来自回答文本,不经模型工具面。 */
const CHAT_AUTO = {
  minChars: 240,          // 短回答(寒暄/单句)不值得转 UI
  maxChars: 12000,        // 超长回答截断喂给转换器
  mounts: new WeakSet(),  // 同一消息元素只挂一次(重试/重渲染防护)
  done: new Set(),        // sessionId::回答长度 签名——跨切换/重渲染去重
  pending: new Set(),     // 后台完成时会话不在视窗 → 切回时兜底渲染
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

/** 切回会话时的兜底入口(后台完成时会话不在视窗 → 此刻补渲染)。
 * sessions/controller.js 的 switchSession 在视图渲染完成后调用。 */
function chatAutoRenderPendingFor(sessionId) {
  if (!CHAT_AUTO.pending.has(String(sessionId))) return;
  CHAT_AUTO.pending.delete(String(sessionId));
  void chatGenerativeAutoRender(sessionId);
}

/** 内联视图宿主(标题栏+折叠钮+内容体)——chat-auto 与 renderChatHistory 共用。 */
function buildChatUiHost(contentEl) {
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
  const offBtn = document.createElement('button');
  offBtn.type = 'button';
  offBtn.className = 'ui-chat-host-toggle';
  offBtn.textContent = '不再自动生成';
  offBtn.title = '关闭后仅在计划卡片手动生成视图；可随时在设置里重新开启';
  offBtn.addEventListener('click', () => {
    if (typeof UiGenerativeSettings !== 'undefined') {
      UiGenerativeSettings.set('enabled', false);
    }
    host.remove();
    if (typeof toast === 'function') toast('已关闭自动生成视图；计划卡片的「AI生成」不受影响', 'info');
  });
  const body = document.createElement('div');
  body.className = 'ui-chat-host-body';
  toggleBtn.addEventListener('click', () => {
    body.hidden = !body.hidden;
    toggleBtn.textContent = body.hidden ? '展开' : '收起';
  });
  bar.appendChild(label);
  const btns = document.createElement('span');
  btns.style.display = 'flex';
  btns.style.gap = '6px';
  btns.appendChild(offBtn);
  btns.appendChild(toggleBtn);
  bar.appendChild(btns);
  host.appendChild(bar);
  host.appendChild(body);
  contentEl.appendChild(host);
  return body;
}

/** Checklist 打卡落盘委托:把视图内的勾选状态写回 message.uiSpec 并随会话保存。
 * 挂在宿主 body 上(事件委托,渲染器无需感知持久化)。 */
function wireChatUiChecklistPersist(body, sessionId, message) {
  if (!body || !message || !message.uiSpec) return;
  body.addEventListener('click', event => {
    const row = event.target && event.target.closest
      ? event.target.closest('.ui-checklist-item') : null;
    if (!row || !row.dataset.uiCheckIdx) return;
    const blockId = row.dataset.uiCheckBlock;
    const idx = Number(row.dataset.uiCheckIdx);
    const block = (message.uiSpec.blocks || []).find(b => b.blockId === blockId);
    const items = block && block.props && Array.isArray(block.props.items) ? block.props.items : null;
    if (!items || !items[idx]) return;
    items[idx].checked = !items[idx].checked;
    if (typeof saveSessions === 'function') { try { saveSessions(); } catch (e) {} }
  });
}

/** 会话渲染挂载:消息带 uiSpec 时重建内联视图(renderChatHistory 调用)。 */
function mountChatUiSpecFromMessage(contentEl, message) {
  try {
    if (!contentEl || !message || !message.uiSpec || typeof UiProjection === 'undefined') return;
    if (contentEl.querySelector('.ui-chat-host')) return;
    const body = buildChatUiHost(contentEl);
    wireChatUiChecklistPersist(body, null, message);
    const spec = message.uiSpec;
    UiProjection.mount(body, spec, {
      dataRefHost: (typeof createUiDataRefHost === 'function') ? createUiDataRefHost({
        runId: spec.runId, sessionId: spec.sessionId, generation: spec.generation,
      }) : undefined,
      focusTitle: false,
    });
  } catch (e) {
    try { console.warn('[gen-ui] 视图重建失败(不影响原文):', e && e.message); } catch (e2) {}
  }
}

/** 供 run-controller finally 调用的入口(fire-and-forget)。
 * opts.force=true:忽略去重/移除旧视图强制重生成(「刷新」动作走此路径)。 */
async function chatGenerativeAutoRender(sessionId, opts) {
  try {
    const force = !!(opts && opts.force);
    if (typeof UiGenerativeSettings === 'undefined' || !UiGenerativeSettings.enabled) return;
    if (typeof document === 'undefined' || typeof UiProjection === 'undefined'
        || typeof generateUiSpec !== 'function') return;
    const view = (typeof AppState !== 'undefined') ? AppState.currentSessionId : currentSessionId;
    const el = (function () {
      const all = document.querySelectorAll('#chatContainer .message.assistant');
      return all.length ? all[all.length - 1] : null;
    })();
    const answer = chatAutoSessionText(sessionId);
    if (!answer || answer.length < CHAT_AUTO.minChars) return;
    const sig = String(sessionId) + '::' + answer.length;
    if (CHAT_AUTO.done.has(sig) && !force) return;
    if (view !== sessionId || !el) {
      // 会话不在视窗(并行后台完成)→ 记入待渲染,switchSession 切回时补
      CHAT_AUTO.pending.add(String(sessionId));
      return;
    }
    const content = el.querySelector('.content');
    if (!content) return;
    if (!force && (content.dataset.uiAuto === '1' || CHAT_AUTO.mounts.has(content))) return;
    const trimmed = answer.slice(0, CHAT_AUTO.maxChars);
    CHAT_AUTO.done.add(sig);
    content.dataset.uiAuto = '1';
    CHAT_AUTO.mounts.add(content);
    if (force) {
      const old = content.querySelector('.ui-chat-host');
      if (old) old.remove();
    }

    const body = buildChatUiHost(content);
    // Checklist 打卡落盘:视图勾选 → message.uiSpec → 会话保存(R4 全量数组)
    const sessionRef = (typeof sessions !== 'undefined' && Array.isArray(sessions))
      ? sessions.find(item => item.id === sessionId) : null;
    if (sessionRef) wireChatUiChecklistPersist(body, sessionId, sessionRef);
    // 低危动作接线(copy/export/refresh)——与计划卡同口径:全部只读本地动作,
    // 需用户真实点击(userGesture 门),模型不能自触发
    const actionHandlers = {
      copy: ctx => {
        const text = (ctx && ctx.text) ? String(ctx.text) : answer;
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          return navigator.clipboard.writeText(text);
        }
        return text;
      },
      export: () => {
        if (typeof exportSessionMd === 'function') return exportSessionMd(sessionId);
        return null;
      },
      refresh: () => {
        // 重转视图:清签名+移除旧宿主后强制重跑本入口(同答案重新生成)
        CHAT_AUTO.done.delete(sig);
        if (content.dataset) delete content.dataset.uiAuto;
        CHAT_AUTO.mounts.delete(content);
        const oldHost = content.querySelector('.ui-chat-host');
        if (oldHost) oldHost.remove();
        return chatGenerativeAutoRender(sessionId, { force: true });
      },
    };

    void (async () => {
      try {
        const result = await generateUiSpec({
          kind: 'chat-answer(把助手回答重构为信息设计出色的可交互视图)',
          fallbackSpec: chatAutoSeedSpec(sessionId, trimmed),
          host: body,
          sessionId: String(sessionId || ''),
          runId: 'chat-auto',
          answerText: trimmed,
          // P0-4 修正：端点快照由本调用方注入（本模块时序在 provider.js 之后，
          // 能拿到带真实密钥的 uiEndpointSnapshot——controller 内联快照密钥恒空）
          endpoint: (typeof uiEndpointSnapshot === 'function') ? uiEndpointSnapshot() : undefined,
          actionHandlers,
          actionPermission: () => true,   // copy/export/refresh=低危只读本地动作(计划卡同口径)
          isActive: () => document.contains(body),
        });
        // 持久化：成品 spec 写回会话消息对象（随 save_sessions 落盘）——
        // 重启/切换后 renderChatHistory 依据 message.uiSpec 重建视图
        if (result && result.projection && result.projection.current) {
          const session = (typeof sessions !== 'undefined' && Array.isArray(sessions))
            ? sessions.find(item => item.id === sessionId) : null;
          const msgs = session && Array.isArray(session.messages) ? session.messages : null;
          if (msgs) {
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i] && msgs[i].role === 'assistant') {
                try { msgs[i].uiSpec = JSON.parse(JSON.stringify(result.projection.current)); } catch (e) {}
                break;
              }
            }
            if (typeof saveSessions === 'function') { try { saveSessions(); } catch (e) {} }
          }
        }
      } catch (error) {
        try { console.warn('[gen-ui] 自动视图生成失败(不影响聊天):', error && error.message); } catch (e2) {}
      }
    })();
  } catch (error) {
    try { console.warn('[gen-ui] 自动视图生成失败(不影响聊天):', error && error.message); } catch (e) {}
  }
}
