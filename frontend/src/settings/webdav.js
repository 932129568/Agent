/* ================= WebDAV 数据主权（v1.6 执行器已接线） =================
 * 后端 webdav_service 五方法全部落地（MKCOL/PUT/GET/PROPFIND + sha256 对拍 +
 * 三方冲突裁决）。前端职责：配置收集/测试/导出/恢复的状态渲染与冲突交互。
 *
 * 契约红线：
 * - js_api：webdav_test(cfg_json) / webdav_export() / webdav_restore(payload_json)
 *   （webdav_save_config/webdav_get_config 用于配置存取；均已登记 _V12_EXTRA）；
 * - 凭证不落 config.json：webdav.json 独立文件（后端 DPAPI 字段级加密）；
 * - DOM/CSS 纯新增（id：webdavUrl/webdavUser/webdavPass/webdavPath/webdavConflict/
 *   webdavTestBtn/webdavExportBtn/webdavRestoreBtn/webdavStatus）。
 */
function webdavCollectConfig() {
  const g = id => (document.getElementById(id) || {}).value || '';
  return {
    url: g('webdavUrl').trim(),
    username: g('webdavUser').trim(),
    password: g('webdavPass'),
    remote_path: g('webdavPath').trim() || '/glm-chat-backup',
    auto_sync: false,
    conflict_policy: g('webdavConflict') || 'ask'
  };
}
function webdavSetStatus(text, ok) {
  const st = document.getElementById('webdavStatus');
  if (st) { st.textContent = text; st.style.color = ok ? 'var(--ok)' : 'var(--text-2)'; }
}
/* 修复 W35（三轮）：表单脏检查——记录上次加载/保存时的配置快照，与当前表单值
   比对。导出/恢复前发现未保存改动则自动带上（原直接用后端旧配置，用户改了
   地址/账号没点保存时静默失效）。 */
let _webdavSnapshot = null;
function webdavFormDirty() {
  try {
    const cur = webdavCollectConfig();
    if (!_webdavSnapshot) return false;   // 未加载过配置（无快照）不判定脏
    const keys = ['url', 'username', 'password', 'remote_path', 'conflict_policy'];
    return keys.some(k => String(cur[k] || '') !== String(_webdavSnapshot[k] || ''));
  } catch (e) { return false; }
}
/** 加载配置回填表单后调用：刷新快照（脏检查基线）。 */
function webdavMarkSnapshot() {
  try { _webdavSnapshot = webdavCollectConfig(); } catch (e) {}
}
/* 修复 W35+回填缺失（三轮）：前端从不调 webdav_get_config 回填——保存后重开软件
   表单全空，用户误以为配置丢失（后端 webdav.json 其实有）。boot 时回填 + 刷新快照。
   密码不回填（后端 get_config 不回显密码，只影响「测试连接」需重输——安全取舍）。 */
async function loadWebdavConfigNow() {
  try {
    const r = JSON.parse(await callApi('webdav_get_config', [])) || {};
    const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
    set('webdavUrl', r.url);
    set('webdavUser', r.username);
    set('webdavPath', r.remote_path || '/glm-chat-backup');
    set('webdavConflict', r.conflict_policy || 'ask');
    webdavMarkSnapshot();
  } catch (e) {
    /* 后端不可用（旧 exe）：留空表单 */
    /* 修复：以当前（空）表单为脏检查基线——否则快照永为 null，用户后续
       手填的地址/账号永不判脏，导出/恢复会静默使用后端旧配置（W35 失效） */
    webdavMarkSnapshot();
  }
}
if (typeof document !== 'undefined' && document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadWebdavConfigNow);
} else if (typeof document !== 'undefined') {
  loadWebdavConfigNow();
}
/** 保存配置（webdav.json，DPAPI 加密 password；导出/恢复前必须先保存）。
 * 修复（四轮）：返回 true/false 成败——原吞掉失败只 toast，导出/恢复会继续用
 * 后端旧配置执行（备份传到用户以为已改掉的旧服务器）。 */
async function saveWebdavConfigNow() {
  const btn = document.getElementById('webdavSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  webdavSetStatus('', true);
  let ok = false;
  try {
    const r = JSON.parse(await callApi('webdav_save_config', [JSON.stringify(webdavCollectConfig())]));
    if (r.ok) {
      ok = true;
      webdavMarkSnapshot();   // 修复 W35（三轮）：保存成功即刷新脏检查基线
      if (r.warning) toast(r.warning, 'warn', { stay: true });   // W17：DPAPI 兜底明文告警
      webdavSetStatus('✓ 配置已保存到本机 webdav.json（密码已加密）', true);
      toast('WebDAV 配置已保存', 'ok');
    } else {
      webdavSetStatus('✗ ' + (r.error || '失败'), false);
      toast('配置保存失败：' + (r.error || ''), 'err', { stay: true });
    }
  } catch (e) {
    webdavSetStatus('✗ ' + e.message, false);
    toast('配置保存失败：' + e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '保存配置'; }
  }
  return ok;
}
async function webdavTestNow() {
  const btn = document.getElementById('webdavTestBtn');
  if (btn) { btn.disabled = true; btn.textContent = '测试中…'; }
  webdavSetStatus('', true);
  try {
    const r = JSON.parse(await callApi('webdav_test', [JSON.stringify(webdavCollectConfig())]));
    if (r.ok) {
      webdavSetStatus('✓ ' + (r.detail || '连接成功'), true);
      toast('WebDAV 连接成功' + (r.dav_capability && r.dav_capability !== 'unknown' ? '（DAV：' + r.dav_capability + '）' : ''), 'ok');
    } else {
      webdavSetStatus('✗ ' + (r.error || '失败'), false);
      toast('WebDAV 测试失败：' + (r.error || ''), 'err', { stay: true });
    }
  } catch (e) {
    webdavSetStatus('✗ ' + e.message, false);
    toast('WebDAV 测试失败：' + e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '测试连接'; }
  }
}
async function webdavExportNow() {
  const btn = document.getElementById('webdavExportBtn');
  // 修复 W35（三轮）：导出/恢复原直接用后端已存配置——UI 表单改了地址/账号但
  // 没点保存时静默用旧配置（用户以为改了其实没生效）。导出前自动带上未保存改动
  try {
    if (typeof webdavFormDirty === 'function' && webdavFormDirty()) {
      if (!(await saveWebdavConfigNow())) return;   // 修复（四轮）：保存失败即中止，不用旧配置导出
    }
  } catch (e) {}
  if (btn) { btn.disabled = true; btn.textContent = '上传中…'; }
  webdavSetStatus('', true);
  try {
    const r = JSON.parse(await callApi('webdav_export', []));
    if (r.ok) {
      const items = (r.uploaded || []).join('、');
      webdavSetStatus('✓ 已上传 ' + (r.uploaded || []).length + ' 个文件' +
        (items ? '（' + items + '）' : ''), true);
      toast('备份已上传到 WebDAV（含 manifest 清单）', 'ok');
    } else {
      // 未配置/上传失败：plan 存在时展示导出计划（上传前预览）
      const planTxt = (r.plan || []).map(i =>
        i.missing ? i.path + '（缺失，将跳过）'
          : i.path + '（' + i.bytes + 'B）').join('\n');
      webdavSetStatus('✗ ' + (r.error || '失败'), false);
      toast((r.error || '导出失败') + (planTxt ? '\n导出计划：\n' + planTxt : ''), 'err',
            { stay: true, detail: planTxt });
    }
  } catch (e) {
    webdavSetStatus('✗ ' + e.message, false);
    toast('导出失败：' + e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '导出备份'; }
  }
}
async function webdavRestoreNow() {
  const btn = document.getElementById('webdavRestoreBtn');
  // 修复 W35（三轮）：同导出——恢复前自动保存未保存的表单改动（地址/账号）
  try {
    if (typeof webdavFormDirty === 'function' && webdavFormDirty()) {
      if (!(await saveWebdavConfigNow())) return;   // 修复（四轮）：保存失败即中止，不从旧来源恢复
    }
  } catch (e) {}
  // 修复 S13（三轮）：数据覆盖级操作补二次确认（config+sessions+audit 全覆盖，
  // 与项目其他破坏性操作的确认惯例对齐；误点不可逆）
  const confirmed = await uiConfirm({
    title: '从备份恢复',
    body: '将用云端备份覆盖本地配置、会话与审计日志（共 3 项数据），此操作不可撤销。\n确定继续？',
    danger: true,
    okText: '确定恢复'
  });
  if (!confirmed || !confirmed.ok) {
    if (btn) { btn.disabled = false; btn.textContent = '从备份恢复'; }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = '恢复中…'; }
  webdavSetStatus('', true);
  try {
    const r = JSON.parse(await callApi('webdav_restore', ['{}']));
    if (r.ok) {
      webdavSetStatus('✓ ' + (r.summary || '恢复完成'), true);
      toast(r.summary || '恢复完成', 'ok', { detail: (r.kept_both || []).join('\n') });
      if ((r.kept_both || []).length) {
        toast('冲突文件已双保留：\n' + r.kept_both.join('\n'), 'warn', { stay: true });
      }
    } else if (r.need_decision) {
      // ask 策略检出冲突 → 引导用户改策略或逐个确认（后端按策略执行）
      const list = (r.conflicts || []).map(c => '· ' + c.path).join('\n');
      webdavSetStatus('△ 检测到 ' + (r.conflicts || []).length + ' 个冲突文件', false);
      // 修复 ⑳（三轮）：only_local 口径透明化——恢复计划中 action=keep_local 的
      // 文件（本地较基线有改、远端未动）不会上行，原 UI 只列 conflicts，用户误以为
      // 恢复=全量同步。显式告知保留本地的条目数。
      const keepLocal = (r.plan || []).filter(i => i.action === 'keep_local');
      if (keepLocal.length) {
        webdavSetStatus('△ 检测到 ' + (r.conflicts || []).length + ' 个冲突文件；另有 ' +
              keepLocal.length + ' 个仅本地改动将保留（不上传）', false);
      }
      toast('本地与云端都有改动的文件：\n' + list +
            (keepLocal.length ? '\n（另有 ' + keepLocal.length + ' 个仅本地改动将保留，不上传）' : '') +
            '\n请选择合并策略（本地优先/云端优先/双保留）后重试。', 'warn', { stay: true, detail: list });
    } else {
      webdavSetStatus('✗ ' + (r.error || '失败'), false);
      toast('恢复失败：' + (r.error || ''), 'err', { stay: true });
    }
  } catch (e) {
    webdavSetStatus('✗ ' + e.message, false);
    toast('恢复失败：' + e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '从备份恢复'; }
  }
}
