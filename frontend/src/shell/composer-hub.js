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
    // R33：只显示功能市场里已启用的条目 —— 未启用的不进加号菜单
    if (typeof hubEnabledItems === 'function') {
      hubSubPools(kind).forEach(k => { items = items.concat(hubEnabledItems(k)); });
    }
    if (q) {
      const ql = q.toLowerCase();
      items = items.filter(it => ((it.name || '') + ' ' + (it.desc || '') + ' ' +
        (it.tags || []).join(' ')).toLowerCase().indexOf(ql) >= 0);
    }
    items = items.slice(0, 30);
  }
  const more = document.getElementById('hubMore');
  if (more) more.textContent = (kind === 'mode' ? '在设置中调整更多权限…'
    : '去功能市场启用更多…');
  if (!items.length) {
    const why = q ? '没有匹配的已启用条目' : ('还没有启用任何' +
      (kind === 'skill' ? '技能' : kind === 'connector' ? '连接器' : '专家/专家团'));
    box.innerHTML = '<div class="hub-empty">' + why + '</div>' +
      (kind === 'mode' ? '' :
        '<button type="button" class="hub-item hub-market-link" data-hub-act="market">' +
        '<span class="hub-item-emoji" aria-hidden="true">🛍️</span>' +
        '<span class="hub-item-body"><span class="hub-item-name">去功能市场启用 →</span>' +
        '<span class="hub-item-desc">启用后才会出现在这里</span></span></button>');
    return;
  }
  box.innerHTML = items.map(it =>
    '<button type="button" class="hub-item" data-hub-kind="' + hubEsc(it.__kind) +
    '" data-hub-id="' + hubEsc(it.id) + '" title="' + hubEsc(it.desc || '') + '">' +
      '<span class="hub-item-emoji" aria-hidden="true">' + hubEsc(it.emoji || '⚡') + '</span>' +
      '<span class="hub-item-body"><span class="hub-item-name">' + hubEsc(it.name) + '</span>' +
      '<span class="hub-item-desc">' + hubEsc([...String(it.desc || '')].slice(0, 46).join('')) + '</span></span>' +
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
    // R35：连接器不再是「只跳设置页」的占位。启用后注册进 MCP 运行时，
    // 这里把它作为当前会话的已选能力记录 → hubDirectiveFor() 注入系统提示，
    // 模型据 mcp__ 工具前缀调用真实外部服务；未接入时如实提示，不假装可用。
    const item = (typeof hubCatalogById === 'function')
      ? hubCatalogById('connectors', id) : null;
    if (!item) return false;
    if (typeof hubIsEnabled === 'function' && !hubIsEnabled(kind, id)) {
      if (typeof toast === 'function') toast('请先在「功能市场」里启用「' + item.name + '」', 'warn');
      return false;
    }
    HUB_STATE.picks[sid] = { kind: kind, id: id, item: item };
    hubRenderChip();
    const st = (typeof hubConnState === 'function') ? hubConnState(id) : null;
    if (typeof toast === 'function') {
      if (st && st.ok) toast('「' + item.name + '」已接入，本会话可直接调用其工具', 'ok');
      else if (item.link === 'catalog' || item.link === 'sse') {
        toast('「' + item.name + '」' + (item.linkNote || '暂无可连接配置') +
          '；已作为角色说明注入，但不会调用外部服务', 'warn');
      } else {
        toast('「' + item.name + '」尚未接通；点市场里的「测试连接」或到设置完成授权', 'warn');
      }
    }
    // 未接入且可接入：顺手触发一次真实注册（异步，结果由市场卡片显示）
    if ((!st || !st.ok) && item.mcp && typeof hubConnectorInstall === 'function') {
      Promise.resolve(hubConnectorInstall(id)).catch(() => {});
    }
    const input = document.getElementById('userInput');
    if (input && !String(input.value || '').trim() && item.init) {
      input.value = item.init;
      if (input.dispatchEvent) {
        try { input.dispatchEvent(new Event('input')); } catch (e) {}
      }
    }
    hubCloseMenu();
    return true;
  }
  const item = (typeof hubCatalogById === 'function') ? hubCatalogById(kind, id) : null;
  if (!item) return false;
  // R33：功能市场未启用的条目不允许在会话里直接使用
  if (typeof hubIsEnabled === 'function' && !hubIsEnabled(kind, id)) {
    if (typeof toast === 'function') toast('请先在「功能市场」里启用「' + item.name + '」', 'warn');
    return false;
  }
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
    '<span class="hub-chip-tag">' + (it.kind === 'team' ? '专家团' : it.kind === 'expert' ? '专家'
      : it.kind === 'connector' ? '连接器' : '技能') + ' · 已启用</span>' +
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
    const act = e.target && e.target.closest ? e.target.closest('[data-hub-act]') : null;
    if (act && act.dataset && act.dataset.hubAct === 'market') {
      hubCloseMenu();
      if (typeof hubOpenMarket === 'function') hubOpenMarket(
        HUB_STATE.sub === 'skill' ? 'skill' : HUB_STATE.sub === 'connector' ? 'connector' : 'expert');
      return;
    }
    const el = e.target && e.target.closest ? e.target.closest('[data-hub-id]') : null;
    if (el && el.dataset) hubPick(el.dataset.hubKind, el.dataset.hubId);
  });

  const more = document.getElementById('hubMore');
  if (more) more.addEventListener('click', () => {
    hubCloseMenu();
    if (typeof hubOpenMarket === 'function') hubOpenMarket(HUB_STATE.sub === 'skill' ? 'skill'
      : HUB_STATE.sub === 'connector' ? 'connector' : 'expert');
  });

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
  if (typeof hubInitMarket === 'function') hubInitMarket();
  hubRenderChip();
}
