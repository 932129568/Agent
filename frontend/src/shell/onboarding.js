/* ================= v1.8.0 W10 · 首次使用引导向导（68-onboarding.js） =================
 * 触发：无任何会话 + 未配置 API Key（或本地模式未探测）→ 全屏引导层。
 * 步骤（4 步，可跳过）：welcome（品牌+能力预览）→ source（选服务商预设卡片）
 *   → key（填 Key + 测试连接）→ done（进入对话，localStorage 记住）。
 * 设计：v4 玻璃卡 + 四层动效令牌；ob-* 纯新增类（UI 契约只增不改）。
 * 与既有 emptyGuide（41-nav.js 空态三步引导）关系：向导是首启全屏版，
 *   完成后空态引导继续承担「配 Key 前」的轻量提示——两层不重叠。
 */

const OB_DONE_KEY = 'glm_onboarding_done_v1';

function obDone() {
  try {
    if (typeof localStorage === 'undefined') return true;
    return localStorage.getItem(OB_DONE_KEY) === '1';
  } catch (e) { return true; }
}
function obMarkDone() {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(OB_DONE_KEY, '1'); } catch (e) {}
}

/** 是否应展示向导：未完成过 + 无 Key + 无历史会话。 */
function obShouldShow() {
  if (obDone()) return false;
  if (typeof effectiveApiKey === 'function' && effectiveApiKey()) return false;
  if (typeof localModeActive === 'function' && localModeActive()) return false;
  if (typeof sessions !== 'undefined' && Array.isArray(sessions) && sessions.length) return false;
  return true;
}

const OB_STEPS = [
  { id: 'welcome', title: '欢迎使用 Harbor' },
  { id: 'source', title: '选择模型服务' },
  { id: 'key', title: '填入 API Key' },
  { id: 'done', title: '准备就绪' }
];

let obStepIdx = 0;
let obRoot = null;

function obRender() {
  if (typeof document === 'undefined') return;
  const step = OB_STEPS[obStepIdx];
  const body = obRoot.querySelector('.ob-body');
  body.innerHTML = obStepHtml(step.id);
  // 步骤切换动效：内容层重放（CSS animation 由 innerHTML 替换天然重触发）
  const dots = obRoot.querySelectorAll('.ob-dot');
  dots.forEach((d, i) => d.classList.toggle('on', i === obStepIdx));
  const back = obRoot.querySelector('#obBack');
  if (back) back.style.visibility = obStepIdx === 0 ? 'hidden' : 'visible';
  const next = obRoot.querySelector('#obNext');
  if (next) next.textContent = obStepIdx === OB_STEPS.length - 1 ? '开始对话 →' : '下一步 →';
  // source 步骤：预设卡片选中态
  obWireStep(step.id);
}

function obStepHtml(id) {
  if (id === 'welcome') {
    return '<div class="ob-hero">' +
      '<div class="ob-logo">H</div>' +
      '<h2>欢迎使用 Harbor</h2>' +
      '<p>多模态本地 AI Agent：对话 · 工具调用 · 浏览器搜索 · 软件调用 · 计划执行</p>' +
      '<div class="ob-feats">' +
      ['🗨 多模态对话（文字/图片/视频/文件）', '🔍 受控浏览器搜索（自有 WebView2）',
       '🧩 外部软件调用（CLI/GUI/URI）', '📋 Plan-Act 计划执行与检查点回滚']
        .map((t, i) => '<div class="ob-feat" style="animation-delay:' + (i * 40) + 'ms">' + t + '</div>').join('') +
      '</div></div>';
  }
  if (id === 'source') {
    // 修复：原硬编码回落表与 36-connect.js PRESETS 漂移（新预设不出现、旧文案失真）——
    // 且 connectPresets 函数根本不存在，恒走回落。改读单一事实源 connectPresetIds() +
    // PRESETS（取 id+name+desc；PRESETS 无 desc 字段，按 local/glm_capable/free_tier 派生）。
    let list = [];
    if (typeof connectPresetIds === 'function' && typeof PRESETS !== 'undefined') {
      list = connectPresetIds().map(pid => {
        const meta = PRESETS[pid] || {};
        const desc = meta.local ? '本机模型 · 免 Key'
          : (meta.glm_capable ? 'GLM 官方 · 国内直连'
          : (meta.free_tier ? '免费层 · 需 PAT' : 'OpenAI 兼容'));
        return { id: pid, name: meta.name || pid, desc: desc };
      });
    }
    if (!list.length) list = [
      { id: 'glm', name: '智谱 GLM', desc: 'glm-5.3 系列 · 国内直连' },
      { id: 'deepseek', name: 'DeepSeek', desc: 'OpenAI 兼容 · 高性价比' },
      { id: 'ollama', name: 'Ollama（本地）', desc: '本机模型 · 免 Key' }
    ];
    return '<h2>选择模型服务</h2><p class="ob-sub">随时可在「设置 → 连接与模型」切换</p>' +
      '<div class="ob-cards">' +
      list.map((p, i) =>
        '<button class="ob-card' + (p.id === 'glm' ? ' on' : '') + '" data-preset="' + obEsc(p.id) +
        '" style="animation-delay:' + (i * 40) + 'ms">' +
        '<span class="ob-card-n">' + obEsc(p.name || p.id) + '</span>' +
        '<span class="ob-card-d">' + obEsc(p.desc || '') + '</span></button>').join('') +
      '</div>';
  }
  if (id === 'key') {
    return '<h2>填入 API Key</h2><p class="ob-sub">Key 仅存本机 config.json，不上传任何服务器</p>' +
      '<div class="ob-keyrow">' +
      '<input class="ob-input" id="obKey" type="password" placeholder="sk-…" maxlength="200">' +
      '<button class="pill-btn" id="obTest">测试连接</button>' +
      '</div>' +
      '<div class="ob-keystat" id="obKeyStat"></div>' +
      '<div class="ob-alt">使用本地模型（Ollama 等）？<a href="#" id="obLocal">跳过 Key，直接选本地服务 →</a></div>';
  }
  return '<div class="ob-hero"><div class="ob-logo ok">✓</div>' +
    '<h2>准备就绪</h2><p>在下方输入框开始提问吧。输入 /plan 可让 Agent 先出计划再执行。</p>' +
    '<div class="ob-tips">' +
    ['Enter 发送 · Shift+Enter 换行', '支持拖入图片/文件', '随时点 header 放大镜试用浏览器搜索']
      .map(t => '<div class="ob-tip">' + t + '</div>').join('') + '</div></div>';
}

function obWireStep(id) {
  if (id === 'source') {
    obRoot.querySelectorAll('.ob-card').forEach(c => {
      c.onclick = () => {
        obRoot.querySelectorAll('.ob-card').forEach(x => x.classList.remove('on'));
        c.classList.add('on');
        // 联动既有预设状态机（36-connect.js connectApplyPreset，存在则调）
        if (typeof connectApplyPreset === 'function') {
          try { connectApplyPreset(c.dataset.preset); } catch (e) {}
        }
      };
    });
  }
  if (id === 'key') {
    const test = obRoot.querySelector('#obTest');
    if (test) test.onclick = () => obTestKey();
    const local = obRoot.querySelector('#obLocal');
    if (local) local.onclick = () => {
      // 修复：原仅关闭向导——「跳过 Key」的意图是切本地服务。改应用 ollama
      // 预设（免 Key）并跳转设置面板，让用户在本地面板继续配置。
      if (typeof connectApplyPreset === 'function') {
        try { connectApplyPreset('ollama', { animate: true }); } catch (e) {}
      }
      if (typeof navSwitch === 'function') navSwitch('settings');
      obFinish();
    };
    const input = obRoot.querySelector('#obKey');
    if (input) setTimeout(() => input.focus(), 80);
  }
}

let _obTestBusy = false;   // obTestKey 防连点闸门
async function obTestKey() {
  const input = obRoot.querySelector('#obKey');
  const stat = obRoot.querySelector('#obKeyStat');
  const key = input ? String(input.value || '').trim() : '';
  // 修复（对抗复审）：免 Key 判据与 connectTestNow 的 key_required 对齐——本地系
  // 预设（ollama/lmstudio/…）不要求 Key；原恒判空 key 让本地用户看到误导性的
  // 「请先填入 Key」（应走 obLocal 链接或直接放行测试）。
  const _obLocal = (typeof connectIsLocalPreset === 'function') ? !!connectIsLocalPreset() : false;
  if (!key && !_obLocal) { if (stat) { stat.textContent = '请先填入 Key'; stat.className = 'ob-keystat err'; } return; }
  if (_obTestBusy) return;   // 防连点：测试进行中忽略重复点击
  if (stat) { stat.textContent = '正在测试连接…'; stat.className = 'ob-keystat'; }
  // 写入既有 Key 字段（复用设置连接块的保存链）
  const apiKeyEl = (typeof document !== 'undefined') ? document.getElementById('apiKey') : null;
  if (apiKeyEl) apiKeyEl.value = key;
  if (typeof queueSaveConfig === 'function') queueSaveConfig();
  _obTestBusy = true;
  try {
    // 修复（对抗复审）：原调 test_provider_endpoint 时第二参恒传 ''（key）、
    // local 恒 false——① 云端预设下后端 provider test_endpoint 对空 key 直接
    // 返回「缺少 API Key」，测试恒失败（round5「真实测试通道」修复引入了键值
    // 断线；原注释「后端按配置取钥」不成立：queueSaveConfig 有 400ms 防抖，
    // 测试调用时 config 尚未落盘，且后端签名本就以入参为准）；
    // ② 本地系预设（ollama 等免 Key）传 local=false 会走云端分支（空 key 401 /
    // 15s 超时），而 connectTestNow 的口径是 local ? 30 : 15 秒 + local ? 90s :
    // 20s 桥超时。此处与 36-connect connectTestNow 逐字段对齐。
    const base = (typeof connectBaseUrl === 'function') ? connectBaseUrl() : '';
    const model = (typeof connectModelValue === 'function') ? connectModelValue() : '';
    const key = (typeof connectApiKeyInput === 'function') ? connectApiKeyInput() : '';
    const local = (typeof connectIsLocalPreset === 'function') ? !!connectIsLocalPreset() : false;
    const raw = await callApi('test_provider_endpoint',
      [base, local ? '' : key, model, local ? 30 : 15, local], local ? 90000 : 20000);
    const d = JSON.parse(raw || '{}');
    if (d && d.ok) {
      if (stat) { stat.textContent = '✓ 连接成功'; stat.className = 'ob-keystat ok'; }
      if (typeof toast === 'function') toast('连接成功', 'ok');
    } else {
      if (stat) { stat.textContent = '✗ ' + ((d && d.error) || '连接失败'); stat.className = 'ob-keystat err'; }
    }
  } catch (e) {
    if (stat) { stat.textContent = '✗ ' + (e && e.message || e); stat.className = 'ob-keystat err'; }
  } finally {
    _obTestBusy = false;
  }
}

function obNext() {
  if (obStepIdx < OB_STEPS.length - 1) {
    obStepIdx++;
    obRender();
  } else {
    obFinish();
  }
}
function obBack() {
  if (obStepIdx > 0) { obStepIdx--; obRender(); }
}
function obSkip() {
  obFinish();
}
function obFinish() {
  obMarkDone();
  if (!obRoot) return;
  obRoot.classList.add('hiding');
  const done = () => { if (obRoot) { obRoot.remove(); obRoot = null; } };
  if (typeof MOTION !== 'undefined' && !MOTION.instant()) {
    MOTION.onAnimEnd(obRoot, 'animationend', MOTION.compOut()).then(done);
  } else done();
  // 完成后刷新空态引导/头部状态（既有钩子）
  if (typeof navRenderHeaderStatus === 'function') navRenderHeaderStatus();
  if (typeof navUpdateEmptyGuide === 'function') navUpdateEmptyGuide();
}

/** 挂载引导层（幂等；110-boot loadAll 调用）。 */
function onboardingInit() {
  if (typeof document === 'undefined') return false;
  if (obRoot) return true;               // 已挂载
  if (!obShouldShow()) return false;     // 不需要引导
  const root = document.createElement('div');
  root.id = 'onboarding';
  root.className = 'ob-root';
  root.innerHTML =
    '<div class="ob-win">' +
      '<div class="ob-steps">' +
        OB_STEPS.map((s, i) =>
          '<button class="ob-dot' + (i === 0 ? ' on' : '') + '" data-i="' + i + '" title="' +
          obEsc(s.title) + '"></button>').join('') +
      '</div>' +
      '<div class="ob-body"></div>' +
      '<div class="ob-acts">' +
        '<button class="ghost-btn" id="obSkip">跳过引导</button>' +
        '<span style="flex:1"></span>' +
        '<button class="ghost-btn" id="obBack">← 上一步</button>' +
        '<button class="pill-btn primary" id="obNext">下一步 →</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(root);
  obRoot = root;
  obStepIdx = 0;
  obRender();
  root.querySelector('#obNext').onclick = obNext;
  root.querySelector('#obBack').onclick = obBack;
  root.querySelector('#obSkip').onclick = obSkip;
  root.querySelectorAll('.ob-dot').forEach(d => {
    d.onclick = () => { obStepIdx = parseInt(d.dataset.i, 10) || 0; obRender(); };
  });
  return true;
}

function obEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
