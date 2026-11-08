/* ================= R33 · 功能市场（浏览 / 启用 / 停用） =================
 * 与 WorkBuddy 专家中心同形态：顶栏 tab + 搜索 + 我的功能；分区热门卡片；
 * 官方分类标签；综合/最热/最新排序；专家/专家团切换；卡片网格带「启用」。
 *
 * 核心规则（用户要求）：只有在这里点击「启用」的条目，才会出现在会话页
 * 「+」菜单的 专家 / 技能 / 连接器 子面板里。启用态存 localStorage
 * （独立 key，不碰 config.json、不新增 js_api），按全局生效、可随时停用。
 */
const HUB_ENABLED_KEY = 'harbor_hub_enabled';
const HUB_MARKET_PAGE_SIZE = 48;
const HUB_MARKET_STATE = {
  tab: 'expert', sub: 'experts', cat: '全部', sort: '综合',
  q: '', mineOnly: false, open: false, page: 1,
};
const HUB_HOT_SECTIONS = [
  { name: '电商运营', q: '电商', emoji: '🛒' },
  { name: '内容创作', q: '内容创作', emoji: '✍️' },
  { name: '投资分析', q: '投资', emoji: '💰' },
  { name: '法律咨询', q: '法律', emoji: '⚖️' },
  { name: '小微企业', q: '创业', emoji: '🏢' },
];
const hmEsc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 读取启用集（结构：{experts:[],teams:[],skills:[],connectors:[]}）。 */
function hubEnabledLoad() {
  const empty = { experts: [], teams: [], skills: [], connectors: [] };
  try {
    const raw = localStorage.getItem(HUB_ENABLED_KEY);
    if (!raw) return empty;
    const d = JSON.parse(raw) || {};
    Object.keys(empty).forEach(k => {
      empty[k] = Array.isArray(d[k]) ? d[k].filter(x => typeof x === 'string') : [];
    });
  } catch (e) {}
  return empty;
}
function hubEnabledSave(set) {
  try { localStorage.setItem(HUB_ENABLED_KEY, JSON.stringify(set || hubEnabledLoad())); }
  catch (e) {}
}
function hubIsEnabled(kind, id) {
  return (hubEnabledLoad()[kind] || []).indexOf(String(id)) >= 0;
}
function hubEnabledCount() {
  const s = hubEnabledLoad();
  return Object.keys(s).reduce((n, k) => n + s[k].length, 0);
}
/** 已启用项（供加号菜单子面板使用；kind 为目录池名）。 */
function hubEnabledItems(kind) {
  const ids = hubEnabledLoad()[kind] || [];
  return ids.map(id => (typeof hubCatalogById === 'function') ? hubCatalogById(kind, id) : null)
            .filter(Boolean).map(it => Object.assign({}, it, { __kind: kind }));
}
/** 启用 / 停用；同步刷新市场页、加号菜单与 chip。 */
function hubToggleEnabled(kind, id) {
  const set = hubEnabledLoad();
  if (!Array.isArray(set[kind])) set[kind] = [];
  const sid = String(id);
  const at = set[kind].indexOf(sid);
  const nowOn = at < 0;
  if (nowOn) set[kind].push(sid); else set[kind].splice(at, 1);
  hubEnabledSave(set);
  // 停用后清掉仍引用该条目的会话选择，避免指令继续注入
  if (!nowOn && typeof HUB_STATE !== 'undefined' && HUB_STATE.picks) {
    Object.keys(HUB_STATE.picks).forEach(s => {
      const p = HUB_STATE.picks[s];
      if (p && p.kind === kind && p.id === sid) delete HUB_STATE.picks[s];
    });
  }
  hubRenderMarket();
  if (typeof hubRenderSub === 'function') hubRenderSub();
  if (typeof hubRenderChip === 'function') hubRenderChip();
  // R35：连接器启用时真的把 MCP 配置注册进后端运行时（异步，不阻塞 UI）。
  // 停用只清启用态与接入状态，不删用户在设置里手工填过的 MCP 配置。
  if (kind === 'connectors') {
    if (nowOn && typeof hubConnectorInstall === 'function') {
      Promise.resolve(hubConnectorInstall(sid)).catch(() => {});
    } else if (!nowOn && typeof hubConnectorForget === 'function') {
      hubConnectorForget(sid);
    }
  }
  return nowOn;
}
function hubDisableAll() {
  hubEnabledSave({ experts: [], teams: [], skills: [], connectors: [] });
  if (typeof HUB_STATE !== 'undefined' && HUB_STATE.picks) HUB_STATE.picks = {};
  if (typeof hubRenderMarket === 'function') hubRenderMarket();
  if (typeof hubRenderSub === 'function') hubRenderSub();
  if (typeof hubRenderChip === 'function') hubRenderChip();
}

/** 当前 tab 对应的目录池。 */
function hubMarketPools() {
  const s = HUB_MARKET_STATE;
  if (s.tab === 'skill') return ['skills'];
  if (s.tab === 'connector') return ['connectors'];
  return s.sub === 'teams' ? ['teams'] : ['experts'];
}
/** 当前池的全部条目（未经筛选）。 */
function hubMarketPoolItems() {
  const cat = (typeof HUB_CATALOG !== 'undefined') ? HUB_CATALOG : {};
  let out = [];
  hubMarketPools().forEach(k => { out = out.concat(cat[k] || []); });
  return out;
}

function hubOpenMarket(tab) {
  const box = document.getElementById('hubMarket');
  if (!box) return;
  if (tab === 'skill' || tab === 'connector' || tab === 'expert') HUB_MARKET_STATE.tab = tab;
  HUB_MARKET_STATE.open = true;
  box.hidden = false;
  const search = document.getElementById('hmSearch');
  if (search) { search.value = ''; search.placeholder = HUB_MARKET_STATE.tab === 'skill'
    ? '搜索技能' : (HUB_MARKET_STATE.tab === 'connector' ? '搜索连接器' : '搜索专家'); }
  HUB_MARKET_STATE.q = '';
  HUB_MARKET_STATE.cat = '全部';
  HUB_MARKET_STATE.page = 1;
  hubRenderMarket();
  if (typeof hubCloseMenu === 'function') hubCloseMenu();
}
function hubCloseMarket() {
  const box = document.getElementById('hubMarket');
  if (box) box.hidden = true;
  HUB_MARKET_STATE.open = false;
}
function hubSetMarketTab(tab) {
  HUB_MARKET_STATE.tab = tab;
  HUB_MARKET_STATE.sub = (tab === 'expert') ? 'experts' : tab;
  // R34：不同池的分区名完全不同（专家=技术工程/产品设计…，技能=官方内置/
  // 开发者插件市场…，连接器=官方连接器）。切 tab 必须重置分区与搜索词，
  // 否则旧分区会把新池筛成 0 项（用户实测技能/连接器页全空）。
  HUB_MARKET_STATE.cat = '全部';
  HUB_MARKET_STATE.q = '';
  HUB_MARKET_STATE.page = 1;
  const search = document.getElementById('hmSearch');
  if (search) search.value = '';
  document.querySelectorAll('#hmTabs [data-hm-tab]').forEach(b => {
    if (b.classList) b.classList.toggle('on', b.dataset && b.dataset.hmTab === tab);
  });
  hubRenderMarket();
}
function hubSetMarketSub(sub) {
  HUB_MARKET_STATE.sub = sub;
  HUB_MARKET_STATE.cat = '全部';
  HUB_MARKET_STATE.page = 1;
  hubRenderMarket();
}
function hubSetMarketCat(cat) {
  HUB_MARKET_STATE.cat = cat;
  HUB_MARKET_STATE.page = 1;
  hubRenderMarket();
}
function hubSetMarketSort(sort) {
  HUB_MARKET_STATE.sort = sort;
  HUB_MARKET_STATE.page = 1;
  hubRenderMarket();
}
function hubSetMarketQuery(q) {
  HUB_MARKET_STATE.q = String(q || '');
  HUB_MARKET_STATE.page = 1;
  hubRenderMarket();
}
function hubToggleMine() {
  HUB_MARKET_STATE.mineOnly = !HUB_MARKET_STATE.mineOnly;
  HUB_MARKET_STATE.page = 1;
  hubRenderMarket();
}
/** R35：分页——628 个连接器 / 377 个技能要能真正翻到，不能只显示前 48 个。 */
function hubSetMarketPage(page) {
  HUB_MARKET_STATE.page = Math.max(1, Number(page) || 1);
  hubRenderMarket();
  const grid = document.getElementById('hmGrid');
  if (grid && grid.scrollTo) { try { grid.scrollTo(0, 0); } catch (e) {} }
}

/** R34：当前池的分区列表（不是写死的 15 个专家分类）。
 *  专家/专家团按官方分类顺序排；技能/连接器用目录里真实的 section。 */
function hubMarketSections() {
  const cat = (typeof HUB_CATALOG !== 'undefined') ? HUB_CATALOG : {};
  const seen = [];
  hubMarketPoolItems().forEach(it => {
    const n = it.section || '其他';
    if (seen.indexOf(n) < 0) seen.push(n);
  });
  if (HUB_MARKET_STATE.tab === 'expert') {
    const order = (cat.categories || []).map(c => c.name);
    seen.sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
  }
  return ['全部'].concat(seen);
}

/** 市场页主渲染。 */
function hubRenderMarket() {
  const s = HUB_MARKET_STATE;
  const cat = (typeof HUB_CATALOG !== 'undefined') ? HUB_CATALOG : {};
  const enabled = hubEnabledLoad();
  const kinds = ['experts', 'teams', 'skills', 'connectors'];

  // 我的功能计数
  const mineEl = document.getElementById('hmMineCount');
  if (mineEl) mineEl.textContent = String(hubEnabledCount());
  const mineBtn = document.getElementById('hmMine');
  if (mineBtn && mineBtn.classList) mineBtn.classList.toggle('on', s.mineOnly);

  // 分区热门卡（点击把关键词带入搜索）
  const hot = document.getElementById('hmHot');
  if (hot) {
    hot.innerHTML = HUB_HOT_SECTIONS.map(sec => {
      const picks = (typeof hubCatalogSearch === 'function')
        ? hubCatalogSearch(['experts', 'teams'], sec.q, 3) : [];
      const names = picks.map(p => p.name).filter(Boolean);
      return '<button type="button" class="hm-hot-card" data-hm-hot="' + hmEsc(sec.q) + '">' +
        '<span class="hm-hot-emoji" aria-hidden="true">' + sec.emoji + '</span>' +
        '<span class="hm-hot-title">' + hmEsc(sec.name) + '</span>' +
        '<span class="hm-hot-list">' + (names.length
          ? names.map(n => hmEsc(n) + ' ›').join('<br>')
          : '查看相关专家 ›') + '</span>' +
      '</button>';
    }).join('');
  }

  // 分类标签：随当前池变化（专家 15 类 / 技能 6 个市场分区 / 连接器 1 类）
  const sections = hubMarketSections();
  if (s.cat !== '全部' && sections.indexOf(s.cat) < 0) s.cat = '全部';
  const cats = document.getElementById('hmCats');
  if (cats) {
    const list = sections;
    cats.innerHTML = list.map(n =>
      '<button type="button" class="hm-cat' + (s.cat === n ? ' on' : '') +
      '" data-hm-cat="' + hmEsc(n) + '">' + hmEsc(n) + '</button>').join('');
  }
  document.querySelectorAll('#hmSorts [data-hm-sort]').forEach(b => {
    if (b.classList) b.classList.toggle('on', b.dataset && b.dataset.hmSort === s.sort);
  });

  // 专家 / 专家团 子切换
  const subs = document.getElementById('hmSubtabs');
  if (subs) {
    subs.innerHTML = (s.tab === 'expert')
      ? '<button type="button" class="hm-sub' + (s.sub === 'experts' ? ' on' : '') +
        '" data-hm-sub="experts">专家</button>' +
        '<button type="button" class="hm-sub' + (s.sub === 'teams' ? ' on' : '') +
        '" data-hm-sub="teams">专家团</button>'
      : '<span class="hm-sub-label">' + (s.tab === 'skill' ? '技能' : '连接器') + '</span>';
  }

  // 卡片网格
  const grid = document.getElementById('hmGrid');
  const foot = document.getElementById('hmFoot');
  if (!grid) return;
  let items = hubMarketPoolItems();
  if (s.cat !== '全部') items = items.filter(it => it.section === s.cat);
  if (s.mineOnly) {
    const ids = enabled[hubMarketPools()[0]] || [];
    items = items.filter(it => ids.indexOf(String(it.id)) >= 0);
  }
  const q = s.q.trim().toLowerCase();
  if (q) {
    items = items.filter(it => ((it.name || '') + ' ' + (it.desc || '') + ' ' +
      (it.tags || []).join(' ') + ' ' + (it.section || '') + ' ' + (it.alias || ''))
      .toLowerCase().indexOf(q) >= 0);
  }
  if (s.sort === '最热') items.sort((a, b) => (b.hot || 0) - (a.hot || 0));
  else if (s.sort === '最新') items.reverse();
  else items.sort((a, b) => (b.hot || 0) - (a.hot || 0));   // 综合：官方热门优先
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / HUB_MARKET_PAGE_SIZE));
  if (s.page > pages) s.page = pages;
  const from = (s.page - 1) * HUB_MARKET_PAGE_SIZE;
  const shown = items.slice(from, from + HUB_MARKET_PAGE_SIZE);
  const pool = hubMarketPools()[0];
  if (!shown.length) {
    grid.innerHTML = '<div class="hm-empty">' +
      (s.mineOnly ? '还没有启用任何条目，点「启用」后会出现在这里和会话页 + 菜单里。'
                  : '没有匹配的条目，换个关键词或点「全部」分区试试。') + '</div>';
  } else {
    grid.innerHTML = shown.map(it => {
      const on = (enabled[pool] || []).indexOf(String(it.id)) >= 0;
      const isConn = pool === 'connectors';
      // R35：连接器卡片如实标注「可直连 / 需授权 / 仅目录 / 已接入 N 个工具」，
      // 并给一个「测试连接」入口重试，绝不把仅目录项说成可用。
      const meta = (isConn && typeof hubConnCardMeta === 'function')
        ? hubConnCardMeta(it) : null;
      return '<article class="hm-card' + (on ? ' enabled' : '') + '">' +
        '<div class="hm-card-top">' +
          '<span class="hm-card-emoji" aria-hidden="true">' + hmEsc(it.emoji || '⚡') + '</span>' +
          '<div class="hm-card-title"><b>' + hmEsc(it.name) + '</b>' +
            (it.alias && it.alias !== it.name ? '<small>' + hmEsc(it.alias) + '</small>' : '') +
          '</div>' +
          (!meta && it.hot ? '<span class="hm-card-hot">热门</span>' : '') +
        '</div>' +
        (meta ? '<div class="hm-link hm-link-' + hmEsc(meta.cls) + '" title="' +
          hmEsc(it.linkNote || meta.text) + '">' + hmEsc(meta.text) + '</div>' : '') +
        '<p class="hm-card-desc">' + hmEsc([...String(it.desc || '')].slice(0, 62).join('')) + '</p>' +
        '<div class="hm-card-tags">' + (it.tags || []).slice(0, 3).map(t =>
          '<span>' + hmEsc(t) + '</span>').join('') +
          (it.section ? '<span class="hm-card-sec">' + hmEsc(it.section) + '</span>' : '') + '</div>' +
        '<div class="hm-card-foot' + (meta && meta.canTest ? ' hm-card-foot-split' : '') + '">' +
          (meta && meta.canTest ? '<button type="button" class="hm-test" data-hm-test="' +
            hmEsc(it.id) + '" title="注册并实测连接">测试连接</button>' : '') +
          '<button type="button" class="hm-enable' + (on ? ' on' : '') +
            '" data-hm-kind="' + hmEsc(pool) + '" data-hm-id="' + hmEsc(it.id) + '">' +
            (on ? '✓ 已启用' : '+ 启用') + '</button>' +
        '</div>' +
      '</article>';
    }).join('');
  }
  const stat = document.getElementById('hmLinkStat');
  if (stat) {
    const all = (typeof HUB_CATALOG !== 'undefined' && HUB_CATALOG.connectors)
      ? HUB_CATALOG.connectors : [];
    const counts = {};
    all.forEach(x => { counts[x.link || 'catalog'] = (counts[x.link || 'catalog'] || 0) + 1; });
    const zh = (typeof HUB_CONN_LEVEL_ZH !== 'undefined') ? HUB_CONN_LEVEL_ZH : {};
    stat.textContent = s.tab === 'connector'
      ? ('已实测可直连 ' + (counts.ready || 0) + ' 项 · 其余服务需 WorkBuddy 账号授权，已按你的要求从市场移除')
      : '';
    stat.hidden = s.tab !== 'connector';
  }
  if (foot) {
    const pager = pages > 1
      ? '<span class="hm-pager">' +
        '<button type="button" data-hm-page="' + (s.page - 1) + '"' +
        (s.page <= 1 ? ' disabled' : '') + '>上一页</button>' +
        '<b>' + s.page + ' / ' + pages + '</b>' +
        '<button type="button" data-hm-page="' + (s.page + 1) + '"' +
        (s.page >= pages ? ' disabled' : '') + '>下一页</button></span>'
      : '';
    foot.innerHTML = '<span>共 ' + total + ' 项 · 已启用 ' + hubEnabledCount() + ' 项' +
      (total > shown.length ? ' · 本页 ' + shown.length + ' 项，可搜索或翻页' : '') + '</span>' +
      pager + '<button type="button" class="hm-disable-all" id="hmDisableAll">全部停用</button>';
  }
}

/** 事件绑定（由 hubInitComposer 调用）。 */
function hubInitMarket() {
  const tabs = document.getElementById('hmTabs');
  if (tabs) tabs.addEventListener('click', e => {
    const b = e.target && e.target.closest ? e.target.closest('[data-hm-tab]') : null;
    if (b && b.dataset) hubSetMarketTab(b.dataset.hmTab);
  });
  const cats = document.getElementById('hmCats');
  if (cats) cats.addEventListener('click', e => {
    const b = e.target && e.target.closest ? e.target.closest('[data-hm-cat]') : null;
    if (b && b.dataset) hubSetMarketCat(b.dataset.hmCat);
  });
  const sorts = document.getElementById('hmSorts');
  if (sorts) sorts.addEventListener('click', e => {
    const b = e.target && e.target.closest ? e.target.closest('[data-hm-sort]') : null;
    if (b && b.dataset) hubSetMarketSort(b.dataset.hmSort);
  });
  const subs = document.getElementById('hmSubtabs');
  if (subs) subs.addEventListener('click', e => {
    const b = e.target && e.target.closest ? e.target.closest('[data-hm-sub]') : null;
    if (b && b.dataset) hubSetMarketSub(b.dataset.hmSub);
  });
  const hot = document.getElementById('hmHot');
  if (hot) hot.addEventListener('click', e => {
    const b = e.target && e.target.closest ? e.target.closest('[data-hm-hot]') : null;
    if (!b || !b.dataset) return;
    const input = document.getElementById('hmSearch');
    if (input) input.value = b.dataset.hmHot;
    HUB_MARKET_STATE.tab = 'expert';
    HUB_MARKET_STATE.sub = 'experts';
    HUB_MARKET_STATE.cat = '全部';
    hubSetMarketQuery(b.dataset.hmHot);
  });
  const search = document.getElementById('hmSearch');
  if (search) search.addEventListener('input', e => hubSetMarketQuery(e.target.value));
  const mine = document.getElementById('hmMine');
  if (mine) mine.addEventListener('click', hubToggleMine);
  const close = document.getElementById('hmClose');
  if (close) close.addEventListener('click', hubCloseMarket);
  const overlay = document.getElementById('hubMarket');
  if (overlay) overlay.addEventListener('click', e => { if (e.target === overlay) hubCloseMarket(); });
  const grid = document.getElementById('hmGrid');
  if (grid) grid.addEventListener('click', e => {
    const t = e.target && e.target.closest ? e.target.closest('[data-hm-test]') : null;
    if (t && t.dataset && typeof hubConnectorInstall === 'function') {
      Promise.resolve(hubConnectorInstall(t.dataset.hmTest)).catch(() => {});
      return;
    }
    const b = e.target && e.target.closest ? e.target.closest('[data-hm-id]') : null;
    if (b && b.dataset) hubToggleEnabled(b.dataset.hmKind, b.dataset.hmId);
  });
  const foot = document.getElementById('hmFoot');
  if (foot) foot.addEventListener('click', e => {
    const p = e.target && e.target.closest ? e.target.closest('[data-hm-page]') : null;
    if (p && p.dataset) { hubSetMarketPage(p.dataset.hmPage); return; }
    const b = e.target && e.target.closest ? e.target.closest('#hmDisableAll') : null;
    if (b) hubDisableAll();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && HUB_MARKET_STATE.open) hubCloseMarket();
  });
}
