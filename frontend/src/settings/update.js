/* ================= 自动更新（v1.2 R1 最小版） =================
 * 启动后台检查 → header 版本 pill 轻提示 → 下载（SHA256 校验，进度轮询）
 * → 校验失败保留旧版可重试 → 成功后确认重启 → apply_update（辅助脚本自替换）。
 */

let _updateInfo = null;   // {latest, url, sha256, notes}

function _updatePill() {
  let p = document.getElementById('updatePill');
  if (!p) {
    p = document.createElement('button');
    p.id = 'updatePill';
    p.className = 'pill-btn update-pill';
    p.style.display = 'none';
    p.title = '有新版本可用';
    const right = document.querySelector('.header-right');
    if (right) right.insertBefore(p, right.firstChild);
  }
  return p;
}

async function checkForUpdate(manual) {
  if (!window.pywebview || !window.pywebview.api) return;
  let url = '';
  const el = document.getElementById('updateManifestUrl');
  if (el && el.value.trim()) url = el.value.trim();
  try {
    const r = JSON.parse(await callApi('check_update', [url || null]));
    if (r && r.update_available) {
      _updateInfo = r;
      const p = _updatePill();
      p.textContent = '⬆ v' + r.latest + ' 可用';
      p.style.display = '';
      p.onclick = showUpdateDialog;
      toast('新版本 v' + r.latest + ' 可用，点击右上角按钮更新', 'info');
    } else {
      // 修复 建议㊴（二轮）：复查无更新时回收旧 pill（原只 else if manual，
      // 后台复查到「已最新」时旧 pill 一直挂着，点了还打开空对话框）
      _updateInfo = null;
      const p = _updatePill();
      p.style.display = 'none';
      p.onclick = null;
      if (manual) {
        toast(r && r.error ? r.error : '已是最新版本（v' + ((r && r.current) || '?') + '）', r && r.error ? 'warn' : 'ok');
      }
    }
  } catch (e) {
    if (manual) toast('更新检查失败：' + e.message, 'warn');
  }
}

async function showUpdateDialog() {
  if (!_updateInfo) return;
  const r = await uiConfirm({
    title: '更新到 v' + _updateInfo.latest,
    body: '当前版本 v' + (_updateInfo.current || '?') + ' → v' + _updateInfo.latest +
      '\n\n更新说明：\n' + (_updateInfo.notes || '（无）') +
      '\n\n下载完成后需重启应用完成更新（会话已自动保存）。',
    okText: '下载并安装', danger: false
  });
  if (!r.ok) return;
  await startUpdateFlow();
}

async function startUpdateFlow() {
  if (!_updateInfo) return;
  // 修复 W36（三轮）：下载可重入——并发双轮询 + 双 pinned 进度 toast（一个下载
  // 两个进度条互相覆盖）。加 in-flight 守卫，重复触发直接提示
  if (startUpdateFlow._busy) { toast('更新正在下载中，请稍候…', 'info'); return; }
  startUpdateFlow._busy = true;
  // 修复 ㊵：进度 toast 改 pinned（永不自动消失）——原 stay 上限 60s，慢网络下载中途进度不可见
  const t = toast('正在下载 v' + _updateInfo.latest + '… 0%', 'info', { stay: true, pinned: true });
  const setMsg = (txt) => { const m = t && t.querySelector ? t.querySelector('.toast-msg') : null; if (m) m.textContent = txt; };
  const dismiss = () => { try { if (t && t.close) t.close(); } catch (e) {} };   // 修复 ㊵：流程结束时收尾关闭
  try {
    const start = JSON.parse(await callApi('start_update_download', [_updateInfo.url, _updateInfo.sha256, _updateInfo.latest]));
    if (start && start.error) throw new Error(start.error);
    // 轮询进度（带超时保护：最多 10 分钟，防止状态异常时无限空转）
    let polls = 0;
    for (;;) {
      if (++polls > 1000) throw new Error('下载超时（10 分钟），请重试');
      await new Promise(r2 => setTimeout(r2, 600));
      // 瞬时桥错/JSON 错不致死：续试下一拍（总超时仍由 polls 上限兜底）
      let st = null;
      try {
        st = JSON.parse(await callApi('get_update_progress', []));
      } catch (e) { continue; }
      if (!st) continue;
      if (st.state === 'downloading') { setMsg('正在下载 v' + _updateInfo.latest + '… ' + (st.pct || 0) + '%'); continue; }
      if (st.state === 'done') break;
      if (st.state === 'error') throw new Error(st.error || '下载失败');
    }
    setMsg('下载完成，校验通过');
    const go = await uiConfirm({
      title: '更新就绪',
      body: 'v' + _updateInfo.latest + ' 已下载并通过 SHA256 校验。\n点击「立即重启」完成更新（旧版本已自动备份，替换失败会自动回滚）。',
      okText: '立即重启', danger: false
    });
    if (!go.ok) { dismiss(); toast('已暂缓更新，可稍后点击右上角按钮重试', 'info'); return; }
    const ap = JSON.parse(await callApi('apply_update', []));
    if (ap && ap.error) throw new Error(ap.error);
    dismiss();
    toast('正在重启完成更新…', 'ok');
    setTimeout(() => { try { window.close(); } catch (e) {} }, 800);
  } catch (e) {
    dismiss();   // 修复 ㊵：失败时先收掉 pinned 进度条，再弹可关闭的错误明细
    toast('更新失败：' + e.message + '（当前版本不受影响，可重试）', 'err', { stay: true, detail: e.message });
  } finally {
    startUpdateFlow._busy = false;   // 修复 W36（三轮）：流程结束（成功/失败/暂缓）解除重入守卫
  }
}
