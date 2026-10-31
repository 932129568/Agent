/* ================= 任务授权与白名单（v1.8.5 A 域，R5 裁决提前插；实现 v1.8.5 A2） =================
 * #grantIndicator（会话头部授权指示灯/倒计时）+ #grantRulesBlock（设置区
 * 白名单管理）+ .gg-*（纯新增 DOM，UI 契约只增不改——check_contract 验）。
 * 契约口径（联调规范 §2/§3.4 + §5.5 + §7 R6 裁决）：
 * - 授权指示灯/倒计时：remaining_s 校准源含 idle（idle_deadline = 最后
 *   grant 内操作 + 1800s；TTL 与空闲先到者生效）；本地每 1s 递减，每 30s
 *   重新 guard_task_status 校准一次（防本地时钟漂移）；剩余 <600s 黄牌 +
 *   expiring_soon + 「重新授权」入口；收回/到期两终态渲染；
 * - 授权确认（guard_task_grant）：TTL 选择 30min/2h/4h（默认 2h）+ scope
 *   勾选（workspace_write/exec/app_launch）；
 * - grant 不是免检：deny 清单先于 grant 生效（后端判定链
 *   deny → allow_rules → task_grant → op 档 → 弹窗）；授权内操作不逐条
 *   toast（后端审计 decision=grant）；
 * - 白名单管理（guard_rule_list/add/remove）：规则列表/添加表单/删除/
 *   hits 显示；deny 清单覆盖的规则创建即拒（GUARD_DENIED 人话）；detail
 *   含写动词 → warn 黄条（不阻断）；
 * - 三态状态机 + 请求序号 last-wins（grantReqSeq，同 36-connect 先例）；
 * - typeof 守卫（§2.5 vm 沙箱可测）：模块顶层不直接引用 window/document/
 *   localStorage；callApi 统一经 ggCallApi 四步。
 * 挂载：110-boot.js loadAll 内 try{ guardGrantInit(); }catch。
 */
const GG_STATUS_TIMEOUT_MS = 15000;   // guard_task_* / guard_rule_*（§2.1 表）
const GG_CALIBRATE_MS = 30000;        // 倒计时 30s 校准拉取一次（§3.4 字段语义表）
const GG_COUNTDOWN_MS = 1000;         // 本地 1s 递减节拍
const GG_EXPIRING_SOON_S = 600;       // 剩余 <600s 黄牌（§8.3 expiring_soon）
const GG_TTL_OPTIONS = [
  { v: 1800, label: '30 分钟' },
  { v: 7200, label: '2 小时（默认）' },
  { v: 14400, label: '4 小时' }
];
const GG_SCOPES = [
  { v: 'workspace_write', label: '工作区写入（删除/移动等）' },
  { v: 'exec', label: '命令执行（cmd/PowerShell/管理员）' },
  { v: 'app_launch', label: '打开应用/链接' }
];

let grantReqSeq = 0;           // last-wins 请求序号（用户操作：创建/加规则/收回）
let ggStatusSeq = 0;           // 状态轮询独立序号（复核修正：原与用户操作共享
                               // grantReqSeq，30s 校准 bump 序号会静默丢弃在途
                               // 用户操作响应——成功分支被跳过时定时器不启动）
let ggFailStreak = 0;          // 状态查询连续失败计数（≥5 停轮询，防 RPC 风暴）
let ggState = 'idle';          // idle|pending|success|error
let ggCountdownTimer = null;   // 本地 1s 递减句柄
let ggCalibrateTimer = null;   // 30s 校准句柄
let ggRemaining = 0;           // 本地递减剩余秒（校准源：guard_task_status）
let ggTtlTotal = 0;            // 授权总时长秒（倒计时环比例分母；校准源同）
let ggActive = false;          // 授权活跃态
let ggExpiringSoon = false;    // 剩余 <600s 黄牌
let ggGrantId = null;
let ggRules = [];              // 最近一次规则列表

/* ---------- typeof 守卫取值（§2.5） ---------- */
function ggEl(id) {
  return (typeof document !== 'undefined') ? document.getElementById(id) : null;
}
function ggCallApi(name, args, timeoutMs) {
  if (typeof callApi !== 'function') {
    throw new Error('pywebview bridge 未就绪: ' + name);
  }
  return callApi(name, args, timeoutMs);
}
function ggToast(msg, kind) {
  if (typeof toast === 'function') toast(msg, kind || 'info');
}
function ggEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function ggFmtRemain(s) {
  const n = Math.max(0, parseInt(s || 0, 10) || 0);
  const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60),
    ss = ('0' + (n % 60)).slice(-2);
  return (h > 0 ? h + ':' + ('0' + m).slice(-2) : m) + ':' + ss;
}

/* ---------- 挂载（#grantIndicator 会话头部 + #grantRulesBlock 设置区） ---------- */
function guardGrantInit() {
  if (typeof document === 'undefined') return false;
  if (!ggEl('grantIndicator')) {
    const right = document.querySelector('.header-right');
    if (right) {
      const ind = document.createElement('span');
      ind.id = 'grantIndicator';
      ind.className = 'gg-ind';
      ind.style.display = 'none';
      ind.innerHTML =
        '<span class="gg-light" id="ggLight"></span>' +
        '<svg class="gg-ring" id="ggRing" viewBox="0 0 16 16" aria-hidden="true">' +
        '<circle class="bg" cx="8" cy="8" r="7"/><circle class="fg" id="ggRingFg" cx="8" cy="8" r="7"/></svg>' +
        '<span class="gg-timer" id="ggTimer">--:--</span>' +
        '<button type="button" class="modal-btn gg-btn" id="ggRenewBtn" style="display:none;">重新授权</button>' +
        '<button type="button" class="modal-btn gg-btn" id="ggRevokeBtn">收回</button>';
      right.appendChild(ind);
    }
  }
  if (!ggEl('grantRulesBlock')) {
    const grid = document.querySelector('.set-grid');
    if (grid) {
      const block = document.createElement('div');
      block.id = 'grantRulesBlock';
      block.className = 'set-block';
      block.setAttribute('data-group', '安全与授权');
      block.innerHTML =
        '<div class="set-title">任务授权与白名单（v1.8.5）</div>' +
        '<div class="set-hint" style="margin:2px 0 8px;">' +
          '任务授权：一次性授予某类操作的会话内放行（默认 2h，空闲 30 分钟自动收回）。' +
          '<b>授权不是免检</b>——保护名单（deny）仍先于授权生效。<br>' +
          '白名单：窄规则优先于松模式；deny 清单覆盖的规则创建即拒。' +
          '授权为进程内状态（不入配置文件），白名单存于 <code>~/.glm-chat/guard.json</code> 的 allow_rules 键。' +
        '</div>' +
        '<div class="gg-grant-form" id="ggGrantForm" style="display:none;">' +
          '<div class="provider-row">' +
            '<span style="width:110px;font-size:12px;color:var(--text-2);">授权时长</span>' +
            '<select id="ggTtl" style="flex:1;">' +
              GG_TTL_OPTIONS.map(o => '<option value="' + o.v + '"' +
                (o.v === 7200 ? ' selected' : '') + '>' + o.label + '</option>').join('') +
            '</select>' +
          '</div>' +
          '<div class="provider-row" style="align-items:flex-start;gap:8px;">' +
            '<span style="width:110px;font-size:12px;color:var(--text-2);">授权范围</span>' +
            '<span style="flex:1;">' +
              GG_SCOPES.map(s => '<label class="check-row" style="display:block;margin-bottom:2px;">' +
                '<input type="checkbox" class="gg-scope" value="' + s.v + '"' +
                (s.v === 'exec' ? ' checked' : '') + '> ' + s.label + '</label>').join('') +
            '</span>' +
          '</div>' +
          '<div class="provider-row">' +
            '<button type="button" class="modal-btn primary" id="ggGrantBtn">确认授权</button>' +
            '<button type="button" class="modal-btn" id="ggGrantCancelBtn">取消</button>' +
          '</div>' +
        '</div>' +
        '<div class="provider-row" style="margin:6px 0;">' +
          '<button type="button" class="modal-btn" id="ggGrantOpenBtn">＋ 新建任务授权</button>' +
        '</div>' +
        '<div class="set-title" style="font-size:13px;margin-top:10px;">白名单规则</div>' +
        '<div class="provider-row" style="align-items:flex-start;gap:8px;">' +
          '<span style="width:110px;font-size:12px;color:var(--text-2);">op 正则</span>' +
          '<input class="gg-input" id="ggRuleOp" placeholder="如 run_command 或 ^git (status|diff)$" maxlength="200" style="flex:1;">' +
        '</div>' +
        '<div class="provider-row" style="align-items:flex-start;gap:8px;">' +
          '<span style="width:110px;font-size:12px;color:var(--text-2);">detail 正则</span>' +
          '<input class="gg-input" id="ggRuleDetail" placeholder="可选，如 ^git (status|diff|log)" maxlength="200" style="flex:1;">' +
        '</div>' +
        '<div class="provider-row">' +
          '<button type="button" class="modal-btn primary" id="ggRuleAddBtn">添加规则</button>' +
          '<span class="gg-rule-warn" id="ggRuleWarn" style="display:none;"></span>' +
        '</div>' +
        '<div class="gg-rules" id="ggRules"></div>';
      grid.appendChild(block);
    }
  }
  // 幂等接线（同 63-search-panel searchPanelWire 先例；重复 addEventListener
  // 由幂等初始化保证只走一次——boot 单次调用）
  guardGrantWire();
  guardGrantRefreshStatus();
  guardGrantRulesRefresh();
  // 修复（建议12）：原此处无条件 guardGrantStartTimers()——ggActive=false（无授权）
  // 时 1s 倒计时定时器 + 30s 校准定时器永久空转（guardGrantTick 虽早退，但每 30s
  // 仍发一次 guard_task_status RPC，进程生命周期内永不停止）。改由
  // guardGrantRefreshStatus 按 active 态启停（grant 创建/校准为 active 时再启）。
  return true;
}
function guardGrantWire() {
  const revoke = ggEl('ggRevokeBtn');
  if (revoke) revoke.addEventListener('click', () => guardGrantRevoke());
  const renew = ggEl('ggRenewBtn');
  if (renew) renew.addEventListener('click', () => {
    const f = ggEl('ggGrantForm');
    if (f) f.style.display = '';
  });
  const open = ggEl('ggGrantOpenBtn');
  if (open) open.addEventListener('click', () => {
    const f = ggEl('ggGrantForm');
    if (f) f.style.display = (f.style.display === 'none' ? '' : 'none');
  });
  const cancel = ggEl('ggGrantCancelBtn');
  if (cancel) cancel.addEventListener('click', () => {
    const f = ggEl('ggGrantForm');
    if (f) f.style.display = 'none';
  });
  const grant = ggEl('ggGrantBtn');
  if (grant) grant.addEventListener('click', () => guardGrantCreate());
  const add = ggEl('ggRuleAddBtn');
  if (add) add.addEventListener('click', () => guardGrantRuleAdd());
}

/* ---------- 倒计时（本地 1s 递减 + 30s status 校准） ----------
 * 修复（建议12）：定时器生命周期绑定 ggActive——无授权时停（校准/倒计时都无意义），
 * guard 创建成功或校准发现 active 时启。guardGrantStartTimers/StopTimers 均幂等。 */
function guardGrantStartTimers() {
  if (ggCountdownTimer || typeof setInterval === 'undefined') return;
  ggCountdownTimer = setInterval(guardGrantTick, GG_COUNTDOWN_MS);
  ggCalibrateTimer = setInterval(() => guardGrantRefreshStatus(true), GG_CALIBRATE_MS);
}
function guardGrantStopTimers() {
  if (ggCountdownTimer && typeof clearInterval !== 'undefined') {
    clearInterval(ggCountdownTimer);
  }
  if (ggCalibrateTimer && typeof clearInterval !== 'undefined') {
    clearInterval(ggCalibrateTimer);
  }
  ggCountdownTimer = null;
  ggCalibrateTimer = null;
}
function guardGrantTick() {
  if (!ggActive) return;
  ggRemaining = Math.max(0, ggRemaining - 1);
  if (ggRemaining <= 0) {
    // 本地递减到 0：以 status 为准（校准或到期终态）
    guardGrantRefreshStatus(true);
    return;
  }
  guardGrantRenderIndicator();
}

/* ---------- 三态 + last-wins：授权状态 ---------- */
async function guardGrantRefreshStatus(calibrate) {
  const seq = ++ggStatusSeq;                     // 独立序号：不与用户操作互踩
  try {
    const raw = await ggCallApi('guard_task_status', [], GG_STATUS_TIMEOUT_MS);
    if (seq !== ggStatusSeq) return;               // ④last-wins
    const d = JSON.parse(raw || '{}');
    if (d && d.ok) {
      ggFailStreak = 0;
      const prevActive = ggActive;
      ggActive = !!d.active;
      ggGrantId = d.grant_id || null;
      ggRemaining = parseInt(d.remaining_s || 0, 10) || 0;
      if (d.ttl_seconds) ggTtlTotal = parseInt(d.ttl_seconds, 10) || ggTtlTotal;
      ggExpiringSoon = !!d.expiring_soon;
      if (prevActive && !ggActive) {
        ggToast('任务授权已到期/收回，后续操作将逐项确认', 'warn');
      }
      // 修复（建议12）：按 active 态启停定时器——无授权（idle/到期/收回）时停掉
      // 1s 倒计时 + 30s 校准，不再永久空转；active 时确保在跑（校准可能来自
      // 外部授予路径）。
      if (ggActive) guardGrantStartTimers(); else guardGrantStopTimers();
      guardGrantRenderIndicator();
      ggState = 'success';
    } else {
      ggState = 'error';
      // 复核修正：连续失败 ≥5 次停轮询——原每秒/每 30s 无限重试，桥持续
      // 异常时形成固定频率 RPC 风暴直至桥恢复
      if (++ggFailStreak >= 5) {
        guardGrantStopTimers();
        ggToast('授权状态查询连续失败，已暂停轮询（重开面板或操作后恢复）', 'warn');
      }
    }
  } catch (e) {
    if (seq !== ggStatusSeq) return;
    ggState = 'error';
    if (++ggFailStreak >= 5) guardGrantStopTimers();
  }
}
function guardGrantRenderIndicator() {
  const ind = ggEl('grantIndicator');
  if (!ind) return;
  if (!ggActive) {
    ind.style.display = ggState === 'error' ? 'none' : '';
    // 无授权：常驻浅提示（可新建），灯灰
    const light = ggEl('ggLight');
    if (light) light.className = 'gg-light off';
    const timer = ggEl('ggTimer');
    if (timer) timer.textContent = '无任务授权';
    const renew = ggEl('ggRenewBtn');
    if (renew) renew.style.display = 'none';
    const revoke = ggEl('ggRevokeBtn');
    if (revoke) revoke.style.display = 'none';
    ind.title = '当前没有任务授权：危险操作将逐项确认。可点击「新建任务授权」。';
    return;
  }
  ind.style.display = '';
  const light = ggEl('ggLight');
  if (light) light.className = 'gg-light ' + (ggExpiringSoon ? 'warn' : 'ok');
  const ring = ggEl('ggRing');
  if (ring) ring.classList.toggle('warn', !!ggExpiringSoon);
  const timer = ggEl('ggTimer');
  if (timer) {
    timer.textContent = '授权剩余 ' + ggFmtRemain(ggRemaining);
    timer.className = 'gg-timer' + (ggExpiringSoon ? ' expiring' : '');
  }
  // 倒计时环：stroke-dashoffset 每秒一跳（时钟语义，登记的白名单例外属性）
  const fg = ggEl('ggRingFg');
  if (fg) {
    const ttl = Math.max(1, ggTtlTotal || ggRemaining || 7200);
    const p = Math.max(0, Math.min(1, (ggRemaining || 0) / ttl));
    fg.style.strokeDashoffset = String(44 * (1 - p));
  }
  const renew = ggEl('ggRenewBtn');
  if (renew) renew.style.display = ggExpiringSoon ? '' : 'none';
  const revoke = ggEl('ggRevokeBtn');
  if (revoke) revoke.style.display = '';
  ind.title = '任务授权中（空闲 30 分钟无操作自动收回；保护名单仍优先拦截）';
}

/* ---------- 授权创建 / 收回 ---------- */
async function guardGrantCreate() {
  const ttlEl = ggEl('ggTtl');
  const ttl = ttlEl ? parseInt(ttlEl.value, 10) : 7200;
  const scopes = [];
  if (typeof document !== 'undefined') {
    document.querySelectorAll('.gg-scope').forEach(cb => {
      if (cb.checked) scopes.push(cb.value);
    });
  }
  if (!scopes.length) { ggToast('请至少勾选一个授权范围', 'warn'); return; }
  const seq = ++grantReqSeq;
  try {
    const raw = await ggCallApi('guard_task_grant', [scopes, ttl], GG_STATUS_TIMEOUT_MS);
    if (seq !== grantReqSeq) return;
    const d = JSON.parse(raw || '{}');
    if (d && d.ok) {
      ggToast('已授予任务授权（' + ggFmtRemain(d.remaining_s) + '，空闲 30 分钟自动收回）', 'ok');
      const f = ggEl('ggGrantForm');
      if (f) f.style.display = 'none';
      ggActive = true;
      ggGrantId = d.grant_id || null;
      ggRemaining = parseInt(d.remaining_s || 0, 10) || 0;
      ggExpiringSoon = !!d.expiring_soon;
      guardGrantStartTimers();   // 修复（建议12）：grant 创建成功 → 启动倒计时/校准（此前依赖 init 的一次性启动，revoke 后再 grant 无定时器）
      guardGrantRenderIndicator();
    } else {
      ggToast('授权失败: ' + ((d && d.error) || '未知错误'), 'err');
    }
  } catch (e) {
    if (seq !== grantReqSeq) return;
    ggToast('授权失败: ' + ((e && e.message) || String(e)), 'err');
  }
}
async function guardGrantRevoke() {
  const seq = ++grantReqSeq;
  try {
    const raw = await ggCallApi('guard_task_revoke', [null], GG_STATUS_TIMEOUT_MS);
    if (seq !== grantReqSeq) return;
    const d = JSON.parse(raw || '{}');
    if (d && d.ok) {
      ggToast(d.revoked ? '已收回任务授权' : '当前没有授权', d.revoked ? 'ok' : 'info');
      ggActive = false;
      ggGrantId = null;
      ggRemaining = 0;
      guardGrantStopTimers();   // 修复（建议12）：收回即停定时器（无授权态不再空转/轮询）
      guardGrantRenderIndicator();
    } else {
      ggToast('收回失败: ' + ((d && d.error) || '未知错误'), 'err');
    }
  } catch (e) {
    if (seq !== grantReqSeq) return;
    ggToast('收回失败: ' + ((e && e.message) || String(e)), 'err');
  }
}

/* ---------- 白名单管理 ---------- */
async function guardGrantRulesRefresh() {
  const seq = ++grantReqSeq;
  try {
    const raw = await ggCallApi('guard_rule_list', [], GG_STATUS_TIMEOUT_MS);
    if (seq !== grantReqSeq) return;
    const d = JSON.parse(raw || '{}');
    if (d && d.ok) {
      ggRules = d.rules || [];
      guardGrantRenderRules();
    }
  } catch (e) { /* 规则区刷新失败静默（不打扰主流程） */ }
}
function guardGrantRenderRules() {
  const box = ggEl('ggRules');
  if (!box) return;
  box.innerHTML = '';
  if (!ggRules.length) {
    const empty = document.createElement('div');
    empty.className = 'gg-rules-empty';
    empty.textContent = '暂无白名单规则。确认框第三次出现时也可一键升级为规则。';
    box.appendChild(empty);
    return;
  }
  ggRules.forEach(r => {
    const row = document.createElement('div');
    row.className = 'gg-rule-row';
    row.innerHTML =
      '<code class="gg-rule-op">' + ggEsc(r.op_pattern) + '</code>' +
      (r.detail_pattern ? '<code class="gg-rule-detail">' + ggEsc(r.detail_pattern) + '</code>' : '') +
      '<span class="gg-rule-hits">命中 ' + ggEsc(r.hits || 0) + '</span>' +
      (r.note ? '<span class="gg-rule-note">' + ggEsc(r.note) + '</span>' : '') +
      '<button type="button" class="modal-btn gg-rule-del" data-rid="' + ggEsc(r.rule_id) + '">删除</button>';
    box.appendChild(row);
  });
  box.querySelectorAll('.gg-rule-del').forEach(btn => {
    btn.addEventListener('click', () => guardGrantRuleRemove(btn.getAttribute('data-rid')));
  });
}
async function guardGrantRuleAdd() {
  const opEl = ggEl('ggRuleOp');
  const detailEl = ggEl('ggRuleDetail');
  const op = opEl ? String(opEl.value || '').trim() : '';
  const detail = detailEl ? String(detailEl.value || '').trim() : '';
  if (!op) { ggToast('请填写 op 正则', 'warn'); return; }
  const warnEl = ggEl('ggRuleWarn');
  if (warnEl) warnEl.style.display = 'none';
  const seq = ++grantReqSeq;
  try {
    const raw = await ggCallApi('guard_rule_add', [op, detail || null], GG_STATUS_TIMEOUT_MS);
    if (seq !== grantReqSeq) return;
    const d = JSON.parse(raw || '{}');
    if (d && d.ok) {
      ggToast('规则已添加', 'ok');
      if (opEl) opEl.value = '';
      if (detailEl) detailEl.value = '';
      if (d.warn && warnEl) {
        warnEl.textContent = d.warn;
        warnEl.style.display = '';
      }
      await guardGrantRulesRefresh();
    } else {
      ggToast('添加失败: ' + ((d && d.error) || '未知错误'), 'err');
    }
  } catch (e) {
    if (seq !== grantReqSeq) return;
    ggToast('添加失败: ' + ((e && e.message) || String(e)), 'err');
  }
}
async function guardGrantRuleRemove(ruleId) {
  if (!ruleId) return;
  const seq = ++grantReqSeq;
  try {
    const raw = await ggCallApi('guard_rule_remove', [ruleId], GG_STATUS_TIMEOUT_MS);
    if (seq !== grantReqSeq) return;
    const d = JSON.parse(raw || '{}');
    if (d && d.ok) {
      ggToast(d.removed ? '规则已删除' : '规则不存在（已删除）', d.removed ? 'ok' : 'info');
      await guardGrantRulesRefresh();
    } else {
      ggToast('删除失败: ' + ((d && d.error) || '未知错误'), 'err');
    }
  } catch (e) {
    if (seq !== grantReqSeq) return;
    ggToast('删除失败: ' + ((e && e.message) || String(e)), 'err');
  }
}
