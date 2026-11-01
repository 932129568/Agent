/* ================= 启动 ================= */
window.onload = function () {
  let called = false;
  const go = () => { if (!called) { called = true; loadAll(); } };
  // P0-4 修正：Electron 桌面端走 HARBOR_API_BASE HTTP 桥（preload 注入）——
  // 原判定只认 pywebview，导致 HTTP 桥环境下误置「等待后端就绪」且永不消除
  if ((window.pywebview && window.pywebview.api) || window.HARBOR_API_BASE) go();
  else {
    window.addEventListener('pywebviewready', () => {
      if (called) { bridgeLateReady(); }   // 修复（建议18）：5s 回退已跑过 loadAll（无桥）→ 补偿补齐桥依赖部分
      else go();
    });
    setTimeout(() => {
      if (!called) {
        called = true;
        // 修复（建议18）：回退分支不再静默缺桥——置中性态「等待后端就绪」
        // P0-4 修正：仅当两种桥都缺席时才置提示（HTTP 桥在位时不误导用户）
        if (!((window.pywebview && window.pywebview.api) || window.HARBOR_API_BASE)) {
          if (typeof AppState !== 'undefined') AppState.backendWarning = '◇ 等待后端就绪…（桌面端连接中）';
          else backendWarning = '◇ 等待后端就绪…（桌面端连接中）';
        }
        loadAll();
      }
    }, 5000);
  }
};
/* pywebviewready 晚到（回退分支已跑过 loadAll）：补偿执行桥依赖初始化并刷新状态行。
 * 幂等：bridgeDependentInit 内各步骤均带 try/catch，重复调用安全；
 * backendWarning 先置 null——若桥实际仍不可用，由 bridgeDependentInit 的
 * get_api_info 重试失败后再置真实错误态（不会残留中性态假装就绪）。 */
function bridgeLateReady() {
  if (typeof AppState !== 'undefined') AppState.backendWarning = null;
  else backendWarning = null;
  try {
    Promise.resolve(bridgeDependentInit()).then(async () => {
      // 5s 无桥回退后，桥晚到需补齐全部依赖后端的可见状态，而非仅自检。
      try { if (typeof modelPrefsRefresh === 'function') await modelPrefsRefresh(); } catch (e) {}
      try { if (typeof refreshPlatformInfo === 'function') await refreshPlatformInfo(); } catch (e) {}
      try { if (typeof refreshReaderBadge === 'function') await refreshReaderBadge(); } catch (e) {}
      try { if (typeof loadSandboxPanel === 'function') await loadSandboxPanel(); } catch (e) {}
      try { if (typeof renderGrantBudgetBar === 'function') await renderGrantBudgetBar(); } catch (e) {}
      if (typeof updateTokenStat === 'function') updateTokenStat();
    }).catch(() => {});
  } catch (e) { /* bridgeDependentInit 同步抛也不拖垮启动 */ }
}
async function loadAll() {
  // 修复（建议17）：initFx 提到首个 await 之前——特效总开关必须在任何桥调用
  // 前生效（initFx 无 await 依赖：读 localStorage + 切 body class，纯同步）。
  // 原位置在 get_memory await 之后：桥慢/挂起（旧 exe/浏览器调试）时 fx-off
  // 迟迟不应用，开屏极光/入场动画先闪一跳关特效用户的眼。
  initFx();   // v3：特效总开关（.fx-off + localStorage['glm_fx'] 持久化）
  // 复核批新增：推理偏好预载（模型弹层内嵌思考强度/上下文窗口的缓存数据源；
  // 旧 exe 无此方法静默保持默认）
  try { if (typeof modelPrefsRefresh === 'function') await modelPrefsRefresh(); } catch (e) {}
  try { window.__memCache = await callApi('get_memory', []); } catch (e) { window.__memCache = '[]'; }
  setupContextMenu();
  document.querySelectorAll('select').forEach(initCustomSelect);
  applyTheme((function () { try { return localStorage.getItem('glm_theme') || 'light'; } catch (e) { return 'light'; } })());
  const tempEl = document.getElementById('temperature');
  const topPEl = document.getElementById('topP');
  const updateLabels = () => {
    document.getElementById('tempVal').textContent = parseFloat(tempEl.value).toFixed(1);
    document.getElementById('topPVal').textContent = parseFloat(topPEl.value).toFixed(2);
  };
  tempEl.addEventListener('input', () => { updateLabels(); queueSaveConfig(); });
  topPEl.addEventListener('input', () => { updateLabels(); queueSaveConfig(); });
  document.getElementById('modelSelect').addEventListener('change', () => {
    if (typeof connectOnModelChange === 'function') connectOnModelChange();   // v4：下拉 ⇄ 手动态同步
    queueSaveConfig();
    updateBrandModel();   // v1.2 R6 / v4：品牌位显示当前生效模型
  });
  ['toolMode','maxTokens','reasoningEffort','searchEngine'].forEach(id =>
    document.getElementById(id).addEventListener('change', queueSaveConfig));
  document.getElementById('toolMode').addEventListener('change', () => {
    const v = document.getElementById('toolMode').value;
    if (typeof accessToggleSync === 'function') accessToggleSync();
    addSysTip('工具权限 → ' + (v === 'full' ? '完整' : v === 'readonly' ? '只读' : '纯聊天') + '，下一回合生效');
  });
  document.getElementById('systemPrompt').addEventListener('input', queueSaveConfig);
  document.getElementById('apiKey').addEventListener('input', queueSaveConfig);
  /* v1.2：更新源字段改动即保存 */
  ['updateManifestUrl'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => { queueSaveConfig(); });
  });
  /* v4「连接与模型」合并块：预设切换 / 单一 URL·Key·模型流 / 识别与测试按钮 */
  try { connectInit(); } catch (e) { console.warn('连接与模型初始化失败', e); }
  /* v1.8.0 B 域：搜索面板挂载（纯新增 #searchPanel；功能分级开关默认开，
   * 关闭时 searchPanelInit 内部短路——try/catch 防单模块异常拖垮启动） */
  try { searchPanelInit(); } catch (e) { console.warn('搜索面板初始化失败', e); }
  /* v1.8.0：任务历史与回滚管理（设置区块动态注入；plan_list UI 入口） */
  try { checkpointMgrInit(); } catch (e) { console.warn('任务历史面板初始化失败', e); }
  /* v1.8.0：快捷键与命令帮助（? 键 + header 帮助钮） */
  try { shortcutsInit(); } catch (e) { console.warn('快捷键帮助初始化失败', e); }
  /* v1.8.0：长对话导航（输入区把手 → 最近消息浮层） */
  try { chatNavInit(); } catch (e) { console.warn('长对话导航初始化失败', e); }
  /* v1.8.0：输入区重构（+ 附件菜单 + 模型选择 chip） */
  try { inputPlusInit(); } catch (e) { console.warn('输入区重构初始化失败', e); }
  /* v1.9.0：平台探测与 macOS 适配层（自带 readyState 兜底，双安全） */
  try { if (typeof platformInit === 'function') platformInit(); } catch (e) { console.warn('平台适配初始化失败', e); }
  /* v1.8.0 S 域·外部软件 + H 域·混合路由 + v1.8.5 A 域·任务授权/白名单
   * （纯新增 #softwareBlock / #hybridBlock / #grantIndicator / #grantRulesBlock；
   * 各自 Init 内部幂等 + typeof 守卫，失败不阻塞启动） */
  try { softwarePanelInit(); } catch (e) { console.warn('外部软件面板初始化失败', e); }
  /* v1.8.0 W10：记忆面板挂载（softwarePanelInit 之后；内部幂等 + typeof 守卫） */
  try { memoryPanelInit(); } catch (e) { console.warn('记忆面板初始化失败', e); }
  try { if (typeof uiGenerativeSettingsInit === 'function') uiGenerativeSettingsInit(); }
  catch (e) { console.warn('生成式UI设置初始化失败', e); }
  try { hybridInit(); } catch (e) { console.warn('混合路由初始化失败', e); }
  try { guardGrantInit(); } catch (e) { console.warn('任务授权面板初始化失败', e); }
  /* v1.9.0 M2.1/2.5：审批预算指示条（grant-budget）+ 读取器状态灯
   * （reader-status）——挂载在授权条/页头区，内部幂等 + typeof 守卫，
   * 旧后端无对应 js_api 时自动隐藏（行为不劣化） */
  try { renderGrantBudgetBar(); } catch (e) { console.warn('审批预算条初始化失败', e); }
  try { refreshReaderBadge(); } catch (e) { console.warn('读取器状态灯初始化失败', e); }
  /* v1.9.0 M3.8/M6.10：浏览器驱动面板（brw-mode）挂载 + 平台探测后端数据源
   * （get_platform_info → data-platform 根类权威化）；幂等 + typeof 守卫 */
  try { if (typeof browserDriverPanelInit === 'function') browserDriverPanelInit(); }
  catch (e) { console.warn('浏览器驱动面板初始化失败', e); }
  try { if (typeof refreshPlatformInfo === 'function') refreshPlatformInfo(); }
  catch (e) { console.warn('平台探测刷新失败', e); }
  document.getElementById('enableSearch').addEventListener('change', function () {
    document.getElementById('searchEngineWrap').style.display = this.checked ? 'flex' : 'none';
    queueSaveConfig();
  });
  updateLabels();
  window.addEventListener('dragover', e => { e.preventDefault(); });
  window.addEventListener('drop', e => {
    e.preventDefault();
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    for (const f of files) {
      const lower = f.name.toLowerCase();
      if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(lower)) handleFiles([f], 'image');
      else if (/\.(mp4|mov|avi|mkv|webm)$/i.test(lower)) handleFiles([f], 'video');
      else if (/\.(zip)$/i.test(lower)) handleFiles([f], 'zip');
      else handleFiles([f], 'text');
    }
    document.getElementById('userInput').focus();
  });
  const ta = document.getElementById('userInput');
  ta.addEventListener('focus', updateCostEstimate);   // v1.2 R5：输入框聚焦时刷新预估花费
  ta.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 160) + 'px';
    updateCostEstimate();
  });
  ta.addEventListener('keydown', function (e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  ta.addEventListener('paste', function (e) {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          const dt = new DataTransfer();
          dt.items.add(file);
          if (file.type.startsWith('image/')) handleFiles(dt.files, 'image');
          else if (file.type.startsWith('video/')) handleFiles(dt.files, 'video');
          else if (/\.(zip)$/i.test(file.name)) handleFiles(dt.files, 'zip');   // 复核修正：大小写不敏感（原 endsWith('.zip') 漏 X.ZIP）
          else if (/\.(rar|7z)$/i.test(file.name))
            toast('仅支持 zip 压包；rar/7z 请先转成 zip，或解压后用「添加文本文件」选取。', 'warn');
          else handleFiles(dt.files, 'text');   // 二进制兜底由 readAttachmentText 的 NUL 检测拦截
        }
      }
    }
  });
  ['imgInput:image','vidInput:video','fileInput:text','zipInput:zip'].forEach(pair => {
    const [id, tp] = pair.split(':');
    document.getElementById(id).addEventListener('change', async e => {
      await handleFiles(e.target.files, tp); e.target.value = '';
    });
  });
  await loadSessions();
  try { loadProjects(); } catch (e) { /* project storage is optional/local-only */ }
  try { migrateWorkingRunStatuses(); } catch (e) { /* status migration is best-effort */ }
  let cfg = {};
  try {
    // P0-4 修正：HTTP 桥（Electron）同样读取真实 config——否则 API Key/模型
    // 等配置静默回落 localStorage 空值，用户发消息即失败
    if ((window.pywebview && window.pywebview.api) || window.HARBOR_API_BASE) {
      const raw = await Promise.race([
        callApi('get_config', []),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
      ]);
      cfg = JSON.parse(raw || '{}');
    }
  } catch (e) {}
  if (!cfg || Object.keys(cfg).length === 0) {
    try { cfg = JSON.parse(localStorage.getItem('glm_config') || '{}'); } catch (e) {}
  }
  if (cfg.api_key) document.getElementById('apiKey').value = cfg.api_key;
  else document.getElementById('settingsPanel').classList.add('show');
  if (cfg.temperature != null) document.getElementById('temperature').value = cfg.temperature;
  if (cfg.top_p != null) document.getElementById('topP').value = cfg.top_p;
  if (cfg.model) document.getElementById('modelSelect').value = cfg.model;
  const bm0 = document.getElementById('brandModel');
  if (bm0) bm0.textContent = document.getElementById('modelSelect').value;
  const ht0 = document.getElementById('headerTitle');
  if (ht0) ht0.textContent = document.getElementById('modelSelect').value;
  if (cfg.tool_mode) document.getElementById('toolMode').value = cfg.tool_mode;
  if (cfg.max_tokens != null) document.getElementById('maxTokens').value = cfg.max_tokens;
  if (cfg.reasoning_effort) document.getElementById('reasoningEffort').value = cfg.reasoning_effort;
  if (cfg.system_prompt != null) document.getElementById('systemPrompt').value = cfg.system_prompt;
  if (cfg.enable_search) document.getElementById('enableSearch').checked = true;
  if (cfg.search_engine) document.getElementById('searchEngine').value = cfg.search_engine;
  if (cfg.shot_quality) document.getElementById('shotQuality').value = cfg.shot_quality;
  if (cfg.saver_level) document.getElementById('saverLevel').value = cfg.saver_level;
  if (cfg.session_budget != null) document.getElementById('sessionBudget').value = cfg.session_budget;
  /* v1.2：回填更新源 + 安全护栏配置 */
  if (cfg.update_manifest_url) document.getElementById('updateManifestUrl').value = cfg.update_manifest_url;
  /* v4「连接与模型」单块：预设 + 单一 URL/Key/模型流回填（含旧配置一次性 seed 迁移，幂等） */
  try { connectLoadFromConfig(cfg); } catch (e) { console.warn('连接与模型回填失败', e); }
  try { loadLocalUI(cfg); } catch (e) {}   // v1.5 本地专属项（ctx 覆盖 / 工具调用；local_* 键回填）
  /* 修复（建议18）：桥依赖初始化提取为独立函数——loadAll 正常路径与
   * pywebviewready 晚到补偿（bridgeLateReady）共用。原三段（本地代理/护栏
   * 配置/get_api_info 自检）散在 loadAll 内，5s 回退分支（无桥）跑过后，
   * 桥晚到也无法补齐：护栏配置停在默认态、本地代理基址缺失、方法自检
   * 从未执行（backendWarning 恒 null，旧 exe 缺方法也不报警）。 */
  await bridgeDependentInit();
  // 实现 v1.6 T6：沙箱设置面板 + 状态灯（加载配置/状态；失败不阻塞启动）
  try { await loadSandboxPanel(); } catch (e) {}
  // 实现 v1.6 T11/T13：左侧主导航引导 + 空态引导 + 头部状态区 + 通知中心 + DND 回填
  try { loadDndSetting(); } catch (e) {}
  /* v1.8.0 W10：首次使用引导向导（无 Key+无会话时展示；localStorage 记住）
   * 修复：原在启动最前执行——彼时 sessions 未加载、Key 未回填，obShouldShow
   * 恒判「无会话+无 Key」误弹引导。移到 loadSessions 与 connectLoadFromConfig 之后。 */
  try { onboardingInit(); } catch (e) { console.warn('引导向导初始化失败', e); }
  try { navInit(); } catch (e) {}
  document.getElementById('searchEngineWrap').style.display = cfg.enable_search ? 'flex' : 'none';
  updateLabels();
  CS.syncAll();
  updateTokenStat();
  refreshWsCard();
  // 迁移期：岛层产物在册时先挂侧栏岛，随后 renderSessionList 走数据推流而非 DOM 重绘。
  // 产物缺失（旧 exe / 未构建）时返回 false，全链路保持 legacy 行为。
  if (typeof harborIslandMountSidebar === 'function') {
    try { harborIslandMountSidebar(); } catch (e) {}
  }
  renderSessionList();
  renderNewChatHistory();
  projectUiInit();
  if (typeof accessToggleInit === 'function') accessToggleInit();
  if (typeof accessToggleSync === 'function') accessToggleSync();
  // 分析数据在切换到面板时由 switchPanel 构建；首载聊天不重复扫描全部会话。
  checkForUpdate(false);   // v1.2 R1：启动后台静默检查更新（有新版本时右上角 pill 轻提示）
  if (sessions.length > 0) {
    const latest = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    switchSession(latest.id, true);   // v4：boot 首载静默重建（不走 swapping 淡出，避免开屏闪空容器）
  } else {
    openNewChatScreen();
  }
}

/* 桥依赖初始化（get_api_info 方法自检 + 本地 CORS 代理 + 护栏配置回填）。
 * 调用点：loadAll 正常路径（loadLocalUI 之后——localState 就绪，get_local_proxy
 * 的前置条件保持）与 pywebviewready 晚到补偿（bridgeLateReady）。
 * 无桥时各步骤静默跳过（与回退分支行为一致）；晚到补偿时桥已就绪，三步真实执行。 */
async function bridgeDependentInit() {
  // 实现 v1.6 HF-P0：本地 CORS 代理基址——后端补齐 ACAO 头，EdgeWebView 才读得到
  // 不输出 CORS 头的本地服务器（FreeToken/裸 llama.cpp/vLLM）响应；取不到静默
  // （resolveApiEndpoint 回落直连，行为不劣化）。
  try {
    const pr = JSON.parse(await callApi('get_local_proxy', []) || '{}');
    if (pr && pr.ok && pr.base_url) window.__localProxyBase = pr.base_url;
  } catch (e) {}
  try { await loadGuardConfig(); } catch (e) {}
  try {
    // P0-4 修正：HTTP 桥（Electron）同样执行方法自检——原 pywebview 门控使
    // 「等待后端就绪」状态行在 HTTP 桥下永不消除
    if ((window.pywebview && window.pywebview.api) || window.HARBOR_API_BASE) {
      let info = null;
      for (let attempt = 0; attempt < 3 && !info; attempt++) {
        try { info = JSON.parse(await callApi('get_api_info', [])); }
        catch (e) { if (attempt < 2) await new Promise(r => setTimeout(r, 800)); }
      }
      if (info) {
        const need = ['pick_folder','get_cwd','write_file','run_command','take_screenshot','open_app',
                      'get_memory','append_memory','get_worklog','append_worklog','save_workspace_file',
                      'build_tools','build_system_prompt','read_more','get_ws_state','cache_tool_output',
                      'get_clipboard','set_clipboard','list_processes','kill_process','open_url'];
        const missing = need.filter(m => !((info.methods || []).includes(m)));
        backendWarning = missing.length > 0
          ? '△ 后端缺少方法: ' + missing.join(', ') + '（exe 为旧版，请重新打包）'
          : null;
      } else {
        backendWarning = '△ 后端 get_api_info 调不通，请重新打包';
      }
    }
  } catch (e) {}
}
