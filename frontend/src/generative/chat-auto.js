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

/** 本地即时结构化(零模型延迟)——「点了马上有反应」的核心。
 * 用启发式把回答 Markdown 立刻转成视图:标题→SectionHeader、数字要点→StatTile、
 * 列表→Checklist、加粗/冒号要点→KeyValue、其余→TextBlock。全部满足 schema 约束
 * (blockId 正则/长度上限),不依赖网络;模型转换稍后到达时无缝升级覆盖。 */
function chatAutoHeuristicSpec(sessionId, answer) {
  const MAX_BLOCKS = 14;
  const clean = String(answer || '').replace(/\r/g, '');
  const lines = clean.split('\n');
  const blocks = [];
  const usedIds = Object.create(null);
  let idSeq = 0;
  const nextId = prefix => {
    let id;
    do { id = prefix + '-' + (++idSeq); } while (usedIds[id]);
    usedIds[id] = 1;
    return id;
  };
  const push = (component, props) => {
    if (blocks.length >= MAX_BLOCKS) return;
    blocks.push({ blockId: nextId(component.toLowerCase()), component, props, actions: [] });
  };

  // ① 标题 → SectionHeader(首个 H1/H2 作为视图标题,其余分节)
  let title = '';
  const bulletLines = [];
  const kvPairs = [];
  const statCandidates = [];
  const paragraphs = [];
  let tableRows = null;
  let tableHead = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) {
      const text = h[2].replace(/[*_`]/g, '').trim();
      if (!title) { title = text.slice(0, 120); continue; }
      if (text.length <= 60) push('SectionHeader', { text: text.slice(0, 120) });
      continue;
    }
    // 表格
    if (/^\|.*\|$/.test(line)) {
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;   // 分隔行
      if (!tableHead) { tableHead = cells; continue; }
      if (!tableRows) tableRows = cells;
      continue;
    }
    // 列表项(先判「标签:数值」→ KPI 候选,再回落普通清单项)
    const b = /^[-*+•]\s+(.+)$/.exec(line) || /^\d+[.)]\s+(.+)$/.exec(line);
    if (b) {
      const text = b[1].replace(/[*_`]/g, '').trim();
      if (!text) continue;
      const kvInBullet = /^([^:：]{1,20})[:：]\s*(.+)$/.exec(text);
      if (kvInBullet) {
        const label = kvInBullet[1].trim();
        const value = kvInBullet[2].trim();
        if (/[\d０-９]/.test(value) && value.length <= 24) {
          statCandidates.push({ label: label.slice(0, 40), value: value.slice(0, 40) });
          continue;
        }
        kvPairs.push({ label: label.slice(0, 40), value: value.slice(0, 120) });
        continue;
      }
      bulletLines.push(text.slice(0, 200));
      continue;
    }
    // 键值 / 数字要点
    const kv = /^[*\s]*([^:：*]{1,24})[*\s]*[:：]\s*(.+)$/.exec(line);
    if (kv) {
      const label = kv[1].replace(/[*_`]/g, '').trim();
      const value = kv[2].replace(/[*_`]/g, '').trim();
      if (label && value) {
        kvPairs.push({ label: label.slice(0, 40), value: value.slice(0, 120) });
        if (/[\d０-９]/.test(value) && value.length <= 24) {
          statCandidates.push({ label: label.slice(0, 40), value: value.slice(0, 40) });
        }
        continue;
      }
    }
    if (line.length > 2 && paragraphs.length < 3) paragraphs.push(line.replace(/[*_`]/g, '').slice(0, 600));
  }

  // ② 数字要点 → StatTile(最多 6)
  if (statCandidates.length >= 2) {
    push('StatTile', { items: statCandidates.slice(0, 6) });
  }
  // ③ 列表 → Checklist(打勾可用;完成态未知,默认未勾)
  if (bulletLines.length >= 2) {
    push('Checklist', {
      title: '要点清单',
      items: bulletLines.slice(0, 20).map(text => ({ text, checked: false })),
    });
  } else if (bulletLines.length === 1) {
    paragraphs.push('• ' + bulletLines[0]);
  }
  // ④ 表格 → Table
  if (tableHead && tableRows) {
    push('Table', {
      columns: tableHead.slice(0, 8).map(c => c.replace(/[*_`]/g, '').slice(0, 60)),
      rows: [tableRows.slice(0, 8).map(c => c.replace(/[*_`]/g, '').slice(0, 200))],
    });
  }
  // ⑤ 剩余键值 → KeyValue
  if (kvPairs.length) push('KeyValue', { items: kvPairs.slice(0, 12) });
  // ⑥ 正文兜底(保证不空)
  if (!blocks.length) {
    push('TextBlock', { text: clean.slice(0, 4000) });
  }

  return {
    schemaVersion: 1,
    specId: 'chat-local-' + Date.now().toString(36),
    sessionId: String(sessionId || '').slice(0, 128),
    layout: blocks.some(b => b.component === 'StatTile') ? 'card-grid'
      : blocks.some(b => b.component === 'Table') ? 'table-focus' : 'single-column',
    title: title || undefined,
    blocks,
  };
}

/** 切回会话时的兜底入口(后台完成时会话不在视窗 → 此刻补渲染)。
 * sessions/controller.js 的 switchSession 在视图渲染完成后调用。 */
function chatAutoRenderPendingFor(sessionId) {
  if (!CHAT_AUTO.pending.has(String(sessionId))) return;
  CHAT_AUTO.pending.delete(String(sessionId));
  void chatGenerativeAutoRender(sessionId);
}

/** 内联视图宿主(标题栏+状态+折叠钮+内容体)——chat-auto 与 renderChatHistory 共用。
 * 返回 {body, setStatus}:status 走「生成中→完成/失败」的实时状态条(R1-UX 反馈:
 * 转换 10-40 秒期间无进度感;失败回落原文不说原因)。 */
function buildChatUiHost(contentEl) {
  const host = document.createElement('div');
  host.className = 'ui-chat-host';
  const bar = document.createElement('div');
  bar.className = 'ui-chat-host-bar';
  const label = document.createElement('span');
  label.className = 'ui-chat-host-label';
  label.textContent = '✦ 生成视图(由本回答自动生成)';
  const status = document.createElement('span');
  status.className = 'ui-chat-host-status';
  status.textContent = '⏳ 正在生成视图…';
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'ui-chat-host-toggle';
  toggleBtn.textContent = '收起';
  toggleBtn.hidden = true;   // 生成完成/失败后才显示折叠与重试
  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'ui-chat-host-toggle';
  retryBtn.textContent = '重试';
  retryBtn.title = '用同一个回答重新生成视图';
  retryBtn.hidden = true;
  retryBtn.addEventListener('click', () => {
    // 重试:交给宿主注册的 refresh 回调(chat-auto 生成态/持久化态均可用)
    const cb = host.__uiRetry;
    if (typeof cb === 'function') { cb(); return; }
    // 持久化视图无生成态 → 交由宿主级强制重生成
    const container = contentEl.closest('.message');
    const sid = (typeof AppState !== 'undefined') ? AppState.currentSessionId : currentSessionId;
    if (typeof chatGenerativeAutoRender === 'function' && container) {
      host.remove();
      if (contentEl.dataset) delete contentEl.dataset.uiAuto;
      CHAT_AUTO.mounts.delete(contentEl);
      if (sid) {
        // 先收集再删(Set 遍历中删除会跳项)
        const stale = [];
        CHAT_AUTO.done.forEach(s => { if (String(s).startsWith(String(sid) + '::')) stale.push(s); });
        stale.forEach(s => CHAT_AUTO.done.delete(s));
      }
      void chatGenerativeAutoRender(sid, { force: true });
    }
  });
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
  bar.appendChild(status);
  const btns = document.createElement('span');
  btns.style.display = 'flex';
  btns.style.gap = '6px';
  btns.appendChild(retryBtn);
  btns.appendChild(offBtn);
  btns.appendChild(toggleBtn);
  bar.appendChild(btns);
  host.appendChild(bar);
  host.appendChild(body);
  contentEl.appendChild(host);
  return {
    body,
    host,
    setStatus(text) { status.textContent = text; },
    showControls() { toggleBtn.hidden = false; retryBtn.hidden = true; },
    showRetry() { toggleBtn.hidden = false; retryBtn.hidden = false; body.hidden = false; },
  };
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
    const hostParts = buildChatUiHost(contentEl);
    const body = hostParts.body;
    hostParts.setStatus('');          // 持久化视图=已完成态,无需进度提示
    hostParts.showControls();
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

    const hostParts = buildChatUiHost(content);
    const body = hostParts.body;
    // 视图一出现就把用户带到位(主理人反馈:点了没反应,过一会才有变化)
    try { content.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {}
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

    // ① 立即:本地启发式即刻出视图(零网络延迟——「点了马上有反应」)
    // ② 后台:模型转换完成后无缝升级(失败则保留本地视图,不再回落原文)
    const localSpec = chatAutoHeuristicSpec(sessionId, trimmed);
    let localProjection = null;
    try {
      const richLocal = localSpec.blocks.length > 1
        || (localSpec.blocks[0] && localSpec.blocks[0].component !== 'TextBlock');
      if (richLocal || localSpec.blocks.length) {
        localProjection = UiProjection.mount(body, localSpec, { focusTitle: false });
        hostParts.setStatus(richLocal ? '✓ 已生成(优化中…)' : '');
        hostParts.showControls();
        // 立即持久化本地版:即便模型调用失败/用户立刻切走,视图也已存在
        if (sessionRef && sessionRef.messages) {
          const msgs0 = sessionRef.messages;
          for (let i = msgs0.length - 1; i >= 0; i--) {
            if (msgs0[i] && msgs0[i].role === 'assistant') {
              try { msgs0[i].uiSpec = JSON.parse(JSON.stringify(localSpec)); } catch (e) {}
              break;
            }
          }
          if (typeof saveSessions === 'function') { try { saveSessions(); } catch (e) {} }
        }
      }
    } catch (e) {
      try { console.warn('[gen-ui] 本地即时视图失败:', e && e.message); } catch (e2) {}
    }

    void (async () => {
      try {
        // 模型转换在独立暂存容器内进行(Skeleton→逐块提交),成功才替换本地视图,
        // 避免模型慢/失败时冲掉已经可用的本地即时视图
        const staging = document.createElement('div');
        staging.style.display = 'none';
        body.appendChild(staging);
        const result = await generateUiSpec({
          kind: 'chat-answer(把助手回答重构为信息设计出色的可交互视图)',
          fallbackSpec: chatAutoSeedSpec(sessionId, trimmed),
          host: staging,
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
        const current = result && result.projection && result.projection.current;
        if (current) {
          const session = (typeof sessions !== 'undefined' && Array.isArray(sessions))
            ? sessions.find(item => item.id === sessionId) : null;
          const msgs = session && Array.isArray(session.messages) ? session.messages : null;
          if (msgs) {
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i] && msgs[i].role === 'assistant') {
                try { msgs[i].uiSpec = JSON.parse(JSON.stringify(current)); } catch (e) {}
                break;
              }
            }
            if (typeof saveSessions === 'function') { try { saveSessions(); } catch (e) {} }
          }
        }
        // 模型成品判定:非种子单块视为成功 → 替换本地视图(无缝升级)
        const richEnough = current && Array.isArray(current.blocks)
          && (current.blocks.length > 1 || (current.blocks[0] && current.blocks[0].component !== 'TextBlock'));
        if (richEnough) {
          try {
            body.replaceChildren();
            UiProjection.mount(body, current, { focusTitle: false });
          } catch (e) { /* 保留本地视图兜底 */ }
          hostParts.setStatus('✨ 已由 AI 编排');
          hostParts.showControls();
        } else if (localProjection) {
          // 模型未产出更优结构 → 保留已渲染的本地视图(不回落原文、不报错)
          hostParts.setStatus('✓ 已生成(本地结构)');
          hostParts.showControls();
        } else {
          hostParts.setStatus('⚠ 转换未成功,先显示原文');
          hostParts.showRetry();
        }
      } catch (error) {
        if (localProjection) {
          // 模型失败但本地视图已就绪 → 静默保留,不打扰用户
          hostParts.setStatus('✓ 已生成(本地结构)');
          hostParts.showControls();
        } else {
          hostParts.setStatus('⚠ 生成失败');
          hostParts.showRetry();
        }
        try { console.warn('[gen-ui] 模型视图生成失败(已保留本地视图):', error && error.message); } catch (e2) {}
      } finally {
        try { if (staging && staging.parentNode) staging.parentNode.removeChild(staging); } catch (e) {}
      }
    })();
  } catch (error) {
    try { console.warn('[gen-ui] 自动视图生成失败(不影响聊天):', error && error.message); } catch (e) {}
  }
}
