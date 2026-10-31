/* ================= 配置 ================= */
function collectConfig() {
  return {
    api_key: document.getElementById('apiKey').value,
    /* v4 合并块：模型可能是手动态（文本框），统一经 connectModelValue 取值 */
    model: (typeof connectModelValue === 'function' ? connectModelValue() : '') ||
      document.getElementById('modelSelect').value || 'auto',
    temperature: parseFloat(document.getElementById('temperature').value),
    top_p: parseFloat(document.getElementById('topP').value),
    max_tokens: parseInt(document.getElementById('maxTokens').value),
    reasoning_effort: document.getElementById('reasoningEffort').value,
    system_prompt: document.getElementById('systemPrompt').value,
    enable_search: document.getElementById('enableSearch').checked,
    tool_mode: document.getElementById('toolMode').value,
    search_engine: document.getElementById('searchEngine').value,
    shot_quality: document.getElementById('shotQuality').value,
    saver_level: document.getElementById('saverLevel').value,
    session_budget: parseFloat(document.getElementById('sessionBudget').value) || 0,
    /* v1.2 R1/R6 → v4 单端点：更新源 + provider_* 主键组（预设 id/base_url/key/model/prices） */
    update_manifest_url: (document.getElementById('updateManifestUrl') || {}).value || '',
    ...collectProviderConfig(),
    /* v1.5 本地模型：local_* 键（运行期合法、测试期不触发——契约红线同 provider_*） */
    ...collectLocalConfig()
  };
}
/* ================= 智能档：模型 + 推理力度自动路由（v1.1.1 省 token） =================
 * 思路：思考(reasoning) token 按输出计价，是最贵的部分。轻任务不该开思考。
 * 模型保持最省的 flash；力度按任务复杂度分三档自动调节，用户也可手动锁定。
 * v4：智能档只在「智谱 GLM 预设」下出现（模型下拉首项）；其他预设模型名是实义值，
 * 直接透传（不参与自动路由），推理力度由端点能力决定是否发送。
 */
const HEAVY_HINTS = /重构|架构|调试|排查|报错|错误|异常|分析|实现|优化|设计|算法|推导|证明|方案|对比|性能|安全|迁移|兼容|代码|函数|接口|数据库|正则|并发|测试|部署|review/i;
function resolveModelEffort(text, hasAttach) {
  const picked = (typeof connectModelValue === 'function') ? connectModelValue() : '';
  const modelSel = picked || (document.getElementById('modelSelect') || {}).value || 'auto';
  const effEl = document.getElementById('reasoningEffort');
  const effSel = (effEl && effEl.value) || 'auto';
  if (modelSel !== 'auto') {
    return { model: modelSel, effort: effSel === 'auto' ? 'low' : effSel, auto: false, tier: '手动' };
  }
  const t = String(text || '');
  const heavy = !!hasAttach || HEAVY_HINTS.test(t) || t.length > 200;
  if (heavy) return { model: 'glm-5.3-flash', effort: 'medium', auto: true, tier: '重任务' };
  if (t.length > 40) return { model: 'glm-5.3-flash', effort: 'low', auto: true, tier: '标准' };
  return { model: 'glm-5.3-flash', effort: 'off', auto: true, tier: '轻任务' };
}
function sessionBudget() {
  const el = document.getElementById('sessionBudget');
  return el ? (parseFloat(el.value) || 0) : 0;
}
let saveCfgTimer = null;
function queueSaveConfig() { clearTimeout(saveCfgTimer); saveCfgTimer = setTimeout(saveConfig, 400); }
async function saveConfig() {
  const cfg = JSON.stringify(collectConfig());
  // 修复 W29：密钥字段不再明文双写 localStorage（api_key/provider_key 仅走后端 config.json；
  // 后端不可用时本地回退无密钥，用户需重填——安全取舍）
  let localCfg = cfg;
  try {
    const c = JSON.parse(cfg);
    delete c.api_key;
    delete c.provider_key;
    localCfg = JSON.stringify(c);
    // 修复 ㊸（三轮）：序列化异常时原样写回 cfg（含密钥明文进 localStorage）——
    // 异常路径改为写空对象，绝不回退含密钥版本
  } catch (e) { localCfg = '{}'; }
  try { localStorage.setItem('glm_config', localCfg); } catch (e) {}
  try {
    if (window.pywebview && window.pywebview.api) await callApi('save_config', [cfg]);
  } catch (e) { toast('配置保存到本机失败：' + e.message, 'warn'); }   // v1.2 R3：静默吞错 → 可见
}
