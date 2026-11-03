/* 聊天回答自动生成式 UI(2026-11-02 主理人裁定「回答本身自动变成可交互 UI,要真正能用」)。
 * 机制:run 落定 → 取本会话最后一条 assistant 回答 → 二次快速模型调用(strict schema,
 * 复用 generateUiSpec 的生成+修复回路)把回答内容转成 UiSpec → 内联挂载在回答下方,
 * 可折叠回原文。失败静默,绝不影响聊天主链路。安全面:组件只读(14 组件白名单),
 * 数据来自回答文本,不经模型工具面。 */
const CHAT_AUTO = {
  minChars: 120,          // 短回答(寒暄/单句)不值得转 UI;结构化短答(小表格/指标卡)
                          // 原来被 240 卡掉——「点了没反应」的隐藏成因之一,2026-11-03 下调
  maxChars: 12000,        // 超长回答截断喂给转换器
  minBlocksForLocal: 2,   // 本地即时视图至少要有这么多「真结构」块才值得先挂
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

/** 质量闸(2026-11-03 主理人反馈「切换会话视图还在 / 点框无反应」的根因):
 * 启发式只在**真的能编排出结构**时才配得上占用一条内联视图。判定三档:
 *  - rich(≥2 有的块 或 单块但非纯 TextBlock) → 立即挂本地视图,模型稍后升级;
 *  - seed(仅 1 块 TextBlock) → 不挂「空壳视图」,只静默等模型(模型成功才挂);
 *  - none(无块) → 同样等模型。
 * 另设「过肥闸」:超长且零结构的正文(整段会议记录/代码)不塞进单个 TextBlock
 * (视图会变成一堵字墙,Markdown 原文更可读),留给模型去编排。
 * 返回 {mode:'rich'|'seed'|'none', why}。 */
function chatAutoQualityGate(spec, rawText) {
  const blocks = (spec && Array.isArray(spec.blocks)) ? spec.blocks : [];
  if (!blocks.length) return { mode: 'none', why: 'no_blocks' };
  const rich = blocks.length > 1
    || (blocks[0] && blocks[0].component !== 'TextBlock');
  if (rich) return { mode: 'rich', why: 'structured' };
  const text = typeof rawText === 'string' ? rawText : '';
  if (text.length > 1200) return { mode: 'seed', why: 'fat_prose' };
  return { mode: 'seed', why: 'flat_prose' };
}

/** 低危本地动作的默认实现(复制/导出当前回答)——视图工具条与块级 action 共用。 */
function chatAutoActionHandlers(sessionId, answer) {
  return {
    copy: ctx => {
      const text = (ctx && ctx.text) ? String(ctx.text) : String(answer || '');
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(
          () => { if (typeof toast === 'function') toast('已复制到剪贴板', 'ok'); },
          () => { if (typeof toast === 'function') toast('复制失败，请手动选择文本', 'warn'); });
      }
      if (typeof toast === 'function') toast('当前环境不支持自动复制，请手动选择文本', 'warn');
      return null;
    },
    export: () => {
      if (typeof exportSessionMd === 'function') return exportSessionMd(sessionId);
      return null;
    },
  };
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
 * 用启发式把回答 Markdown 立刻转成视图,**保持原文的分节与顺序**:
 *   H1/H2/H3 → 视图标题(首个)+ SectionHeader(其余)
 *   本节内「指标:数值」→ StatTile(KPI 卡);其余列表项 → Checklist(可打卡)
 *   表格 → Table;散落键值 → KeyValue;正文 → 合并 TextBlock(兜底不空)
 * 「什么算 KPI」有语义闸(2026-11-03):值必须是短量词(4 次/45-60 分钟/2600 kcal),
 * 带逗号的叙述(「周一:胸部训练,平板卧推 4 组」)留在 Checklist 里可打卡——
 * 之前一律当 KPI 卡,才出现「一排死框框,点了没反应」的观感。
 * 全部满足 schema 约束(blockId 正则/块数/长度),不依赖网络;模型成品更优时无缝替换。 */
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
    if (blocks.length >= MAX_BLOCKS) return false;
    blocks.push({ blockId: nextId(component.toLowerCase()), component, props, actions: [] });
    return true;
  };
  const strip = text => String(text || '').replace(/[*_`]/g, '').trim();

  // 指标口径:短、以数字/量词收束、不含从句标点 → 才配当 KPI 卡
  const metricLike = (label, value) => {
    if (!value || value.length > 20) return false;
    if (/[，,、；;。]/.test(value)) return false;
    if (/^[0-9０-９]/.test(value)) return true;
    return /(次|组|分钟|小时|天|周|日|月|年|kg|公斤|克|千卡|kcal|大卡|升|毫升|ml|公里|km|米|步|%|率|量|体重|心率|分|秒|g|mg|l|cm|mm|min|元|块|人|个|件|页|张|杯|碗)$/i
      .test(value);
  };

  let title = '';
  let section = null;   // {heading, bullets:[{text,kpi}], paras:[], kvs:[]}

  const emit = () => {
    if (!section) return;
    const sec = section;
    section = null;
    if (!sec.heading && !sec.bullets.length && !sec.paras.length && !sec.kvs.length) return;
    if (sec.heading) push('SectionHeader', { text: sec.heading.slice(0, 120) });
    const stats = sec.bullets.filter(b => b.kpi).map(b => b.kpi);
    const checks = sec.bullets.filter(b => !b.kpi).map(b => b.text);
    if (stats.length >= 2) push('StatTile', { items: stats.slice(0, 6) });
    else if (stats.length === 1) checks.unshift(stats[0].label + ':' + stats[0].value);
    if (checks.length >= 2) {
      // 清单可打卡(纯客户端),计数徽标常显 → 点一下就有反馈
      push('Checklist', { items: checks.slice(0, 20).map(text => ({ text, checked: false })) });
    } else if (checks.length === 1) {
      sec.paras.unshift('• ' + checks[0]);
    }
    if (sec.kvs.length) push('KeyValue', { items: sec.kvs.slice(0, 12) });
    if (sec.paras.length) push('TextBlock', { text: sec.paras.join('\n').slice(0, 1600) });
  };

  let tableHead = null;
  let tableRows = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const h = /^(#{1,4})\s+(.+)$/.exec(line);
    if (h) {
      const text = strip(h[2]);
      emit();
      if (!title && text) { title = text.slice(0, 120); continue; }
      if (text.length <= 60) section = { heading: text, bullets: [], paras: [], kvs: [] };
      continue;
    }
    // 表格:整块收齐后作为独立 Table 块
    if (/^\|.*\|$/.test(line)) {
      const cells = line.split('|').slice(1, -1).map(c => strip(c));
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;   // 分隔行
      if (!tableHead) { tableHead = cells; continue; }
      tableRows.push(cells);
      continue;
    }
    if (tableHead && tableRows.length) {
      // 表格结束了:先把表格排出,再继续正文
      emit();
      push('Table', {
        columns: tableHead.slice(0, 8).map(c => c.slice(0, 60)),
        rows: tableRows.slice(0, 20).map(r => r.slice(0, 8).map(c => c.slice(0, 200))),
      });
      tableHead = null; tableRows = [];
    }
    if (!section) section = { heading: '', bullets: [], paras: [], kvs: [] };
    const b = /^[-*+•]\s+(.+)$/.exec(line) || /^\d+[.)]\s+(.+)$/.exec(line);
    if (b) {
      const text = strip(b[1]);
      if (!text) continue;
      const kvInBullet = /^([^:：]{1,20})[:：]\s*(.+)$/.exec(text);
      if (kvInBullet) {
        const label = strip(kvInBullet[1]).slice(0, 40);
        const value = strip(kvInBullet[2]).slice(0, 120);
        if (label && value) {
          if (metricLike(label, value)) section.bullets.push({ text, kpi: { label, value } });
          else section.bullets.push({ text: text.slice(0, 200) });
          continue;
        }
      }
      section.bullets.push({ text: text.slice(0, 200) });
      continue;
    }
    const kv = /^[*\s]*([^:：*]{1,24})[*\s]*[:：]\s*(.+)$/.exec(line);
    if (kv) {
      const label = strip(kv[1]).slice(0, 40);
      const value = strip(kv[2]).slice(0, 120);
      if (label && value) {
        if (metricLike(label, value)) section.bullets.push({ text: label + ':' + value, kpi: { label, value } });
        else section.kvs.push({ label, value });
        continue;
      }
    }
    if (line.length > 2 && section.paras.length < 3) section.paras.push(strip(line).slice(0, 600));
  }
  if (tableHead && tableRows.length) {
    emit();
    push('Table', {
      columns: tableHead.slice(0, 8).map(c => c.slice(0, 60)),
      rows: tableRows.slice(0, 20).map(r => r.slice(0, 8).map(c => c.slice(0, 200))),
    });
  }
  emit();

  // 兜底:保证不空(纯正文回答也至少有一块,由质量闸决定要不要真挂视图)
  if (!blocks.length) push('TextBlock', { text: clean.slice(0, 4000) });

  return {
    schemaVersion: 1,
    specId: 'chat-local-' + Date.now().toString(36),
    sessionId: String(sessionId || '').slice(0, 128),
    // 布局口径(2026-11-03):只有「多张 Card」才配 card-grid 并排;分节标题+清单+
    // KPI 这类整幅内容一律单列,否则标题与内容会被拆到不同列(真机截图实证)。
    layout: blocks.filter(b => b.component === 'Card').length >= 2 ? 'card-grid'
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
function buildChatUiHost(contentEl, opts) {
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
  btns.className = 'ui-chat-host-actions';
  // 视图工具条(2026-11-03):「点了框框没反应」——视图片本身是只读展示,
  // 这里给出**看得见、点得动、有反馈**的动作,不复用死气沉沉的块级 hover 态。
  const trimmedAnswer = (opts && typeof opts.answerText === 'string') ? opts.answerText : '';
  if (trimmedAnswer) {
    const handlers = (opts && opts.actionHandlers)
      || chatAutoActionHandlers(null, trimmedAnswer);
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'ui-chat-host-toggle ui-chat-host-act';
    copyBtn.textContent = '复制';
    copyBtn.title = '复制这条回答的原文';
    copyBtn.addEventListener('click', () => {
      try { handlers.copy({ text: trimmedAnswer }); } catch (e) {}
    });
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'ui-chat-host-toggle ui-chat-host-act';
    exportBtn.textContent = '导出';
    exportBtn.title = '把本条会话导出为 Markdown';
    exportBtn.addEventListener('click', () => {
      try {
        const sid = (opts && opts.sessionId)
          || ((typeof AppState !== 'undefined') ? AppState.currentSessionId : currentSessionId);
        if (typeof exportSessionMd === 'function' && sid) exportSessionMd(sid);
        else if (typeof toast === 'function') toast('当前会话暂无法导出', 'warn');
      } catch (e) {}
    });
    btns.appendChild(copyBtn);
    btns.appendChild(exportBtn);
  }
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

/** 写 uiSpec 后必须打脏标记:会话保存有「未变更短路」,只改消息内部字段不算变更。
 * 计数器进 store.js 的签名 → 这一次 saveSessions 才会真的落盘。 */
function chatAutoMarkSpecDirty(session) {
  if (!session) return;
  session._uiSpecRev = (Number(session._uiSpecRev) || 0) + 1;
}

/** 打卡落盘委托:把视图内的勾选状态写回 message.uiSpec 并随会话保存。
 * third 参数可以是**会话对象**(生成态,此刻还没有稳定的 message 引用)或
 * message 本身(历史重建态)——每次点击时重新解析,避免闭包里拿到过期 spec。 */
function wireChatUiChecklistPersist(body, sessionId, target) {
  if (!body || !target) return;
  const resolveMessage = () => {
    if (Array.isArray(target.messages)) {          // 会话 → 最后一条带 uiSpec 的 assistant
      for (let i = target.messages.length - 1; i >= 0; i--) {
        const m = target.messages[i];
        if (m && m.role === 'assistant' && m.uiSpec) return m;
      }
      return null;
    }
    return target.uiSpec ? target : null;
  };
  body.addEventListener('click', event => {
    const row = event.target && event.target.closest
      ? event.target.closest('.ui-checklist-item') : null;
    if (!row || !row.dataset.uiCheckIdx) return;
    const message = resolveMessage();
    if (!message || !message.uiSpec) return;
    const blockId = row.dataset.uiCheckBlock;
    const idx = Number(row.dataset.uiCheckIdx);
    const block = (message.uiSpec.blocks || []).find(b => b.blockId === blockId);
    const items = block && block.props && Array.isArray(block.props.items) ? block.props.items : null;
    if (!items || !items[idx]) return;
    // DOM 已由渲染器翻转,这里把落盘态对齐到 DOM 真值(避免双击错位)
    items[idx].checked = row.getAttribute('aria-checked') === 'true';
    // 记脏:否则「未变更短路」会让这次打卡根本不落盘
    const owner = (typeof sessions !== 'undefined' && Array.isArray(sessions))
      ? sessions.find(x => x && Array.isArray(x.messages) && x.messages.indexOf(message) >= 0) : null;
    chatAutoMarkSpecDirty(owner);
    if (typeof saveSessions === 'function') { try { saveSessions(); } catch (e) {} }
  });
}

/** 「✦ 生成视图」轻提示:回答还没有像样的视图时给的一个可点入口。
 * 不再静默什么都不给(用户会以为功能坏了),也不铺一个空壳大框。 */
function chatAutoShowMiniHint(contentEl) {
  if (!contentEl || contentEl.querySelector('.ui-chat-host-mini')) return null;
  const mini = document.createElement('button');
  mini.type = 'button';
  mini.className = 'ui-chat-host-mini';
  mini.textContent = '✦ 生成视图';
  mini.title = '把这条回答整理成可交互视图';
  mini.addEventListener('click', () => {
    mini.remove();
    const sid = (typeof AppState !== 'undefined') ? AppState.currentSessionId : currentSessionId;
    const msg = contentEl.closest('.message');
    if (msg && msg.dataset && msg.dataset.midx !== undefined) {
      const s = (typeof sessions !== 'undefined') ? sessions.find(x => x.id === sid) : null;
      const mm = s && s.messages && s.messages[Number(msg.dataset.midx)];
      if (mm) {
        try { delete mm.uiSpec; } catch (e) {}
        chatAutoMarkSpecDirty(s);
        if (typeof saveSessions === 'function') { try { saveSessions(); } catch (e) {} }
      }
    }
    if (typeof chatGenerativeAutoRender === 'function' && sid) {
      const stale = [];
      CHAT_AUTO.done.forEach(sig => { if (String(sig).startsWith(String(sid) + '::')) stale.push(sig); });
      stale.forEach(sig => CHAT_AUTO.done.delete(sig));
      CHAT_AUTO.mounts.delete(contentEl);
      void chatGenerativeAutoRender(sid, { force: true });
    }
  });
  contentEl.appendChild(mini);
  return mini;
}

/** 会话渲染挂载:消息带 uiSpec 时重建内联视图(renderChatHistory 调用)。 */
function mountChatUiSpecFromMessage(contentEl, message) {
  try {
    if (!contentEl || !message || !message.uiSpec || typeof UiProjection === 'undefined') return;
    if (contentEl.querySelector('.ui-chat-host')) return;
    // 与生成路径同一把质量闸:空壳(种子)规格不重建视图——重启/切会话后
    // 只呈现原始回答,不再把「一个 TextBlock」包装成生成视图。但**留一个入口**:
    // 有 uiSpec 却没到 rich 档,给一条可点重转的轻提示,而不是静默什么都不给
    // (2026-11-03:否则用户切回来只看到原文,以为功能坏了)。
    if (typeof chatAutoQualityGate === 'function') {
      const gate = chatAutoQualityGate(message.uiSpec, message.content);
      if (gate.mode !== 'rich') { chatAutoShowMiniHint(contentEl); return; }
    }
    const answerText = typeof message.content === 'string' ? message.content : '';
    const hostParts = buildChatUiHost(contentEl, {
      sessionId: message.sessionId || null,
      answerText,
      actionHandlers: chatAutoActionHandlers(message.sessionId || null, answerText),
    });
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
    // 清掉任何孤儿暂存容器(上一次转换被打断会留下 display:none 的空壳)
    content.querySelectorAll('.ui-chat-staging').forEach(n => { try { n.remove(); } catch (e) {} });
    const trimmed = answer.slice(0, CHAT_AUTO.maxChars);
    CHAT_AUTO.done.add(sig);
    content.dataset.uiAuto = '1';
    CHAT_AUTO.mounts.add(content);
    if (force) {
      const old = content.querySelector('.ui-chat-host');
      if (old) old.remove();
    }

    const hostParts = buildChatUiHost(content, {
      sessionId, answerText: trimmed,
      actionHandlers: chatAutoActionHandlers(sessionId, trimmed),
    });
    const body = hostParts.body;
    // 视图一出现就把用户带到位(主理人反馈:点了没反应,过一会才有变化)
    try { content.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {}
    // Checklist 打卡落盘:视图勾选 → message.uiSpec → 会话保存(R4 全量数组)
    const sessionRef = (typeof sessions !== 'undefined' && Array.isArray(sessions))
      ? sessions.find(item => item.id === sessionId) : null;
    if (sessionRef) wireChatUiChecklistPersist(body, sessionId, sessionRef);
    // 低危动作接线(copy/export/refresh)——与计划卡同口径:全部只读本地动作,
    // 需用户真实点击(userGesture 门),模型不能自触发
    const actionHandlers = Object.assign(chatAutoActionHandlers(sessionId, answer), {
      refresh: () => {
        // 重转视图:清签名+移除旧宿主后强制重跑本入口(同答案重新生成)
        CHAT_AUTO.done.delete(sig);
        if (content.dataset) delete content.dataset.uiAuto;
        CHAT_AUTO.mounts.delete(content);
        const oldHost = content.querySelector('.ui-chat-host');
        if (oldHost) oldHost.remove();
        return chatGenerativeAutoRender(sessionId, { force: true });
      },
    });

    // 质量闸(2026-11-03):过薄的本地结构不挂「空壳视图」——只静默等模型;
    // 模型产出足够结构才挂。这一步同时消灭「切换会话视图残留却没内容」的观感。
    const gate = chatAutoQualityGate(
      chatAutoHeuristicSpec(sessionId, trimmed), trimmed);

    // ① 立即:本地启发式即刻出视图(零网络延迟——「点了马上有反应」)
    // ② 后台:模型转换完成后无缝升级(失败则保留本地视图,不再回落原文)
    const localSpec = chatAutoHeuristicSpec(sessionId, trimmed);
    let localProjection = null;
    try {
      if (gate.mode === 'rich') {
        localProjection = UiProjection.mount(body, localSpec, { focusTitle: false });
        hostParts.setStatus('✓ 已生成(优化中…)');
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
          chatAutoMarkSpecDirty(sessionRef);
          if (typeof saveSessions === 'function') { try { saveSessions(); } catch (e) {} }
        }
      } else {
        // 空壳/无结构:内容区先收起,只留一条轻状态(用户看得见「在处理」),
        // 等模型真排出结构再展开——避免出现「一个空白大框」
        body.hidden = true;
        hostParts.setStatus('⏳ 正在整理为视图…');
      }
    } catch (e) {
      try { console.warn('[gen-ui] 本地即时视图失败:', e && e.message); } catch (e2) {}
    }

    void (async () => {
      try {
        // 模型转换在独立暂存容器内进行(Skeleton→逐块提交),成功才替换本地视图,
        // 避免模型慢/失败时冲掉已经可用的本地即时视图
        // 暂存容器**不挂进文档**:投影只做 createElement/textContent,离屏即可
        // 正常渲染;这样模型慢/被打断时绝不会有残留节点混进视图(2026-11-03 实证:
        // 挂进 body 后被打断会留一个 display:none 的空壳,污染 .ui-block 计数)。
        const staging = document.createElement('div');
        staging.className = 'ui-chat-staging';
        staging.style.display = 'none';
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
        // 模型成品判定:非种子单块视为成功 → 替换本地视图(无缝升级)。
        // 注:这条判定必须**先**算,持久化只在成品真的更优时才覆写——
        // 否则模型退化输出(1 块 TextBlock)会盖掉已经很好的本地 5 块视图,
        // 重启/切回时质量闸拒绝重建 = 「切回来视图没了」(2026-11-03 实证)。
        const current = result && result.projection && result.projection.current;
        const richEnough = current && Array.isArray(current.blocks)
          && (current.blocks.length > 1 || (current.blocks[0] && current.blocks[0].component !== 'TextBlock'));
        if (richEnough) {
          // 持久化：只在成品确实更强时写回会话消息对象（随 save_sessions 落盘）
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
            chatAutoMarkSpecDirty(session);
            if (typeof saveSessions === 'function') { try { saveSessions(); } catch (e) {} }
          }
          try {
            body.hidden = false;
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
          // 模型也没排出结构 → 不留下空壳视图:摘掉整个宿主,原文照旧
          hostParts.host.remove();
          if (content.dataset) delete content.dataset.uiAuto;
          CHAT_AUTO.mounts.delete(content);
        }
      } catch (error) {
        if (localProjection) {
          // 模型失败但本地视图已就绪 → 静默保留,不打扰用户
          hostParts.setStatus('✓ 已生成(本地结构)');
          hostParts.showControls();
        } else if (gate.mode === 'rich') {
          hostParts.setStatus('⚠ 生成失败');
          hostParts.showRetry();
        } else {
          // 本地无结构 + 模型失败 → 不显示空壳视图,原文即最佳呈现
          hostParts.host.remove();
          if (content.dataset) delete content.dataset.uiAuto;
          CHAT_AUTO.mounts.delete(content);
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
