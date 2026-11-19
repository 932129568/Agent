/* ================= 右键菜单 ================= */
function setupContextMenu() {
  const input = document.getElementById('userInput');
  if (!input || input.__ctxBound) return;
  input.__ctxBound = true;
  let menu = document.getElementById('ctxMenu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'ctxMenu';
    menu.className = 'ctx-menu';
    document.body.appendChild(menu);
  }
  // v4：hideMenu 显隐模式——加 .hiding 播 v4CtxOut（140ms in-soft），
  // 动画结束（MOTION.onAnimEnd 双兜底）后移除 .show/.hiding；show/hiding 中去重防重入
  const hideMenu = () => {
    if (!menu.classList.contains('show')) return;
    if (menu.classList.contains('hiding')) return;
    menu.classList.add('hiding');
    const done = () => { try { menu.classList.remove('show', 'hiding'); } catch (e) {} };
    if (typeof MOTION !== 'undefined' && !MOTION.instant()) {
      MOTION.onAnimEnd(menu, 'animationend', MOTION.compOut()).then(done);
    } else { done(); }
  };
  input.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    const hasSel = input.selectionStart !== input.selectionEnd;
    const items = [
      { label: '剪切', cmd: 'cut', enabled: hasSel },
      { label: '复制', cmd: 'copy', enabled: hasSel },
      { label: '粘贴', cmd: 'paste', enabled: true },
      { label: '全选', cmd: 'selectAll', enabled: true }
    ];
    menu.innerHTML = '';
    items.forEach(it => {
      const d = document.createElement('div');
      // 修复 ㉝：enabled 原是死字段（写了从没用）——现用于置灰不可用项；无选中时剪切/复制灰显不可点
      d.className = 'ctx-menu-item' + (it.enabled ? '' : ' ctx-item-off');
      d.style.opacity = it.enabled ? '' : '.45';
      d.style.cursor = it.enabled ? '' : 'default';
      d.textContent = it.label;
      if (!it.enabled) {
        d.onclick = (ev) => { ev.stopPropagation(); };   // 置灰项不执行动作（点它不关菜单，便于用户看清状态）
        menu.appendChild(d);
        return;
      }
      d.onclick = () => {
        input.focus();
        if (it.cmd === 'selectAll') input.select();
        else if (it.cmd === 'paste') {
          // 修复 建议㉟（二轮）：execCommand('paste') 在 WebView2 是死按钮——
          // 改走 navigator.clipboard.readText()（用户手势内可用），失败给明确提示
          if (navigator.clipboard && navigator.clipboard.readText) {
            navigator.clipboard.readText().then(t => {
              input.setRangeText(t, input.selectionStart || 0, input.selectionEnd || 0, 'end');
              input.dispatchEvent(new Event('input', { bubbles: true }));
            }).catch(() => toast('无法读取剪贴板，请用 Ctrl+V 粘贴', 'warn'));
          } else {
            toast('当前环境不支持菜单粘贴，请用 Ctrl+V', 'warn');
          }
        }
        else {
          // cut/copy 在有选中时可用（execCommand 对二者在 WebView2 有效）
          try { document.execCommand(it.cmd); } catch (err) {}
        }
        hideMenu();
      };
      menu.appendChild(d);
    });
    // 修复 ㉟（三轮）：原硬编码 150/180 钳制——菜单变宽/变高（长文件名菜单项）时
    // 右侧/底部被视口裁切。改用实测尺寸（先显示再量，避免 offsetWidth=0）
    menu.style.left = '0px'; menu.style.top = '0px';
    menu.classList.remove('hiding'); void menu.offsetWidth;
    menu.classList.add('show');
    const mw = menu.offsetWidth || 150, mh = menu.offsetHeight || 180;
    menu.style.left = Math.max(4, Math.min(e.clientX, window.innerWidth - mw - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(e.clientY, window.innerHeight - mh - 4)) + 'px';
  });
  document.addEventListener('click', hideMenu);
  window.addEventListener('scroll', hideMenu, true);
  // 修复（对抗复审）：Esc 关闭右键菜单。10-custom-select 的浮层守卫只保证
  // 「浮层打开时 Esc 不误 abort 流式」，但 ctxMenu 无自有 Esc 处理器时 Esc 被
  // 消费后菜单不关（_closeModal 无 modalRoot 时 no-op）——「Esc 关闭浮层」
  // 契约对 ctxMenu 只兑现一半。此处补「关」的另一半（与 63-search-panel /
  // 38-ws-quick 的 Esc 处理同惯例）。
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.classList.contains('show')) hideMenu();
  });
}
