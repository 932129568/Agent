/* ================= 搜索面板（v1.8.0 B 域 U1，实现 v1.8.0 B2） =================
 * #searchPanel + .sp-*（纯新增 DOM，UI 契约只增不改——check_contract 验）：
 * 结果列表 / 原文预览 / 缓存来源标注 / 人工接管区 / 阶段 pill + 进度。
 * 契约口径（联调规范 §2/§3.1 + ux-flows 流程 1/2/3）：
 * - 三态状态机 idle/pending/success/error + 请求序号 last-wins
 *   （searchReqSeq，同 36-connect connectIdentifySeq 先例；pending 期间新
 *   触发 → seq+1 覆盖，旧请求返回后 seq!==searchReqSeq 静默丢弃）；
 * - ≥3s 可见等待：browser_search 在途期间 1s 轮询 search_status（§2.4 方案
 *   A：面板打开起、关闭/终态停；phase → 阶段 pill 文案轮换，P2 最短展示
 *   400ms 由 CSS 过渡承担）；
 * - CAPTCHA 接管（流程 2）：CAPTCHA_REQUIRED → 接管区（「请完成验证」+
 *   继续/放弃，面板不可关闭）→ browser_takeover continue 成功载荷渲染 /
 *   abort → CAPTCHA_ABORTED 人话；
 * - typeof 守卫（§2.5 vm 沙箱可测）：模块顶层不直接引用 window/document/
 *   localStorage，一律函数体内守卫或注入；callApi 统一经 spCallApi 四步
 *   （入口守卫 → 序号登记 → 竞速调用 → 序号校验）。
 * 挂载：110-boot.js loadAll 内 try{ searchPanelInit(); }catch（功能分级
 * 开关「浏览器搜索」默认开——spFeatureEnabled，localStorage 持久化）。
 * C 域批次：25-tool-exec.js executeToolRaw 新分支将调 searchPanelRunSearch
 * 驱动 Agent 工具循环的进度与结果渲染（本批只提供面板侧能力）。
 */
const SP_POLL_INTERVAL_MS = 1000;      // search_status 轮询间隔（§2.4）
const SP_STATUS_TIMEOUT_MS = 15000;    // 纯内存状态读，快失败（§2.1 表）
const SP_SEARCH_TIMEOUT_MS = 90000;    // browser_search（extract=full 时前端可传 150000）
const SP_TAKEOVER_TIMEOUT_MS = 90000;  // browser_takeover（§2.1 表）
const SP_STATS_TIMEOUT_MS = 15000;     // search_cache_stats
// 接管 TTL 与到期预警（与 backend search_service.TAKEOVER_TTL_SECONDS=600 逐字一致；
// 面板轮询已带 takeover.elapsed_s，到期前 60s toast 一次零额外成本）
const SP_TAKEOVER_TTL_S = 600;
const SP_TAKEOVER_WARN_LEAD_S = 60;
// 后端 phase → 阶段文案（§2.3 四件套映射表；motion-spec §2.1 为动效真相源）
const SP_PHASE_TEXT = {
  understanding: '正在理解检索意图…',
  cache_check: '正在检查缓存…',
  window_loading: '正在打开搜索引擎…',
  urllib_fallback: '已切换轻量抓取（降级）…',
  extracting: '正在提取搜索结果…',
  filtering: '正在整理结果…',
  deep_extract: '正在读取正文…',
  validating: '正在校验结果…',
  reformulate: '正在改写检索式重试…',
  captcha: '需要人工验证',
  done: '搜索完成',
  failed: '搜索失败'
};
// 功能分级开关键（设置可单独关搜索；默认开——架构 §5 行为兼容）
const SP_FEATURE_KEY = 'glm_feat_search_v18';

let searchReqSeq = 0;          // last-wins 请求序号（每次触发递增，旧请求失效）
let searchPanelState = 'idle'; // idle|pending|success|error|captcha
let searchPollTimer = null;    // 1s 轮询定时器句柄
let searchTakeoverId = null;   // 当前接管会话（captcha 态非空）
let searchLastPayload = null;  // 最近一次成功载荷（原文预览/重渲染用）
let spStatsSeq = 0;            // 脚注统计 last-wins（同 searchReqSeq 先例）
let spTakeoverWarned = false;  // 当前接管会话是否已做过 TTL 到期预警（每会话一次）

/* ---------- typeof 守卫取值（§2.5：vm 沙箱无 DOM 不炸） ---------- */
function searchPanelEl() {
  return (typeof document !== 'undefined') ? document.getElementById('searchPanel') : null;
}
function spEl(id) {
  return (typeof document !== 'undefined') ? document.getElementById(id) : null;
}
function spFeatureEnabled() {
  try {
    if (typeof localStorage === 'undefined') return true;
    const v = localStorage.getItem(SP_FEATURE_KEY);
    return v === null || v === '1';   // 缺省 = 开（默认开）
  } catch (e) { return true; }
}
function spCallApi(name, args, timeoutMs) {
  // §2.1 四步之①入口守卫（与 callApi 既有口径一致，vm 下显式抛可断言）
  if (typeof callApi !== 'function') {
    throw new Error('pywebview bridge 未就绪: ' + name);
  }
  return callApi(name, args, timeoutMs);
}
function spToast(msg, kind) {
  if (typeof toast === 'function') toast(msg, kind || 'info');
}

/* ---------- 面板骨架（纯新增 DOM；动态创建，不碰 index.template.html） ---------- */
function searchPanelInit() {
  if (!spFeatureEnabled()) return false;          // 功能分级开关：关则不挂载
  if (searchPanelEl()) { searchPanelWire(); return true; }   // 幂等
  if (typeof document === 'undefined') return false;
  const panel = document.createElement('div');
  panel.id = 'searchPanel';
  panel.className = 'sp-root';
  panel.setAttribute('data-state', 'idle');
  panel.innerHTML =
    '<div class="sp-head">' +
      '<span class="sp-title">浏览器搜索</span>' +
      '<span class="sp-pill" id="spPill">就绪</span>' +
      '<button class="sp-fold" id="spFold" title="折叠/展开面板" aria-label="折叠/展开面板">▾</button>' +
      '<button class="sp-close" id="spClose" title="关闭面板（Esc）" aria-label="关闭面板">×</button>' +
    '</div>' +
    '<div class="sp-progress"><div class="sp-progress-bar" id="spProgressBar"></div></div>' +
    '<div class="sp-query">' +
      '<input class="sp-input" id="spInput" placeholder="输入检索词，如 python 教程" maxlength="500">' +
      '<button class="sp-search-btn" id="spSearchBtn">搜索</button>' +
    '</div>' +
    '<div class="sp-meta" id="spMeta"></div>' +
    '<div class="sp-takeover" id="spTakeover" style="display:none">' +
      '<div class="sp-takeover-title">🔒 搜索引擎要求人机验证</div>' +
      '<div class="sp-takeover-desc">请在弹出的窗口中完成验证，然后点击「继续」。</div>' +
      '<div class="sp-takeover-timer" id="spTakeoverTimer">已等待 0:00</div>' +
      '<div class="sp-takeover-btns">' +
        '<button class="sp-btn sp-btn-primary" id="spTakeoverContinue">继续</button>' +
        '<button class="sp-btn" id="spTakeoverAbort">放弃</button>' +
      '</div>' +
    '</div>' +
    '<div class="sp-results" id="spResults"></div>' +
    '<div class="sp-foot" id="spFoot"></div>';
  document.body.appendChild(panel);
  searchPanelWire();
  return true;
}
function searchPanelWire() {
  const wirePanel = searchPanelEl();
  if (wirePanel) {
    if (wirePanel.__spWired) return;      // 幂等：防重复接线（监听器翻倍）
    wirePanel.__spWired = true;
  }
  const close = spEl('spClose');
  if (close) close.addEventListener('click', () => searchPanelClose());
  const fold = spEl('spFold');
  if (fold) fold.addEventListener('click', () => searchPanelToggleFold());
  const btn = spEl('spSearchBtn');
  if (btn) btn.addEventListener('click', () => {
    const input = spEl('spInput');
    const q = input ? input.value : '';
    if (!q.trim()) { spToast('先输入检索词', 'warn'); return; }   // 空 query 前置校验
    searchPanelRunSearch({ query: q });
  });
  const cont = spEl('spTakeoverContinue');
  if (cont) cont.addEventListener('click', () => searchPanelTakeoverAction('continue'));
  const ab = spEl('spTakeoverAbort');
  if (ab) ab.addEventListener('click', () => searchPanelTakeoverAction('abort'));
  /* v1.8.0 交互补全：Esc 关闭（captcha 态除外，与 × 同规则）+ 点面板外关闭。
     typeof 守卫：vm 沙箱 document 桩可能无 addEventListener（§2.5） */
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const panel = searchPanelEl();
      if (!panel || !panel.classList.contains('show')) return;
      if (searchPanelState === 'captcha') {
        spToast('请先完成验证或点击「放弃」', 'warn');
        return;
      }
      searchPanelClose();
    });
    document.addEventListener('mousedown', (e) => {
      const panel = searchPanelEl();
      if (!panel || !panel.classList.contains('show')) return;
      if (e.target && e.target.closest && e.target.closest('#searchPanel')) return;
      if (searchPanelState === 'captcha') return;   // 接管中不误关
      searchPanelClose();
    });
  }
  searchPanelRefreshStats();
}

/* ---------- 折叠（只留头部+查询行；治「不能缩回去」） ---------- */
function searchPanelToggleFold() {
  const panel = searchPanelEl();
  if (!panel) return;
  panel.classList.toggle('sp-collapsed');
  const fold = spEl('spFold');
  if (fold) fold.title = panel.classList.contains('sp-collapsed') ? '展开面板' : '折叠面板';
}

/* ---------- 开/关（面板打开起轮询、关闭停；captcha 态不可关闭） ---------- */
function spManualOpen() {
  if (!searchPanelEl()) searchPanelInit();
  const panel = searchPanelEl();
  if (panel && panel.classList.contains('show')) { searchPanelClose(); return; }  // 再点=收起
  searchPanelOpen();
  const input = spEl('spInput');
  if (input) setTimeout(() => input.focus(), 60);
}
function searchPanelOpen() {
  const panel = searchPanelEl();
  if (!panel) return;
  if (panel.classList.contains('hiding')) {
    panel.classList.remove('hiding');   // 退场中途重开：直接落位
  }
  panel.classList.add('show');
  searchPanelRefreshStats();
  searchPanelStartPolling();
}
function searchPanelClose() {
  // ux-flows 流程 2④：takeover_prompting 面板不可关闭（只能继续/放弃）——
  // 防用户忽略后 Agent 永久挂起
  if (searchTakeoverId && searchPanelState === 'captcha') {
    spToast('请先完成验证或点击「放弃」', 'warn');
    return;
  }
  const panel = searchPanelEl();
  searchPanelStopPolling();
  if (!panel || !panel.classList.contains('show')) return;
  panel.classList.add('hiding');
  const done = () => {
    try { panel.classList.remove('show', 'hiding'); } catch (e) {}
  };
  if (typeof MOTION !== 'undefined' && !MOTION.instant()) {
    MOTION.onAnimEnd(panel, 'animationend', MOTION.compOut()).then(done);
  } else { done(); }
}

/* ---------- 三态 + last-wins 主入口（C 域 25-tool-exec 分发亦走此函数） ---------- */
async function searchPanelRunSearch(params) {
  // 新搜索取代在途接管会话（流程 2：旧 takeover 失效须通知 Agent 循环收尾，
  // 否则挂起的工具轮次永久悬挂）
  if (searchTakeoverId) {
    if (typeof harborTakeoverNotify === 'function') {
      harborTakeoverNotify({ ok: false, error: { code: 'CAPTCHA_ABORTED',
        message: '已被新的搜索请求取代' } });
    }
    searchTakeoverId = null;
    searchPanelHideTakeover();
  }
  const seq = ++searchReqSeq;                       // ②序号登记
  searchPanelSetState('pending');
  searchPanelOpen();                                // 打开即起轮询（≥3s 可见等待）
  const btn = spEl('spSearchBtn');
  if (btn) btn.disabled = true;                     // pending 防连点
  const bar = spEl('spProgressBar');
  if (bar) { bar.classList.add('indet'); bar.style.transform = ''; }   // 不确定进度扫光
  try {
    // 复核修正（真机实证）：手动「搜索」与 AI 同走护栏链——armed 态 session
    // 档无 token 即 CONFIRM_REQUIRED。origin='user'：用户即确认主体，措辞
    // 去「AI 请求」；拒绝/异常按面板错误态渲染。
    if (typeof agentGuardCheck === 'function') {
      const g = await agentGuardCheck('web_search',
        { query: String((params && params.query) || '').slice(0, 120) }, 'user');
      if (seq !== searchReqSeq) return;
      if (g.blocked) {
        let b = {};
        try { b = JSON.parse(g.blocked); } catch (e2) {}
        searchPanelRenderError({ code: 'USER_DENIED',
          message: (b && (b.info || b.error)) || '用户取消了本次搜索' });
        searchPanelSetState('error');
        return;
      }
      var spGuardToken = g.token;
    }
    const raw = await spCallApi('browser_search', [params || {}, spGuardToken],
      (params && params.extract === 'full') ? 150000 : SP_SEARCH_TIMEOUT_MS);  // ③竞速
    if (seq !== searchReqSeq) return;               // ④last-wins：旧请求静默失效
    const d = JSON.parse(raw || '{}');
    if (d && d.ok) {
      // 成功路径同样清洗接管区：pending 期间轮询镜像可能已把（旧会话的）
      // takeover_id 挂进 searchTakeoverId，搜索成功时须收起接管 UI 并释放
      // 会话引用（防成功态下滞留 captcha 框 / 后续误关拦截）
      if (searchTakeoverId) {
        searchTakeoverId = null;
        searchPanelHideTakeover();
      }
      searchLastPayload = d;
      searchPanelRenderResults(d);
      searchPanelSetState('success');
    } else if (d && d.error && d.error.code === 'CAPTCHA_REQUIRED') {
      searchTakeoverId = d.error.takeover_id || null;
      searchPanelShowTakeover(d.error);
      searchPanelSetState('captcha');
    } else {
      // 通用错误同样清洗接管区：轮询镜像（searchPanelSetPhase）可能已把
      // captcha 快照的 takeover_id 挂进 searchTakeoverId，搜索失败时须收起
      // 接管 UI 并通知 Agent 收尾（防挂起的工具轮次永久悬挂）
      if (searchTakeoverId) {
        if (typeof harborTakeoverNotify === 'function') {
          harborTakeoverNotify({ ok: false, error: { code: 'CAPTCHA_ABORTED',
            message: '接管会话已失效或失败，本次搜索已放弃' } });
        }
        searchTakeoverId = null;
        searchPanelHideTakeover();
      }
      searchPanelRenderError((d && d.error) || { code: 'INTERNAL', message: '搜索失败' });
      searchPanelSetState('error');
    }
  } catch (e) {
    if (seq !== searchReqSeq) return;
    searchPanelRenderError({ code: 'BRIDGE_TIMEOUT',
      message: (e && e.message) || String(e) });
    searchPanelSetState('error');
  } finally {
    if (seq === searchReqSeq) {
      const btn2 = spEl('spSearchBtn');
      if (btn2) btn2.disabled = false;              // 终态恢复（pending 防连点）
      const bar2 = spEl('spProgressBar');
      if (bar2) bar2.classList.remove('indet');     // 停不确定扫光（确定进度由 phase 驱动）
    }
    searchPanelRefreshStats();                      // last-wins 无关：脚注统计无害
  }
}

/* ---------- 接管动作（流程 2 步骤 4a/4b） ---------- */
async function searchPanelTakeoverAction(action) {
  if (!searchTakeoverId) return;
  const seq = ++searchReqSeq;
  const cont = spEl('spTakeoverContinue');
  const ab = spEl('spTakeoverAbort');
  if (cont) cont.disabled = true;                   // 在途防连点（后端亦幂等）
  if (ab) ab.disabled = true;
  try {
    const raw = await spCallApi('browser_takeover', [searchTakeoverId, action],
      SP_TAKEOVER_TIMEOUT_MS);
    if (seq !== searchReqSeq) return;
    const d = JSON.parse(raw || '{}');
    if (d && d.ok) {
      searchTakeoverId = null;
      searchPanelHideTakeover();
      searchLastPayload = d;
      searchPanelRenderResults(d);
      searchPanelSetState('success');
      spToast('验证通过，继续搜索', 'ok');
      // v1.8.0 C 域：接管终态通知 Agent 循环（§2.4：成功载荷注入挂起的工具轮次；
      // typeof 守卫——vm 单模块沙箱无 60-agent-loop 时不炸）
      if (typeof harborTakeoverNotify === 'function') harborTakeoverNotify(d);
    } else if (d && d.error && d.error.code === 'CAPTCHA_REQUIRED') {
      // 非终态：后端复检已完成并回到 prompting 态（search_service：仍验证页 →
      // state='prompting'，注释明示「用户可再次 continue」）——必须解禁按钮让
      // 用户完成验证后再次点击「继续」（重试计数由后端 max_retries 兜底）。
      // 反例（round5 原实现）：此处保持禁用 → toast「请重试」与禁用按钮自相
      // 矛盾，用户既不能继续也不能放弃，面板因 captcha 态关不掉 → 死局。
      searchPanelShowTakeover(d.error);             // 刷新「继续（重试 n/3）」按钮文案
      const n = (d.error.retry || 1);
      spToast('验证未通过，请重试（' + n + '/' + (d.error.max_retries || 3) + '）', 'warn');
    } else if (d && d.error && d.error.code === 'CAPTCHA_ABORTED') {
      searchTakeoverId = null;
      searchPanelHideTakeover();
      searchPanelRenderError(d.error);
      searchPanelSetState('error');
      spToast('已放弃本次搜索', 'warn');
      // v1.8.0 C 域：放弃终态同样通知（Agent 换引擎/告知用户）
      if (typeof harborTakeoverNotify === 'function') harborTakeoverNotify(d);
    } else {
      // 通用错误：接管会话已失效——清洗接管区并通知 Agent 收尾（防挂起）
      searchTakeoverId = null;
      searchPanelHideTakeover();
      searchPanelRenderError((d && d.error) || { code: 'INTERNAL', message: '操作失败' });
      searchPanelSetState('error');
      if (typeof harborTakeoverNotify === 'function') {
        harborTakeoverNotify({ ok: false, error: { code: 'CAPTCHA_ABORTED',
          message: '接管会话已失效或失败，本次搜索已放弃' } });
      }
    }
  } catch (e) {
    if (seq !== searchReqSeq) return;
    spToast('接管操作失败：' + ((e && e.message) || String(e)), 'err');
    // 桥接层异常同属非终态失败：通知 Agent 放弃本轮（防工具轮次永久挂起）
    if (typeof harborTakeoverNotify === 'function') {
      harborTakeoverNotify({ ok: false, error: { code: 'CAPTCHA_ABORTED',
        message: '接管会话已失效或失败，本次搜索已放弃' } });
    }
  } finally {
    // seq 守卫即「旧请求 finally 不得解禁新分支」的结构性保证：所有入口
    // （runSearch/takeoverAction）都先 ++searchReqSeq 再动 DOM，旧 finally
    // 回来时 seq 已漂移 → 跳过；只有当前请求的 finally 能恢复按钮。
    if (seq === searchReqSeq) {
      if (cont) cont.disabled = false;
      if (ab) ab.disabled = false;
    }
    searchPanelRefreshStats();
  }
}

/* ---------- 1s 轮询（§2.4 方案 A：打开起、关闭/终态停） ---------- */
function searchPanelStartPolling() {
  if (searchPollTimer || typeof setInterval === 'undefined') return;
  searchPollTimer = setInterval(searchPanelPollOnce, SP_POLL_INTERVAL_MS);
}
function searchPanelStopPolling() {
  if (searchPollTimer && typeof clearInterval !== 'undefined') {
    clearInterval(searchPollTimer);
  }
  searchPollTimer = null;
}
async function searchPanelPollOnce() {
  let d = null;
  try {
    const raw = await spCallApi('search_status', [], SP_STATUS_TIMEOUT_MS);
    d = JSON.parse(raw || '{}');
  } catch (e) {
    return;   // 轮询快失败不打扰（下一拍再试；后端继续跑不依赖轮询）
  }
  if (!d || !d.ok) return;
  // 终态快照（active=false 且 phase done/failed）只在 pending 期驱动 UI：
  // 否则上一轮搜索的 done 会覆盖新面板的就绪/成功态（相位 pill/进度条回退）
  if (d.active === false && (d.phase === 'done' || d.phase === 'failed')) {
    searchPanelStopPolling();
    if (searchPanelState !== 'pending') return;
  }
  if (d.active === false && d.phase !== 'done' && d.phase !== 'failed') {
    searchPanelStopPolling();                       // 无活跃搜索 → 停
    return;
  }
  searchPanelSetPhase(d.phase, d);
  if (d.phase === 'done' || d.phase === 'failed' ||
      (d.active === false && d.phase !== 'captcha')) {
    searchPanelStopPolling();                       // 终态停（captcha 续轮）
  }
}

/* ---------- 渲染 ---------- */
function searchPanelSetState(state) {
  searchPanelState = state;
  const panel = searchPanelEl();
  if (panel) panel.setAttribute('data-state', state);
  const pill = spEl('spPill');
  if (pill) {
    pill.textContent = state === 'pending' ? '进行中'
      : state === 'captcha' ? '需要人工验证'
      : state === 'success' ? '已完成'
      : state === 'error' ? '失败' : '就绪';
    pill.className = 'sp-pill' + (state === 'error' ? ' sp-pill-err'
      : state === 'captcha' ? ' sp-pill-warn'
      : state === 'success' ? ' sp-pill-ok' : '');
  }
}
function searchPanelSetPhase(phase, d) {
  const pill = spEl('spPill');
  if (pill && SP_PHASE_TEXT[phase]) pill.textContent = SP_PHASE_TEXT[phase];
  const bar = spEl('spProgressBar');
  if (bar && typeof d === 'object' && d) {
    if (d.phase === 'deep_extract' && d.deep_extract && d.deep_extract.total) {
      // 确定进度 scaleX(done/total)（§2.3 deep_extract 行）
      bar.style.transform = 'scaleX(' +
        (d.deep_extract.done / d.deep_extract.total) + ')';
    } else if (typeof d.progress_pct === 'number') {
      bar.style.transform = 'scaleX(' + (d.progress_pct / 100) + ')';
    }
  }
  if (d && d.phase === 'captcha' && d.takeover && d.takeover.takeover_id) {
    if (d.takeover.takeover_id !== searchTakeoverId) {
      // 仅 pending 期（搜索在途）接管轮询检出的 captcha：终态（success/error）
      // 后滞留的旧会话 captcha 快照不得复活接管 UI（防僵尸接管框 + 误拦关闭），
      // 面板空开（idle）时同样不挂
      if (searchPanelState === 'pending') {
        searchTakeoverId = d.takeover.takeover_id;
        searchPanelShowTakeover({ takeover_id: searchTakeoverId, retry: d.takeover.retries,
          max_retries: d.takeover.max_retries });
      }
    }
    if (d.takeover.takeover_id === searchTakeoverId) {
      const timer = spEl('spTakeoverTimer');
      if (timer && typeof d.takeover.elapsed_s === 'number') {
        const s = d.takeover.elapsed_s;
        const mm = Math.floor(s / 60), ss = ('0' + (s % 60)).slice(-2);
        timer.textContent = '已等待 ' + mm + ':' + ss;
        // 接管 TTL 到期前 60s 一次性提示（后端 600s 无操作自动放弃；每会话一次）
        if (!spTakeoverWarned && s >= SP_TAKEOVER_TTL_S - SP_TAKEOVER_WARN_LEAD_S) {
          spTakeoverWarned = true;
          spToast('验证即将过期（约 1 分钟后自动放弃），请尽快完成', 'warn');
        }
      }
    }
  }
}
function searchPanelRenderResults(d) {
  const meta = spEl('spMeta');
  if (meta) {
    const cached = d.source === 'cache';
    const secs = d.elapsed_ms != null ? (d.elapsed_ms / 1000).toFixed(1) + 's' : '';
    meta.innerHTML =
      '<span class="sp-src' + (cached ? ' cache' : '') + '" id="spSrcBadge">' +
        (cached ? '缓存' : '实时') + '</span>' +
      '<span class="sp-q">' + spEsc(d.query || '') + '</span>' +
      '<span class="sp-e">' + spEsc(d.engine || '') + '</span>' +
      (d.channel ? '<span class="sp-ch">' + (d.channel === 'urllib' ? '直连抓取' : '窗口') + '</span>' : '') +
      (secs ? '<span class="sp-t">' + secs + '</span>' : '') +
      (d.deep_extract ? '<span class="sp-deep">深度提取 ' + d.deep_extract.done +
        '/' + d.deep_extract.total + (d.deep_extract.failed ? '（' + d.deep_extract.failed + ' 篇失败）' : '') + '</span>' : '') +
      (d.truncated ? '<span class="sp-trunc">结果已截断，全文见 full_ref</span>' : '');
  }
  const box = spEl('spResults');
  if (!box) return;
  box.innerHTML = '';
  const list = d.results || [];
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'sp-empty';
    empty.textContent = '未找到相关内容，建议调整关键词后重试。';
    box.appendChild(empty);
    return;
  }
  list.forEach((r, i) => {
    const item = document.createElement('div');
    item.className = 'sp-item';
    const top = document.createElement('div');
    top.className = 'sp-item-top';
    const pos = document.createElement('span');
    pos.className = 'sp-pos';
    pos.textContent = String(r.position || (i + 1));
    top.appendChild(pos);
    const a = document.createElement('a');
    a.className = 'sp-item-title';
    // scheme 白名单：仅 http/https 可点（防 javascript:/file: 等危险协议）
    a.href = (/^https?:\/\//i.test(String(r.url || ''))) ? r.url : '#';
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = r.title || r.url || '（无标题）';
    a.title = r.title || r.url || '';   // 截断时悬浮全称
    top.appendChild(a);
    item.appendChild(top);
    if (r.snippet) {
      const sn = document.createElement('div');
      sn.className = 'sp-item-snippet';
      sn.textContent = r.snippet;
      item.appendChild(sn);
    }
    if (r.extra && r.extra.content) {
      const ct = document.createElement('div');
      ct.className = 'sp-item-content';
      ct.textContent = r.extra.content.slice(0, 400) +
        (r.extra.content.length > 400 ? '…' : '');
      item.appendChild(ct);
    }
    const foot = document.createElement('div');
    foot.className = 'sp-item-foot';
    const dom = document.createElement('span');
    dom.className = 'sp-item-domain';
    dom.textContent = r.domain || '';
    foot.appendChild(dom);
    if (r.date) {
      const dt = document.createElement('span');
      dt.className = 'sp-item-date';
      dt.textContent = r.date;
      foot.appendChild(dt);
    }
    item.appendChild(foot);
    box.appendChild(item);
  });
}
function searchPanelRenderError(e) {
  const meta = spEl('spMeta');
  if (meta) meta.innerHTML = '<span class="sp-src err">错误</span>';
  const box = spEl('spResults');
  if (!box) return;
  box.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'sp-error';
  d.textContent = (e && e.message) || '搜索失败';
  box.appendChild(d);
  if (e && e.hint) {
    const h = document.createElement('div');
    h.className = 'sp-error-hint';
    h.textContent = e.hint;
    box.appendChild(h);
  }
}
function searchPanelShowTakeover(err) {
  searchPanelSetState('captcha');                    // 入状态机：轮询检出的接管亦不可关闭
  spTakeoverWarned = false;                          // 新接管会话：重置 TTL 预警（每会话一次）
  const box = spEl('spTakeover');
  if (box) box.style.display = '';
  const pill = spEl('spPill');
  if (pill) { pill.textContent = '需要人工验证'; pill.className = 'sp-pill sp-pill-warn'; }
  const cont = spEl('spTakeoverContinue');
  if (cont && err && err.retry) {
    cont.textContent = '继续（重试 ' + err.retry + '/' + (err.max_retries || 3) + '）';
  } else if (cont) {
    cont.textContent = '继续';
  }
}
function searchPanelHideTakeover() {
  searchTakeoverId = null;
  spTakeoverWarned = false;
  // 接管区收起时同步解禁继续/放弃：takeoverAction 在途被新搜索取代时其
  // finally 因 seq 陈旧跳过复位，按钮会永久停在禁用态（下次接管无法点击）——
  // 此处作为唯一收口 choke point 兜底解禁
  const cont = spEl('spTakeoverContinue');
  if (cont) cont.disabled = false;
  const ab = spEl('spTakeoverAbort');
  if (ab) ab.disabled = false;
  const box = spEl('spTakeover');
  if (box) box.style.display = 'none';
  const timer = spEl('spTakeoverTimer');
  if (timer) timer.textContent = '已等待 0:00';
  // 防御性状态复位：captcha 态滞留（searchTakeoverId 已清）会让 Esc/点外关闭
  // 被 state==='captcha' 拦截 → 面板关不掉。调用方随后会置自己的终态，
  // 此处仅保证「无接管会话就无 captcha 态」的不变式
  if (searchPanelState === 'captcha') searchPanelSetState('idle');
}
async function searchPanelRefreshStats() {
  const foot = spEl('spFoot');
  if (!foot) return;
  const seq = ++spStatsSeq;                          // last-wins：旧统计静默丢弃
  try {
    const raw = await spCallApi('search_cache_stats', [], SP_STATS_TIMEOUT_MS);
    if (seq !== spStatsSeq) return;
    const d = JSON.parse(raw || '{}');
    if (d && d.ok) {
      foot.textContent = '缓存 ' + d.entries + ' 条 · 命中 ' + d.hits +
        ' / 未命中 ' + d.misses + ' · ' + d.size_kb + 'KB · TTL ' + d.ttl_minutes + ' 分钟';
    }
  } catch (e) { /* 脚注统计失败静默（不打扰主流程） */ }
}
function spEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
