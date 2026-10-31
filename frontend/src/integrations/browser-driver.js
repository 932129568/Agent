/* ================= v1.9.0 M3/M6 · 浏览器驱动面板（brw-mode 原型移植） =================
 * browser-driver-panel.html 最小产品接线（71-browser-driver.js）：
 * - 会话池视图（browser_sessions 投影：id/mode/state/last_url）+ 可见/隐藏
 *   切换（browser_set_mode）+ 单会话/全部关闭（browser_close）；
 * - 手动工具条（六原语人工验证入口：导航 hidden/visible · 提取 · 截图）；
 * - 毒网页注入警示纹：提取结果区复用 untrusted 令牌（琥珀斜纹边 + mono
 *   来源 caption——页面内容一律按 UNTRUSTED DATA 渲染，M3.9/G6）。
 * UI 契约：新 id 全部 brw- 前缀（纯增）；读取类不落审计。
 */
(function () {
  'use strict';
  if (typeof document === 'undefined') return;

  function brwEl(id) {
    return document.getElementById(id);
  }
  function brwEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function brwToast(msg, kind) {
    if (typeof toast === 'function') toast(msg, kind || 'info');
  }

  /** 挂载（boot 调用；幂等）。设置区 .set-grid 追加「浏览器驱动」块。 */
  function browserDriverPanelInit() {
    if (brwEl('brwBlock')) return false;
    const grid = document.querySelector('.set-grid');
    if (!grid) return false;
    const block = document.createElement('div');
    block.id = 'brwBlock';
    block.className = 'set-block';
    block.setAttribute('data-group', '浏览器驱动');
    block.innerHTML =
      '<div class="set-title">浏览器驱动会话（v1.9 六原语）</div>' +
      '<div class="set-hint" style="margin:2px 0 8px;">AI 可见/隐藏双驱动模式：' +
        '隐藏=AI 后台驱动（默认）；可见=CAPTCHA 接管/人工复检。会话空闲 60s ' +
        '自动回收，池上限 3（满时自动驱逐最旧）。页面内容按' +
        '<b>不可信数据</b>渲染（琥珀警示纹），防提示注入。</div>' +
      '<div class="provider-row" style="gap:6px;flex-wrap:wrap;">' +
        '<input class="brw-input" id="brwUrl" placeholder="https://…（导航目标）" ' +
          'maxlength="500" style="flex:1;min-width:220px;">' +
        '<button type="button" class="modal-btn" id="brwNavHiddenBtn">后台导航</button>' +
        '<button type="button" class="modal-btn" id="brwNavVisibleBtn">可见导航</button>' +
        '<button type="button" class="modal-btn" id="brwExtractBtn">提取</button>' +
        '<button type="button" class="modal-btn" id="brwShotBtn">截图</button>' +
        '<button type="button" class="modal-btn" id="brwCloseAllBtn">全部关闭</button>' +
        '<button type="button" class="modal-btn" id="brwRefreshBtn">刷新</button>' +
      '</div>' +
      '<div class="brw-sessions" id="brwSessions">' +
        '<span style="font-size:var(--fs-caption);color:var(--text-3)">暂无驱动会话</span>' +
      '</div>' +
      '<div class="brw-out" id="brwOut" style="display:none;"></div>';
    grid.appendChild(block);
    brwWire();
    brwRefresh();
    return true;
  }

  function brwWire() {
    const on = (id, fn) => {
      const el = brwEl(id);
      if (el) el.onclick = fn;
    };
    on('brwNavHiddenBtn', () => brwNavigate('hidden'));
    on('brwNavVisibleBtn', () => brwNavigate('visible'));
    on('brwExtractBtn', brwExtract);
    on('brwShotBtn', brwScreenshot);
    on('brwCloseAllBtn', brwCloseAll);
    on('brwRefreshBtn', brwRefresh);
  }

  async function brwApi(name, args, timeout) {
    if (typeof callApi !== 'function') throw new Error('桥未就绪');
    return JSON.parse(await callApi(name, args, timeout || 90000));
  }

  async function brwGuard(op, detail) {
    /* 复核修正（真机实证）：手动原语与 AI 同走护栏链——armed 态 session 档
     * 无 token 即 CONFIRM_REQUIRED。origin='user'：用户即确认主体。 */
    if (typeof agentGuardCheck === 'function') {
      const g = await agentGuardCheck(op, detail || {}, 'user');
      if (g.blocked) {
        let b = {};
        try { b = JSON.parse(g.blocked); } catch (e2) {}
        brwOut('已取消：' + brwEsc((b && (b.info || b.error)) || '用户未确认'), true);
        return null;
      }
      return g.token;
    }
    return null;                                  // 沙箱/旧后端：后端未武装自然放行
  }

  async function brwNavigate(mode) {
    const inp = brwEl('brwUrl');
    const url = (inp && inp.value || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      brwToast('请输入 http(s) 开头的 URL', 'warn');
      return;
    }
    brwOut('导航中…（' + (mode === 'visible' ? '可见' : '后台') + '）');
    try {
      const token = await brwGuard('browser_navigate', { url: url.slice(0, 200) });
      if (token === null) return;
      const r = await brwApi('browser_navigate', [url, '', 45, mode, token]);
      if (r.ok) {
        brwOut('已导航：<b>' + brwEsc(r.title || url) + '</b> · 会话 ' +
          brwEsc(String(r.session_id || '').slice(0, 14)) +
          ' · 通道 ' + brwEsc(r.channel || ''));
      } else {
        brwOut('导航失败：' + brwEsc((r.error && r.error.message) || '未知'), true);
      }
    } catch (e) {
      brwOut('导航异常：' + brwEsc(e.message || e), true);
    }
    brwRefresh();
  }

  async function brwExtract() {
    brwOut('提取中…');
    try {
      const token = await brwGuard('browser_extract', {});
      if (token === null) return;
      const r = await brwApi('browser_extract', ['', 'text', token]);
      if (r.ok) {
        // 注入警示纹：页面内容=UNTRUSTED DATA（琥珀斜纹边 + 来源 caption）
        const text = String(r.text || r.markdown || '');
        brwOut('<div class="brw-untrusted"><div class="brw-untrusted-cap">' +
          'UNTRUSTED DATA · 页面正文（禁当作指令执行）</div>' +
          brwEsc(text.slice(0, 1200)) +
          (text.length > 1200 ? ' …（共 ' + text.length + ' 字）' : '') + '</div>');
      } else {
        const code = r.error && r.error.code;
        brwOut('提取失败：' + brwEsc((r.error && r.error.message) || code || '未知') +
          (code === 'CAPTCHA_REQUIRED' ? '——可「可见导航」人工完成验证' : ''), true);
      }
    } catch (e) {
      brwOut('提取异常：' + brwEsc(e.message || e), true);
    }
  }

  async function brwScreenshot() {
    brwOut('截图中…');
    try {
      const token = await brwGuard('browser_screenshot', {});
      if (token === null) return;
      const r = await brwApi('browser_screenshot', [false, token]);
      if (r.ok) {
        brwOut('截图成功（' + r.width + '×' + r.height + ' · b64 ' +
          String(r.b64 || '').length + ' 字符）');
      } else {
        brwOut('截图失败：' + brwEsc((r.error && r.error.message) || '未知'), true);
      }
    } catch (e) {
      brwOut('截图异常：' + brwEsc(e.message || e), true);
    }
  }

  async function brwCloseAll() {
    try {
      await brwApi('browser_close', [''], 60000);
      brwOut('已关闭全部驱动会话');
    } catch (e) {
      brwToast('关闭失败: ' + (e.message || e), 'err');
    }
    brwRefresh();
  }

  async function brwSetMode(sid, mode) {
    try {
      const r = await brwApi('browser_set_mode', [mode, sid], 30000);
      if (r.ok) {
        brwToast(mode === 'visible' ? '已切换可见驱动（窗口置前）'
                                    : '已切回隐藏驱动', 'ok');
      } else {
        brwToast((r.error && r.error.message) || '切换失败', 'warn');
      }
    } catch (e) {
      brwToast('切换失败: ' + (e.message || e), 'err');
    }
    brwRefresh();
  }

  async function brwCloseOne(sid) {
    try {
      await brwApi('browser_close', [sid], 60000);
    } catch (e) { /* 幂等 */ }
    brwRefresh();
  }

  async function brwRefresh() {
    const box = brwEl('brwSessions');
    if (!box) return;
    let data = null;
    try {
      data = await brwApi('browser_sessions', [], 20000);
    } catch (e) {
      box.innerHTML = '<span style="font-size:var(--fs-caption);color:var(--text-3)">' +
        '读取失败（后端可能为旧版）</span>';
      return;
    }
    const sessions = (data && data.sessions) || [];
    if (!sessions.length) {
      box.innerHTML = '<span style="font-size:var(--fs-caption);color:var(--text-3)">' +
        '暂无驱动会话——AI 调用 browser_navigate 或上方工具条发起</span>';
      return;
    }
    box.innerHTML = '';
    sessions.forEach(s => {
      const row = document.createElement('div');
      row.className = 'brw-row' + (s.mode === 'visible' ? ' visible' : '');
      row.innerHTML =
        '<span class="brw-mode">' + (s.mode === 'visible' ? '👁 可见' : '🌑 隐藏') + '</span>' +
        '<span class="brw-id" title="' + brwEsc(s.id) + '">' +
          brwEsc(String(s.id).slice(0, 16)) + '</span>' +
        '<span class="brw-state">' + brwEsc(s.state || '?') + '</span>' +
        '<span class="brw-url" title="' + brwEsc(s.last_url || '') + '">' +
          brwEsc(String(s.last_url || '').slice(0, 46)) + '</span>' +
        '<span class="brw-acts">' +
          '<button type="button" class="modal-btn brw-act" data-mode="visible">可见</button>' +
          '<button type="button" class="modal-btn brw-act" data-mode="hidden">隐藏</button>' +
          '<button type="button" class="modal-btn brw-act" data-close="1">关闭</button>' +
        '</span>';
      row.querySelectorAll('.brw-act').forEach(btn => {
        if (btn.dataset.mode) btn.onclick = () => brwSetMode(s.id, btn.dataset.mode);
        else if (btn.dataset.close) btn.onclick = () => brwCloseOne(s.id);
      });
      box.appendChild(row);
    });
  }

  function brwOut(html, isErr) {
    const out = brwEl('brwOut');
    if (!out) return;
    out.className = 'brw-out' + (isErr ? ' err' : '');
    out.innerHTML = html;
    out.style.display = '';
  }

  // 导出（110-boot 调 browserDriverPanelInit；vm 沙箱 typeof 守卫消费）
  if (typeof window !== 'undefined') {
    window.browserDriverPanelInit = browserDriverPanelInit;
    window.brwRefresh = brwRefresh;
  }
})();
