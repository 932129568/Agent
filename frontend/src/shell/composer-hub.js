/* ================= R32 · 加号菜单 / 内置目录 / 统一附件入口 =================
 * 交互层：一个「+」按钮展开菜单（添加文件 / 引用对话中的文件 / 模式 / 专家 /
 * 技能 / 连接器），鼠标靠近「专家」「技能」等条目即在右侧浮现搜索小窗。
 *
 * 「真的可以用」的闭环：选中目录项 → HUB_STATE.picks[当前会话] →
 * hubDirectiveFor() → run-controller.js 注入下一次请求的系统提示 →
 * 模型按该角色/工作流回答；输入框自动带入该角色的开场提问，chip 可随时清除。
 * 选择态按会话隔离，切换会话互不串台；不写 config.json、不新增 js_api。
 */
const HUB_STATE = {
  open: false, sub: '', query: '', picks: {},
  allOpen: false, allKind: 'experts', allQuery: '',
};

/** HTML 转义（目录数据虽来自本地市场，仍按不可信文本处理）。 */
const hubEsc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 当前会话 id（兼容 AppState 与 vm 沙箱）。 */
function hubCurrentSid() {
  return (typeof AppState !== 'undefined' && AppState && AppState.currentSessionId)
    ? AppState.currentSessionId
    : ((typeof currentSessionId !== 'undefined') ? currentSessionId : '');
}

/** 目录分区 -> 菜单子面板的数据池与文案。 */
function hubSubPools(kind) {
  if (kind === 'expert') return ['experts', 'teams'];
  if (kind === 'skill') return ['skills'];
  if (kind === 'connector') return ['connectors'];
  return [];
}

/** 打开/关闭加号菜单。force=true/false 可指定状态。 */
function hubToggleMenu(force) {
  const menu = document.getElementById('hubMenu');
  const btn = document.getElementById('composerPlusBtn');
  if (!menu) return;
  const next = (force === true || force === false) ? force : !HUB_STATE.open;
  HUB_STATE.open = next;
  menu.hidden = !next;
  if (btn && btn.setAttribute) btn.setAttribute('aria-expanded', next ? 'true' : 'false');
  if (!next) hubCloseSub();
}

/** 关闭菜单（含子面板）。 */
function hubCloseMenu() {
  hubToggleMenu(false);
}

/** 关闭悬浮子面板。 */
function hubCloseSub() {
  const panel = document.getElementById('hubSubpanel');
  if (panel) panel.hidden = true;
  HUB_STATE.sub = '';
  document.querySelectorAll('.hub-mi-sub').forEach(el => {
    if (el.classList) el.classList.remove('on');
  });
}

/** 展开某个子面板（hover / focus / click 均可触发）。 */
function hubOpenSub(kind) {
  const panel = document.getElementById('hubSubpanel');
  if (!panel) return;
  HUB_STATE.sub = kind;
  HUB_STATE.query = '';
  panel.hidden = false;
  const input = document.getElementById('hubSearch');
  const labels = { expert: '搜索专家 / 专家团', skill: '搜索技能',
                   connector: '搜索连接器', mode: '选择工具权限模式' };
  if (input) { input.value = ''; input.placeholder = labels[kind] || '搜索'; }
  document.querySelectorAll('.hub-mi-sub').forEach(el => {
    if (el.classList) el.classList.toggle('on', el.dataset && el.dataset.hubSub === kind);
  });
  hubRenderSub();
}

/** 子面板列表：热门优先；有查询词时全库检索（名字命中优先），限量渲染。 */
function hubRenderSub() {
  const box = document.getElementById('hubList');
  if (!box) return;
  const kind = HUB_STATE.sub;
  const q = String(HUB_STATE.query || '').trim();
  let items = [];
  if (kind === 'mode') {
    items = [
      { id: 'full', name: '完整', desc: '读 + 写 + 命令 + 截屏（默认）', emoji: '⚡', __kind: 'mode' },
      { id: 'readonly', name: '只读', desc: '只看文件/目录，不能修改', emoji: '👁️', __kind: 'mode' },
      { id: 'off', name: '纯聊天', desc: '不访问电脑，最省 token', emoji: '💬', __kind: 'mode' },
    ];
    if (q) items = items.filter(it => (it.name + it.desc).toLowerCase().indexOf(q.toLowerCase()) >= 0);
  } else {
    const pools = hubSubPools(kind);
    if (typeof hubCatalogSearch === 'function') {
      items = hubCatalogSearch(pools, q, q ? 30 : 9)
        .map(it => Object.assign({}, it, { __kind: it.kind === 'team' ? 'teams' : (it.kind === 'expert' ? 'experts' : (it.kind === 'skill' ? 'skills' : 'connectors')) }));
    }
  }
  const more = document.getElementById('hubMore');
  if (more) more.textContent = (kind === 'mode' ? '在设置中调整更多权限…'
    : kind === 'connector' ? '查看全部连接器…' : '召唤更多' + (kind === 'skill' ? '技能' : '专家') + '…');
  if (!items.length) {
    box.innerHTML = '<div class="hub-empty">没有匹配的条目，换个关键词试试</div>';
    return;
  }
  box.innerHTML = items.map(it =>
    '<button type="button" class="hub-item" data-hub-kind="' + hubEsc(it.__kind) +
    '" data-hub-id="' + hubEsc(it.id) + '" title="' + hubEsc(it.desc || '') + '">' +
      '<span class="hub-item-emoji" aria-hidden="true">' + hubEsc(it.emoji || '⚡') + '</span>' +
      '<span class="hub-item-body"><span class="hub-item-name">' + hubEsc(it.name) + '</span>' +
      '<span class="hub-item-desc">' + hubEsc(String(it.desc || '').slice(0, 46)) + '</span></span>' +
      (it.hot ? '<span class="hub-item-hot">热门</span>' : '') +
    '</button>').join('');
}

/** 搜索框输入。 */
function hubSetQuery(q) {
  HUB_STATE.query = q;
  hubRenderSub();
}

/** 选中一个目录项 —— 真正启用的入口。 */
function hubPick(kind, id) {
  const sid = hubCurrentSid();
  if (kind === 'mode') {
    const sel = document.getElementById('toolMode');
    if (sel) {
      sel.value = id;
      if (sel.dispatchEvent) {
        try { sel.dispatchEvent(new Event('change')); } catch (e) {}
      }
    }
    if (typeof toast === 'function') toast('工具权限已切换为「' + id + '」', 'ok');
    hubCloseMenu();
    return true;
  }
  if (kind === 'connectors') {
    // 连接器不注入提示词：打开既有 MCP 服务器设置作为真实落点
    if (typeof toggleSettings === 'function') toggleSettings();
    const block = document.querySelector('.set-block[data-group="工具与软件"]');
    if (block && block.scrollIntoView) { try { block.scrollIntoView({ block: 'center' }); } catch (e) {} }
    if (typeof toast === 'function') toast('内置目录含 ' + id + '；请在「MCP 服务器」中添加对应服务', 'ok');
    hubCloseMenu();
    return true;
  }
  const item = (typeof hubCatalogById === 'function') ? hubCatalogById(kind, id) : null;
  if (!item) return false;
  HUB_STATE.picks[sid] = { kind: kind, id: id, item: item };
  hubRenderChip();
  // 输入框为空时带入该角色的开场提问，用户直接回车即可真正用起来
  const input = document.getElementById('userInput');
  if (input && !String(input.value || '').trim() && item.init) {
    input.value = item.init;
    if (input.dispatchEvent) {
      try { input.dispatchEvent(new Event('input')); } catch (e) {}
    }
  }
  if (typeof toast === 'function') {
    toast('已启用「' + item.name + '」，下一次发送将按该角色工作', 'ok');
  }
  hubCloseMenu();
  return true;
}

/** 清除当前会话的内置目录选择。 */
function hubClearPick() {
  const sid = hubCurrentSid();
  delete HUB_STATE.picks[sid];
  hubRenderChip();
  if (typeof toast === 'function') toast('已退出内置角色/技能', 'ok');
}

/** 渲染启用状态 chip（切换会话时由 switchSession 调用刷新）。 */
function hubRenderChip() {
  const chip = document.getElementById('hubChip');
  if (!chip) return;
  const pick = HUB_STATE.picks[hubCurrentSid()];
  if (!pick) { chip.hidden = true; chip.innerHTML = ''; return; }
  const it = pick.item;
  chip.hidden = false;
  chip.innerHTML =
    '<span class="hub-chip-emoji" aria-hidden="true">' + hubEsc(it.emoji || '⚡') + '</span>' +
    '<span class="hub-chip-name">' + hubEsc(it.name) + '</span>' +
    '<span class="hub-chip-tag">' + (it.kind === 'team' ? '专家团' : it.kind === 'expert' ? '专家' : '技能') + ' · 已启用</span>' +
    '<button type="button" class="hub-chip-fill" data-hub-act="fill" title="填入该角色的开场提问">试一下</button>' +
    '<button type="button" class="hub-chip-x" data-hub-act="clear" aria-label="退出该角色">✕</button>';
}

/** 供 run-controller.js 注入系统提示：返回当前会话启用项的真实指令。 */
function hubDirectiveFor(sid) {
  const key = (sid !== undefined && sid !== null && sid !== '') ? sid : hubCurrentSid();
  const pick = HUB_STATE.picks[key];
  if (!pick) return '';
  return (typeof hubCatalogPrompt === 'function') ? hubCatalogPrompt(pick.item) : '';
}

/** 「召唤更多」：全量目录弹窗（448 专家 / 54 专家团 / 292 技能 / 17 连接器）。 */
function hubOpenAll(kind) {
  const modal = document.getElementById('hubAll');
  if (!modal) return;
  HUB_STATE.allOpen = true;
  HUB_STATE.allKind = (kind === 'skill' ? 'skills' : kind === 'connector' ? 'connectors'
    : kind === 'team' ? 'teams' : 'experts');
  HUB_STATE.allQuery = '';
  modal.hidden = false;
  const input = document.getElementById('hubAllSearch');
  if (input) input.value = '';
  hubCloseMenu();
  hubRenderAll();
}

/** 全量目录渲染：分页式限量（避免一次铺 448 条 DOM）。 */
function hubRenderAll() {
  const box = document.getElementById('hubAllList');
  const foot = document.getElementById('hubAllFoot');
  const title = document.getElementById('hubAllTitle');
  if (!box) return;
  const tabs = [
    ['experts', '专家'], ['teams', '专家团'], ['skills', '技能'], ['connectors', '连接器'],
  ];
  const tabsEl = document.getElementById('hubAllTabs');
  if (tabsEl) {
    const cat = (typeof HUB_CATALOG !== 'undefined') ? HUB_CATALOG : {};
    tabsEl.innerHTML = tabs.map(t =>
      '<button type="button" class="hub-all-tab' + (HUB_STATE.allKind === t[0] ? ' on' : '') +
      '" data-hub-tab="' + t[0] + '">' + t[1] + ' <small>' +
      ((cat[t[0]] || []).length) + '</small></button>').join('');
  }
  if (title) title.textContent = 'WorkBuddy 市场 · 全部目录';
  const q = String(HUB_STATE.allQuery || '').trim();
  const items = (typeof hubCatalogSearch === 'function')
    ? hubCatalogSearch(HUB_STATE.allKind, q, q ? 60 : 60) : [];
  const total = (typeof hubCatalogSearch === 'function')
    ? hubCatalogSearch(HUB_STATE.allKind, q, 0).length : 0;
  if (foot) foot.textContent = '共 ' + total + ' 项' +
    (total > items.length ? '，当前显示前 ' + items.length + ' 项，输入关键词可缩小范围' : '');
  if (!items.length) {
    box.innerHTML = '<div class="hub-empty">没有匹配的条目</div>';
    return;
  }
  box.innerHTML = items.map(it =>
    '<button type="button" class="hub-all-item" data-hub-kind="' + hubEsc(HUB_STATE.allKind) +
    '" data-hub-id="' + hubEsc(it.id) + '" title="点击启用">' +
      '<span class="hub-item-emoji" aria-hidden="true">' + hubEsc(it.emoji || '⚡') + '</span>' +
      '<span class="hub-item-body"><span class="hub-item-name">' + hubEsc(it.name) +
      (it.alias && it.alias !== it.name ? ' <small>' + hubEsc(it.alias) + '</small>' : '') + '</span>' +
      '<span class="hub-item-desc">' + hubEsc(String(it.desc || '').slice(0, 78)) + '</span></span>' +
      '<span class="hub-item-sec">' + hubEsc(it.section || '') + '</span>' +
    '</button>').join('');
}

/** 全量目录搜索框输入。 */
function hubSetAllQuery(q) {
  HUB_STATE.allQuery = q;
  hubRenderAll();
}

/** 关闭全量目录弹窗。 */
function hubCloseAll() {
  const modal = document.getElementById('hubAll');
  if (modal) modal.hidden = true;
  HUB_STATE.allOpen = false;
}

/** 事件绑定（由 core/bootstrap.js 在 DOM 就绪后调用）。 */
function hubInitComposer() {
  const btn = document.getElementById('composerPlusBtn');
  const menu = document.getElementById('hubMenu');
  if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); hubToggleMenu(); });
  if (menu) menu.addEventListener('click', (e) => e.stopPropagation());

  const add = document.getElementById('hubAddFile');
  if (add) add.addEventListener('click', () => {
    const input = document.getElementById('unifiedFileInput');
    if (input && input.click) input.click();
    hubCloseMenu();
  });
  const quote = document.getElementById('hubQuoteFile');
  if (quote) quote.addEventListener('click', () => {
    hubCloseMenu();
    if (typeof openSessionSearch === 'function') openSessionSearch();
    else if (typeof searchPanelOpen === 'function') searchPanelOpen();
    else if (typeof toast === 'function') toast('会话搜索暂不可用', 'warn');
  });

  document.querySelectorAll('.hub-mi-sub').forEach(el => {
    const kind = el.dataset ? el.dataset.hubSub : '';
    if (el.addEventListener) {
      el.addEventListener('mouseenter', () => hubOpenSub(kind));
      el.addEventListener('focus', () => hubOpenSub(kind));
      el.addEventListener('click', () => hubOpenSub(kind));
    }
  });

  const search = document.getElementById('hubSearch');
  if (search) search.addEventListener('input', (e) => hubSetQuery(e.target.value));

  const list = document.getElementById('hubList');
  if (list) list.addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-hub-id]') : null;
    if (el && el.dataset) hubPick(el.dataset.hubKind, el.dataset.hubId);
  });

  const more = document.getElementById('hubMore');
  if (more) more.addEventListener('click', () => hubOpenAll(HUB_STATE.sub === 'skill' ? 'skill'
    : HUB_STATE.sub === 'connector' ? 'connector' : 'expert'));

  const chip = document.getElementById('hubChip');
  if (chip) chip.addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-hub-act]') : null;
    if (!el || !el.dataset) return;
    if (el.dataset.hubAct === 'clear') { hubClearPick(); return; }
    if (el.dataset.hubAct === 'fill') {
      const pick = HUB_STATE.picks[hubCurrentSid()];
      const input = document.getElementById('userInput');
      if (pick && pick.item && pick.item.init && input) {
        input.value = pick.item.init;
        if (input.focus) input.focus();
      }
    }
  });

  const allBox = document.getElementById('hubAllList');
  if (allBox) allBox.addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-hub-id]') : null;
    if (el && el.dataset) { hubPick(el.dataset.hubKind, el.dataset.hubId); hubCloseAll(); }
  });
  const tabs = document.getElementById('hubAllTabs');
  if (tabs) tabs.addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-hub-tab]') : null;
    if (el && el.dataset) { HUB_STATE.allKind = el.dataset.hubTab; hubRenderAll(); }
  });
  const allSearch = document.getElementById('hubAllSearch');
  if (allSearch) allSearch.addEventListener('input', (e) => hubSetAllQuery(e.target.value));
  const allClose = document.getElementById('hubAllClose');
  if (allClose) allClose.addEventListener('click', hubCloseAll);
  const allModal = document.getElementById('hubAll');
  if (allModal) allModal.addEventListener('click', (e) => {
    if (e.target === allModal) hubCloseAll();
  });

  document.addEventListener('click', () => {
    if (HUB_STATE.open) hubCloseMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (HUB_STATE.allOpen) hubCloseAll();
    else if (HUB_STATE.open) hubCloseMenu();
  });
  hubRenderChip();
}
