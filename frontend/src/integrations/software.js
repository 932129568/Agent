/* ================= 外部软件面板（v1.8.0 S 域，实现 v1.8.0 S2） =================
 * #softwareBlock + .sw-*（纯新增 DOM，UI 契约只增不改——check_contract 验）：
 * 设置面板「外部软件」区块：探测列表 / 状态灯 / 测试调用 / 自定义向导。
 * 契约口径（联调规范 §2/§3.2 + ux-flows 流程 4）：
 * - 三态状态机 idle/pending/success/error + 请求序号 last-wins
 *   （softwareReqSeq，同 36-connect connectIdentifySeq 先例；pending 期间
 *   新触发 → seq+1 覆盖，旧请求返回后 seq!==softwareReqSeq 静默丢弃）；
 * - 状态灯映射（.sw-light）：probed→installed（绿）/ missing→missing（空芯）/
 *   version_mismatch→mismatch（黄）/ unknown→probing 呼吸态；
 * - ≥3s 可见等待：software_probe 在途按钮 pending + 文案「探测中…」；
 *   CLI 测试调用不确定扫光 + 「已运行 0:42」每秒文本时钟（motion-spec §2.1）；
 * - 测试调用（Gap-4）：source=manual_test 视为用户本人操作，不走 Agent guard
 *   确认链但照常审计；
 * - 自定义向导：用户条目 CRUD 经 rpc 通用分发通道（_software_save）——
 *   契约 js_api 方法面恰为 software×3（规范 §1.2），不新增 _V12_EXTRA；
 * - typeof 守卫（§2.5 vm 沙箱可测）：模块顶层不直接引用 window/document/
 *   localStorage；callApi 统一经 swCallApi 四步（入口守卫 → 序号登记 →
 *   竞速调用 → 序号校验）。
 * 挂载：110-boot.js loadAll 内 try{ softwarePanelInit(); }catch（功能分级
 * 开关「外部软件」默认开——swFeatureEnabled，localStorage 持久化）。
 */
const SW_LIST_TIMEOUT_MS = 15000;      // software_list（§2.1 表）
const SW_PROBE_TIMEOUT_MS = 120000;    // software_probe（PATH/winreg 全量扫描）
const SW_CALL_TIMEOUT_MS = 660000;     // software_call（后端 600s + 30s 缓冲同款）
const SW_STATUS_POLL_MS = 1000;        // 测试调用文本时钟节拍（不走 count-up 动画）
const SW_FEATURE_KEY = 'glm_feat_software_v18';
// 状态灯 → CSS 类（.sw-light 修饰；unknown 的 probing 呼吸态由探测在途渲染）
const SW_LIGHT_CLASS = {
  probed: 'ok', missing: 'miss', version_mismatch: 'warn', unknown: 'probing'
};
const SW_STATUS_TEXT = {
  probed: '已安装', missing: '未安装', version_mismatch: '版本不符', unknown: '未探测'
};

let softwareReqSeq = 0;          // last-wins 请求序号
let swTestSeq = 0;               // 测试调用独立 last-wins（与列表/探测/保存流隔离）
let softwarePanelState = 'idle'; // idle|pending|success|error
let swProbing = false;           // 探测在途（呼吸态 + 按钮禁用）
let swTesting = false;           // 测试调用在途（防定时器覆盖/状态机串话）
let swCallTimer = null;          // 测试调用文本时钟句柄
let swCallElapsed = 0;           // 测试调用已运行秒数
let swLastList = [];             // 最近一次列表载荷（重渲染用）

/* ---------- typeof 守卫取值（§2.5：vm 沙箱无 DOM 不炸） ---------- */
function swEl(id) {
  return (typeof document !== 'undefined') ? document.getElementById(id) : null;
}
function swFeatureEnabled() {
  try {
    if (typeof localStorage === 'undefined') return true;
    const v = localStorage.getItem(SW_FEATURE_KEY);
    return v === null || v === '1';   // 缺省 = 开（默认开）
  } catch (e) { return true; }
}
function swCallApi(name, args, timeoutMs) {
  // §2.1 四步之①入口守卫（与 callApi 既有口径一致，vm 下显式抛可断言）
  if (typeof callApi !== 'function') {
    throw new Error('pywebview bridge 未就绪: ' + name);
  }
  return callApi(name, args, timeoutMs);
}
function swToast(msg, kind) {
  if (typeof toast === 'function') toast(msg, kind || 'info');
}
function swEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------- 面板骨架（纯新增 DOM；挂到设置面板 set-grid，sandboxBlock 同款模式） ---------- */
function softwarePanelInit() {
  if (!swFeatureEnabled()) return false;          // 功能分级开关：关则不挂载
  if (swEl('softwareBlock')) { softwarePanelWire(); return true; }   // 幂等
  if (typeof document === 'undefined') return false;
  const grid = document.querySelector('.set-grid');
  if (!grid) return false;
  const block = document.createElement('div');
  block.id = 'softwareBlock';
  block.className = 'set-block';
  block.setAttribute('data-group', '工具与软件');
  block.innerHTML =
    '<div class="set-title">外部软件（v1.8.0）</div>' +
    '<div class="set-hint" style="margin:2px 0 8px;">' +
      '让 AI 调用本机已安装的外部软件（git/ffmpeg/7z/python/node 等预设）。' +
      '调用经沙箱执行、参数按调用规范硬校验（不符时 AI 自我修正），全程留审计；' +
      '高危动作（dangerous）每次都要你确认。Harbor 不会自动下载任何软件。<br>' +
      '配置存于 <code>~/.glm-chat/software.json</code>（独立文件，不碰 config.json）。' +
    '</div>' +
    '<div class="provider-row" style="align-items:center;gap:8px;">' +
      '<button type="button" class="modal-btn" id="swProbeBtn">↻ 重新探测</button>' +
      '<button type="button" class="modal-btn" id="swCustomBtn">＋ 自定义软件</button>' +
      '<span class="sw-light" id="swPanelLight"></span>' +
      '<span id="swPanelText" style="font-size:12px;color:var(--text-2);"><span class="load-dot"></span>读取中…</span>' +
    '</div>' +
    '<div class="sw-list" id="swList"></div>' +
    '<div class="sw-wizard" id="swWizard" style="display:none;margin-top:10px;">' +
      '<div class="set-title" style="font-size:13px;">自定义软件</div>' +
      '<div class="provider-row"><span style="width:110px;font-size:12px;color:var(--text-2);">名称</span>' +
        '<input class="sw-input" id="swWName" placeholder="小写字母数字，如 mytool" maxlength="64" style="flex:1;"></div>' +
      '<div class="provider-row"><span style="width:110px;font-size:12px;color:var(--text-2);">类型</span>' +
        '<select id="swWKind" style="flex:1;">' +
          '<option value="cli">cli（命令行）</option>' +
          '<option value="gui">gui（图形界面）</option>' +
          '<option value="uri">uri（协议启动）</option>' +
        '</select></div>' +
      '<div class="provider-row"><span style="width:110px;font-size:12px;color:var(--text-2);">可执行/协议</span>' +
        '<input class="sw-input" id="swWExec" placeholder="cli/gui: 命令名或路径；uri: 如 https://{host}" maxlength="300" style="flex:1;"></div>' +
      '<div class="provider-row"><span style="width:110px;font-size:12px;color:var(--text-2);">动作（JSON）</span>' +
        '<textarea class="sw-input" id="swWActions" rows="4" style="flex:1;" placeholder=\'[{"name":"version","risk":"read","argv":["--version"],"arg_schema":{"type":"object","properties":{}}}]\'></textarea></div>' +
      '<div class="provider-row">' +
        '<button type="button" class="modal-btn primary" id="swWSaveBtn">保存</button>' +
        '<button type="button" class="modal-btn" id="swWCancelBtn">取消</button>' +
      '</div>' +
    '</div>' +
    '<div class="sw-detail" id="swDetail"></div>';
  grid.appendChild(block);
  softwarePanelWire();
  return true;
}
function softwarePanelWire() {
  const probe = swEl('swProbeBtn');
  if (probe) probe.addEventListener('click', () => softwarePanelProbe());
  const custom = swEl('swCustomBtn');
  if (custom) custom.addEventListener('click', () => {
    const w = swEl('swWizard');
    if (w) w.style.display = (w.style.display === 'none' ? '' : 'none');
  });
  const cancel = swEl('swWCancelBtn');
  if (cancel) cancel.addEventListener('click', () => {
    const w = swEl('swWizard');
    if (w) w.style.display = 'none';
  });
  const save = swEl('swWSaveBtn');
  if (save) save.addEventListener('click', () => softwarePanelSaveCustom());
  softwarePanelRefresh();
}

/* ---------- 三态 + last-wins：列表刷新 ---------- */
async function softwarePanelRefresh() {
  const seq = ++softwareReqSeq;
  try {
    const raw = await swCallApi('software_list', ['all'], SW_LIST_TIMEOUT_MS);
    if (seq !== softwareReqSeq) return;               // ④last-wins
    const d = JSON.parse(raw || '{}');
    if (d && d.ok) {
      swLastList = d.software || [];
      softwarePanelRenderList(swLastList);
      softwarePanelSetState('success');
    } else {
      softwarePanelRenderError((d && d.error) || { code: 'INTERNAL', message: '读取软件列表失败' });
      softwarePanelSetState('error');
    }
  } catch (e) {
    if (seq !== softwareReqSeq) return;
    softwarePanelRenderError({ code: 'BRIDGE_TIMEOUT', message: (e && e.message) || String(e) });
    softwarePanelSetState('error');
  }
}

/* ---------- 探测（≥3s 可见等待：按钮 pending + 呼吸态 + 文案） ---------- */
async function softwarePanelProbe() {
  if (swProbing) return;
  const seq = ++softwareReqSeq;
  swProbing = true;
  const btn = swEl('swProbeBtn');
  if (btn) { btn.disabled = true; btn.textContent = '探测中…'; }
  const light = swEl('swPanelLight');
  if (light) light.className = 'sw-light probing';
  const txt = swEl('swPanelText');
  if (txt) txt.textContent = '正在扫描 PATH 与注册表…';
  softwarePanelSetState('pending');
  try {
    const raw = await swCallApi('software_probe', [], SW_PROBE_TIMEOUT_MS);
    if (seq !== softwareReqSeq) return;
    const d = JSON.parse(raw || '{}');
    if (d && d.ok) {
      const nOk = (d.probed || []).filter(p => p.status === 'probed').length;
      swToast('探测完成（' + (d.elapsed_ms || 0) + 'ms）：' + nOk + ' 项已安装', 'ok');
      await softwarePanelRefresh();
    } else {
      softwarePanelRenderError((d && d.error) || { code: 'INTERNAL', message: '探测失败' });
      softwarePanelSetState('error');
    }
  } catch (e) {
    if (seq !== softwareReqSeq) return;
    softwarePanelRenderError({ code: 'BRIDGE_TIMEOUT', message: (e && e.message) || String(e) });
    softwarePanelSetState('error');
  } finally {
    swProbing = false;
    if (btn) { btn.disabled = false; btn.textContent = '↻ 重新探测'; }
    const light2 = swEl('swPanelLight');
    if (light2) light2.className = 'sw-light';
    const txt2 = swEl('swPanelText');
    if (txt2) txt2.textContent = '共 ' + swLastList.length + ' 项';
  }
}

/* ---------- 渲染 ---------- */
function softwarePanelSetState(state) {
  softwarePanelState = state;
  const block = swEl('softwareBlock');
  if (block) block.setAttribute('data-state', state);
}
function softwarePanelRenderList(items) {
  const box = swEl('swList');
  const txt = swEl('swPanelText');
  if (txt) txt.textContent = '共 ' + items.length + ' 项';
  if (!box) return;
  box.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'sw-empty';
    empty.textContent = '注册表为空（内置预设应始终存在——异常）。';
    box.appendChild(empty);
    return;
  }
  items.forEach(it => {
    const row = document.createElement('div');
    row.className = 'sw-row';
    row.setAttribute('data-name', it.name);
    const lightCls = SW_LIGHT_CLASS[it.status] || 'probing';
    row.innerHTML =
      '<span class="sw-light ' + lightCls + '"></span>' +
      '<span class="sw-name">' + swEsc(it.name) + '</span>' +
      '<span class="sw-kind">' + swEsc(it.kind) + '</span>' +
      '<span class="sw-status">' + (SW_STATUS_TEXT[it.status] || swEsc(String(it.status || '未知'))) +
        (it.version ? ' · ' + swEsc(it.version) : '') + '</span>' +
      '<span class="sw-src">' + (it.source === 'preset' ? '预设' : '自定义') + '</span>' +
      '<button type="button" class="modal-btn sw-test-btn" data-name="' + swEsc(it.name) + '">测试调用</button>' +
      (it.source === 'custom'
        ? '<button type="button" class="modal-btn sw-del-btn" data-name="' + swEsc(it.name) + '" title="删除自定义软件条目">删除</button>'
        : '');
    box.appendChild(row);
  });
  box.querySelectorAll('.sw-test-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.getAttribute('data-name');
      const item = (swLastList || []).find(x => x.name === name);
      softwarePanelOpenTest(name, item);
    });
  });
  // 2026-10-21 补：自定义软件删除入口（后端 _software_remove 现成，经 rpc 暴露；预设不可删）
  box.querySelectorAll('.sw-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.getAttribute('data-name');
      const r = await uiConfirm({ title: '删除自定义软件',
        body: '确定删除自定义条目「' + name + '」？不影响已安装的本体程序。',
        danger: true, okText: '删除' });
      if (!r || !r.ok) return;
      try {
        const raw = await swCallApi('rpc', ['_software_remove', JSON.stringify({ name: name })], SW_LIST_TIMEOUT_MS);
        const d = JSON.parse(raw || '{}');
        if (d && d.ok) { if (typeof toast === 'function') toast('已删除 ' + name, 'ok'); softwarePanelRefresh(); }
        else if (typeof toast === 'function') toast((d && d.error) || '删除失败', 'err');
      } catch (e) {
        if (typeof toast === 'function') toast('删除失败：' + (e.message || e), 'err');
      }
    });
  });
}
function softwarePanelRenderError(e) {
  // 在途保护：测试调用进行中 #swDetail 正展示测试 UI（动作选择/输出 pre），
  // 列表/探测的失败若整块覆写 swDetail，测试完成后的输出将无处渲染
  // （swTestOut 被销毁 → renderTestOut 早退）——用户看不到已执行的调用结果，
  // 可能重复触发（重复执行）。改走 toast，不碰测试区。
  if (swTesting) {
    swToast('操作失败：' + ((e && e.message) || '未知错误'), 'err');
    return;
  }
  const box = swEl('swDetail');
  if (!box) return;
  box.innerHTML =
    '<div class="sw-error">' + swEsc((e && e.message) || '操作失败') + '</div>' +
    (e && e.hint ? '<div class="sw-error-hint">' + swEsc(e.hint) + '</div>' : '');
}

/* ---------- 测试调用（Gap-4：manual_test 不走 Agent guard 链，照常审计） ---------- */
function softwarePanelOpenTest(name, item) {
  const box = swEl('swDetail');
  if (!box) return;
  const actions = (item && item.actions) || [];
  if (!actions.length) {
    box.innerHTML = '<div class="sw-error">' + swEsc(name) + ' 没有可用动作。</div>';
    return;
  }
  const opts = actions.map(a =>
    '<option value="' + swEsc(a.name) + '">' + swEsc(a.name) +
    '（' + swEsc(a.risk) + '）</option>').join('');
  box.innerHTML =
    '<div class="sw-test">' +
      '<div class="provider-row" style="align-items:center;gap:8px;">' +
        '<span style="font-size:12px;color:var(--text-2);">' + swEsc(name) + ' 动作</span>' +
        '<select id="swTestAction" style="flex:1;">' + opts + '</select>' +
      '</div>' +
      '<div class="provider-row" style="align-items:flex-start;gap:8px;">' +
        '<span style="font-size:12px;color:var(--text-2);width:110px;">参数（JSON）</span>' +
        '<textarea class="sw-input" id="swTestArgs" rows="3" style="flex:1;" placeholder=\'{}\'></textarea>' +
      '</div>' +
      '<div class="provider-row">' +
        '<button type="button" class="modal-btn primary" id="swTestRun">执行</button>' +
        '<span class="sw-light" id="swTestLight"></span>' +
        '<span class="sw-test-timer" id="swTestTimer" style="display:none;"></span>' +
      '</div>' +
      '<pre class="sw-test-out" id="swTestOut" style="display:none;"></pre>' +
    '</div>';
  const run = swEl('swTestRun');
  if (run) run.addEventListener('click', () => softwarePanelRunTest(name));
}
async function softwarePanelRunTest(name) {
  if (swTesting) return;                         // 在途保护：防连点致定时器覆盖/状态串话
  swTesting = true;
  const actionEl = swEl('swTestAction');
  const argsEl = swEl('swTestArgs');
  const action = actionEl ? actionEl.value : '';
  let args = {};
  if (argsEl && argsEl.value.trim()) {
    try { args = JSON.parse(argsEl.value); }
    catch (e) {
      softwarePanelRenderTestOut({ ok: false, error: { code: 'BAD_PARAMS',
        message: '参数不是合法 JSON: ' + (e && e.message) } });
      swTesting = false;                     // 早退亦复位在途标志（防永久锁死）
      return;
    }
  }
  // 测试调用用独立序号：列表刷新/探测/保存与测试流并发时（探测约秒级返回，
  // 测试调用可跑数百秒），旧实现共用 softwareReqSeq → 探测完成即使在途测试
  // 的返回被判陈旧而静默丢弃——调用已真实执行（有副作用）却无任何输出渲染，
  // 用户重复点击即重复执行。独立序号后测试流只被更新的测试流淘汰。
  // 复核修正（真机实证）：手动「执行」与 AI 同走护栏链——armed 态无 token
  // 即 CONFIRM_REQUIRED。origin='user'：用户即确认主体。
  let swGuardToken = null;
  if (typeof agentGuardCheck === 'function') {
    const g = await agentGuardCheck('software_call', {
      software: String(name || ''),
      action: String(action || ''),
      args: args,
      force_always: args && args.__dangerous === true,
    }, 'user');
    if (g.blocked) {
      let b = {};
      try { b = JSON.parse(g.blocked); } catch (e2) {}
      softwarePanelRenderTestOut({ ok: false, error: { code: 'USER_DENIED',
        message: (b && (b.info || b.error)) || '用户取消了本次调用' } });
      return;                                    // swTesting 未置位（护栏在途前）
    }
    swGuardToken = g.token;
  }
  const seq = ++swTestSeq;
  const runBtn = swEl('swTestRun');
  if (runBtn) runBtn.disabled = true;
  swCallElapsed = 0;
  const timerEl = swEl('swTestTimer');
  if (timerEl) { timerEl.style.display = ''; timerEl.textContent = '已运行 0:00'; }
  if (swCallTimer) { clearInterval(swCallTimer); swCallTimer = null; }   // 旧时钟先清（防泄漏）
  swCallTimer = setInterval(() => {
    swCallElapsed += 1;
    const t = swEl('swTestTimer');
    if (t) {
      const mm = Math.floor(swCallElapsed / 60), ss = ('0' + (swCallElapsed % 60)).slice(-2);
      t.textContent = '已运行 ' + mm + ':' + ss;
    }
  }, SW_STATUS_POLL_MS);
  softwarePanelSetState('pending');
  try {
    const raw = await swCallApi('software_call',
      [{ software: name, action: action, args: args, source: 'manual_test' },
       swGuardToken],
      SW_CALL_TIMEOUT_MS);
    if (seq !== swTestSeq) return;               // 连点 last-wins：旧返回丢弃
    const d = JSON.parse(raw || '{}');
    softwarePanelRenderTestOut(d);
    softwarePanelSetState(d && d.ok ? 'success' : 'error');
  } catch (e) {
    if (seq !== swTestSeq) return;
    softwarePanelRenderTestOut({ ok: false, error: { code: 'BRIDGE_TIMEOUT',
      message: (e && e.message) || String(e) } });
    softwarePanelSetState('error');
  } finally {
    // 早退（seq 陈旧 return）亦经 finally：时钟清理 + 在途标志复位（JS 语义保证）
    if (swCallTimer) { clearInterval(swCallTimer); swCallTimer = null; }
    swCallElapsed = 0;                           // 时钟归零：防陈旧秒数泄漏到下次显示
    if (runBtn) runBtn.disabled = false;
    swTesting = false;
  }
}
function softwarePanelRenderTestOut(d) {
  const out = swEl('swTestOut');
  const light = swEl('swTestLight');
  if (!out) return;
  out.style.display = '';
  if (light) light.className = 'sw-light ' + (d && d.ok ? 'ok' : 'miss');
  if (d && d.ok && d.kind === 'cli') {
    // CLI 形态：exit chip + stdout/stderr + 计时 + 沙箱标记（exit_code≠0 仍成功形状）
    const okExit = d.exit_code === 0;
    out.innerHTML =
      '<div class="sw-exit ' + (okExit ? 'ok' : 'warn') + '">exit_code: ' +
        swEsc(d.exit_code) + (okExit ? '' : '（非零仍返回原始输出，AI 可自行判断）') +
        '</div>' +
      '<div class="sw-meta-line">耗时 ' + swEsc(d.duration_ms) + 'ms · 沙箱 ' +
        (d.sandboxed ? '是' : '否') + (d.truncated ? ' · 输出已截断（full_ref 可用 read_more 续读）' : '') + '</div>' +
      (d.error_hint ? '<div class="sw-hint">提示：' + swEsc(d.error_hint) + '</div>' : '') +
      (d.stdout ? '<pre class="sw-stdout">' + swEsc(d.stdout) + '</pre>' : '') +
      (d.stderr ? '<pre class="sw-stderr">' + swEsc(d.stderr) + '</pre>' : '');
    return;
  }
  if (d && d.ok && d.kind === 'gui') {
    out.innerHTML =
      '<div class="sw-exit ok">已启动 · 窗口已确认</div>' +
      '<div class="sw-meta-line">窗口标题：' + swEsc(d.window_title || '（未取到）') +
        ' · 耗时 ' + swEsc(d.duration_ms) + 'ms</div>' +
      '<div class="sw-hint">GUI 启动不可逆——执行前才可停止。</div>';
    return;
  }
  if (d && d.ok && d.kind === 'uri') {
    out.innerHTML =
      '<div class="sw-exit ok">协议已启动</div>' +
      '<div class="sw-meta-line">protocol: ' + swEsc(d.protocol) +
        (d.uri ? ' · ' + swEsc(d.uri) : '') + '</div>';
    return;
  }
  const e = (d && d.error) || { code: 'INTERNAL', message: '调用失败' };
  out.innerHTML =
    '<div class="sw-error">[' + swEsc(e.code) + '] ' + swEsc(e.message || '') + '</div>' +
    (e.hint ? '<div class="sw-error-hint">' + swEsc(e.hint) + '</div>' : '') +
    (e.violations ? '<div class="sw-hint">参数 violations（Agent 自校正依据）：</div>' +
      '<pre class="sw-stderr">' +
      swEsc(JSON.stringify(e.violations, null, 2)) + '</pre>' : '') +
    (e.example ? '<div class="sw-hint">正确示例：<code>' +
      swEsc(JSON.stringify(e.example)) + '</code></div>' : '');
}

/* ---------- 自定义向导保存（rpc 通用通道：_software_save，非 js_api 契约方法） ---------- */
async function softwarePanelSaveCustom() {
  const nameEl = swEl('swWName');
  const kindEl = swEl('swWKind');
  const execEl = swEl('swWExec');
  const actEl = swEl('swWActions');
  const name = nameEl ? String(nameEl.value || '').trim() : '';
  const kind = kindEl ? kindEl.value : 'cli';
  const exec = execEl ? String(execEl.value || '').trim() : '';
  let actions = [];
  if (actEl && actEl.value.trim()) {
    try { actions = JSON.parse(actEl.value); }
    catch (e) {
      swToast('动作 JSON 解析失败: ' + ((e && e.message) || e), 'err');
      return;
    }
  }
  if (!name) { swToast('请填写软件名称', 'warn'); return; }
  const entry = { kind: kind, exec: exec, uri_template: kind === 'uri' ? exec : '',
                  actions: actions, risk_default: 'read' };
  const seq = ++softwareReqSeq;
  try {
    const raw = await swCallApi('rpc', ['_software_save', JSON.stringify({ name: name, entry: entry })], SW_LIST_TIMEOUT_MS);
    if (seq !== softwareReqSeq) return;
    const d = JSON.parse(raw || '{}');
    if (d && d.ok) {
      swToast('已保存自定义软件「' + name + '」', 'ok');
      const w = swEl('swWizard');
      if (w) w.style.display = 'none';
      await softwarePanelRefresh();
    } else {
      swToast('保存失败: ' + ((d && d.error) || '未知错误'), 'err');
    }
  } catch (e) {
    if (seq !== softwareReqSeq) return;
    swToast('保存失败: ' + ((e && e.message) || String(e)), 'err');
  }
}
