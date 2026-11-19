/* ================= 命令沙箱设置面板 + 状态灯（v1.6 T6） =================
 * 接线既有 js_api（v1.6 后端已交付，_V12_EXTRA 隐身，契约零变更）：
 *   sandbox_get_config / sandbox_save_config / sandbox_status
 * 配置落 ~/.glm-chat/sandbox.json（独立文件，不碰 config.json——契约红线）；
 * 档位保存后后端读盘生效（limits_for 每命令现读，本模块只负责 UI→api 通路）。
 *
 * 面板能力（方案 §3 T6 验收）：开关 / 三命令类别档位下拉 / 两档限制编辑
 * （内存 MB · 进程数 · CPU 秒 · UI 级别）/ 状态灯（可用性 + 启用态）/
 * 累计统计（jobs_created/runs_sandboxed/runs_failed_closed）/ 重置默认。
 * 非 Windows 明示「不可用」而非空白（status.available=false 分支）。
 */

const SANDBOX_CLASSES = ['run_command', 'run_powershell', 'run_admin_command'];
const SANDBOX_PROFILES = ['off', 'standard', 'strict'];
const SANDBOX_LIMIT_PROFILES = ['standard', 'strict'];
const SANDBOX_UI_LEVELS = ['none', 'basic', 'strict'];

/* 与后端 sandbox_service.DEFAULT_CONFIG 同口径（前端「重置默认」用；
 * 后端仍是权威源——保存经后端校验落盘，本常量只用于 UI 重建）。 */
const SANDBOX_DEFAULT = {
  enabled: true,
  command_profiles: {
    run_command: 'standard',
    run_powershell: 'standard',
    run_admin_command: 'off'
  },
  limits: {
    standard: { memory_mb: 1024, max_processes: 16, cpu_seconds: 120, ui_restrict: 'basic' },
    strict: { memory_mb: 512, max_processes: 8, cpu_seconds: 60, ui_restrict: 'strict' }
  }
};

let sandboxCfg = null;   // 最近一次 get_config 快照（保存时读-改-写，未取到的键不丢）

/** 启动/进入设置时加载：配置回填 + 状态灯 + 统计。失败不阻塞其他模块。 */
async function loadSandboxPanel() {
  try {
    const raw = await callApi('sandbox_get_config', []);
    sandboxCfg = JSON.parse(raw || '{}');
  } catch (e) {
    sandboxCfg = null;
  }
  renderSandboxSettings();
  refreshSandboxStatus();
}

function _sbEl(id) { return document.getElementById(id); }
function _sbSet(id, v) { const el = _sbEl(id); if (el) el.value = v; }
function _sbShow(id, on) { const el = _sbEl(id); if (el && el.style) el.style.display = on ? '' : 'none'; }

/** 配置 → 表单回填（缺键回落默认值，兼容旧 exe 无响应场景）。 */
function renderSandboxSettings() {
  const cfg = sandboxCfg && typeof sandboxCfg === 'object' ? sandboxCfg : SANDBOX_DEFAULT;
  const en = _sbEl('sandboxEnabled');
  if (en) en.checked = !!cfg.enabled;
  const cp = cfg.command_profiles || SANDBOX_DEFAULT.command_profiles;
  SANDBOX_CLASSES.forEach(cls => {
    _sbSet('sandboxProfile' + cls, cp[cls] || 'off');
  });
  const lim = cfg.limits || SANDBOX_DEFAULT.limits;
  SANDBOX_LIMIT_PROFILES.forEach(p => {
    const L = lim[p] || SANDBOX_DEFAULT.limits[p];
    _sbSet('sandboxLimit' + p + 'Memory', L.memory_mb);
    _sbSet('sandboxLimit' + p + 'Processes', L.max_processes);
    _sbSet('sandboxLimit' + p + 'Cpu', L.cpu_seconds);
    _sbSet('sandboxLimit' + p + 'Ui', L.ui_restrict || 'none');
  });
  _sbShow('sandboxUnavailable', false);
}

function _sbPick(id, fallback) {
  const el = _sbEl(id);
  const v = el ? String(el.value || '') : '';
  return v || fallback;
}

function _sbNum(id, fallback) {
  const el = _sbEl(id);
  const n = el ? parseInt(el.value, 10) : NaN;
  return isNaN(n) ? fallback : n;
}

/** 表单 → 配置（读-改-写：以 get_config 快照为底，未在面板出现的键原样带回）。 */
async function saveSandboxSettings() {
  const next = JSON.parse(JSON.stringify(sandboxCfg || SANDBOX_DEFAULT));
  const en = _sbEl('sandboxEnabled');
  next.enabled = !!(en && en.checked);
  next.command_profiles = {};
  SANDBOX_CLASSES.forEach(cls => {
    next.command_profiles[cls] = _sbPick('sandboxProfile' + cls, 'off');
  });
  next.limits = next.limits || {};
  SANDBOX_LIMIT_PROFILES.forEach(p => {
    const cur = next.limits[p] || SANDBOX_DEFAULT.limits[p];
    next.limits[p] = {
      memory_mb: _sbNum('sandboxLimit' + p + 'Memory', cur.memory_mb),
      max_processes: _sbNum('sandboxLimit' + p + 'Processes', cur.max_processes),
      cpu_seconds: _sbNum('sandboxLimit' + p + 'Cpu', cur.cpu_seconds),
      ui_restrict: _sbPick('sandboxLimit' + p + 'Ui', cur.ui_restrict || 'none')
    };
  });
  try {
    const r = JSON.parse(await callApi('sandbox_save_config', [JSON.stringify(next)]) || '{}');
    if (r && r.error) { toast('沙箱配置保存失败: ' + r.error, 'err'); return; }
    sandboxCfg = next;
    toast('沙箱配置已保存（下一条命令按新档位生效）', 'ok');
    refreshSandboxStatus();
  } catch (e) {
    toast('沙箱配置保存失败: ' + (e && e.message ? e.message : e), 'err');
  }
}

/** 重置默认（二次确认 → 保存默认结构 → 回填 + 刷新状态）。 */
async function sandboxResetDefaults() {
  const r = await uiConfirm({
    title: '重置沙箱默认', body: '将恢复默认档位与限制（run_command/run_powershell=standard，run_admin_command=off）。\n不影响已保存的其他配置。',
    danger: false, okText: '恢复默认'
  });
  if (!r.ok) return;
  try {
    const rr = JSON.parse(await callApi('sandbox_save_config', [JSON.stringify(SANDBOX_DEFAULT)]) || '{}');
    if (rr && rr.error) { toast('重置失败: ' + rr.error, 'err'); return; }
    sandboxCfg = JSON.parse(JSON.stringify(SANDBOX_DEFAULT));
    renderSandboxSettings();
    toast('已恢复沙箱默认配置', 'ok');
    refreshSandboxStatus();
  } catch (e) {
    toast('重置失败: ' + (e && e.message ? e.message : e), 'err');
  }
}

/** 状态灯 + 累计统计（status：available/platform/enabled/command_profiles/stats）。 */
async function refreshSandboxStatus() {
  const light = _sbEl('sandboxStatusLight');
  const text = _sbEl('sandboxStatusText');
  const stats = _sbEl('sandboxStats');
  let st = null;
  try {
    st = JSON.parse(await callApi('sandbox_status', []) || '{}');
  } catch (e) {
    st = null;
  }
  if (!st) {
    if (text) text.textContent = '状态获取失败（后端无响应）';
    if (stats) stats.textContent = '';
    _sbShow('sandboxUnavailable', true);
    return;
  }
  const avail = !!st.available;
  const on = avail && !!st.enabled;
  if (light) {
    light.classList.toggle('ok', on);
    light.classList.toggle('warn', avail && !st.enabled);
    light.classList.toggle('off', !avail);
  }
  if (text) {
    if (!avail) {
      // 非 Windows：明示不可用而非空白（T6 验收）
      text.textContent = '当前平台（' + (st.platform || 'unknown') +
        '）不支持 Job Object 沙箱——命令将直接执行，无资源限制';
    } else if (!st.enabled) {
      text.textContent = '沙箱总开关已关闭——全部命令直接执行，无资源限制';
    } else {
      const cps = st.command_profiles || {};
      const managed = Object.keys(cps).filter(k => cps[k] && cps[k] !== 'off');
      text.textContent = '沙箱已启用——在管命令类别：' +
        (managed.length ? managed.join('、') : '无（所有类别均为 off）');
    }
  }
  if (stats) {
    const s = st.stats || {};
    stats.textContent = '累计：创建 Job ' + (s.jobs_created || 0) +
      ' · 沙箱执行 ' + (s.runs_sandboxed || 0) +
      ' · fail-closed 拒绝 ' + (s.runs_failed_closed || 0);
  }
  _sbShow('sandboxUnavailable', !avail);
}
