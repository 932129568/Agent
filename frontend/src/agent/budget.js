/* ================= 成本失控防御（v1.2 R4） =================
 * 硬停语义（PRD Q2 采纳方案）：预算触达 → 不再发起新请求，进行中的工具调用跑完即停。
 * 三维熔断：同工具同参数 ×3 / 连续 15 步无进展 → 暂停并询问用户。
 * 暂停面板三选项：提高预算（断点续跑）/ 终止会话（保留上下文）/ 只读模式继续。
 * 状态按「一次 runAgentLoop 任务」为生命周期，进入循环前 resetCostDefense()。
 */

let _cd = null;
function resetCostDefense() {
  _cd = { sigCounts: new Map(), noProgressRounds: 0, lastFacts: 0 };
}

/** 预算硬停检查点（每轮 fetch 前调用）。返回 {stop, spent, budget} 或 null。 */
function checkBudgetHardStop(s) {
  const budget = sessionBudget();
  if (budget <= 0) return null;
  // 修复 S8（二轮）：读会话单调花费计数器（sessionSpent），压缩/归档不再把花费洗回预算线下
  const { cost } = sessionSpent(s);
  if (cost >= budget) return { stop: true, spent: cost, budget };
  return null;
}

/** 循环检测：登记本轮工具调用签名，第 3 次相同 → 返回 {loop:true, sig}。 */
function registerToolSig(sig) {
  if (!_cd) resetCostDefense();
  const n = (_cd.sigCounts.get(sig) || 0) + 1;
  _cd.sigCounts.set(sig, n);
  if (n >= 3) return { loop: true, count: n, sig };
  return null;
}

/** 无进展检测：连续 15 个工具轮次既无新产出（taskFacts 不增长）也无正文 → 返回 {stall:true}。 */
function registerProgress(factsLen, contentLen) {
  if (!_cd) resetCostDefense();
  if (factsLen > _cd.lastFacts || contentLen > 0) {
    _cd.lastFacts = Math.max(_cd.lastFacts, factsLen);
    _cd.noProgressRounds = 0;
    return null;
  }
  _cd.noProgressRounds++;
  if (_cd.noProgressRounds >= 15) { _cd.noProgressRounds = 0; return { stall: true }; }
  return null;
}

/** 暂停面板：追加在当前 AI 消息流末尾，按 kind 渲染选项。 */
function showPausePanel(aiContent, s, kind, info) {
  const panel = document.createElement('div');
  panel.className = 'pause-panel';
  const resume = () => {
    const apiKey = effectiveApiKey();
    if (!apiKey) { toast('请先设置 API Key', 'warn'); return; }
    continueLastGeneration(s, apiKey);
  };
  if (kind === 'budget') {
    panel.innerHTML =
      '<div class="pause-title">⛔ 会话预算已用尽，已暂停</div>' +
      '<div class="pause-body">本会话已花费 <b>¥' + (info.spent || 0).toFixed(4) + '</b> / 预算 <b>¥' +
      (info.budget || 0).toFixed(2) + '</b>。进行中的工具调用已跑完，未再发起新请求。</div>' +
      '<div class="pause-btns">' +
      '<button class="pause-btn primary" data-act="raise">提高预算并继续</button>' +
      '<button class="pause-btn" data-act="ro">只读模式继续</button>' +
      '<button class="pause-btn" data-act="stop">终止会话</button></div>';
    panel.querySelector('[data-act=raise]').onclick = async () => {
      const v = await uiPrompt({ title: '提高预算', body: '输入新的单会话预算（¥，0 = 不再提醒）：', value: String(info.budget * 2 || 2), type: 'number' });
      if (v == null || v === '') return;
      const el = document.getElementById('sessionBudget');
      if (el) { el.value = v; }
      queueSaveConfig();
      toast('预算已调整为 ¥' + v + '，从断点继续', 'ok');
      panel.remove();
      resume();
    };
    panel.querySelector('[data-act=ro]').onclick = () => {
      const sel = document.getElementById('toolMode');
      if (sel) sel.value = 'readonly';
      queueSaveConfig();
      addSysTip('工具权限 → 只读，下一回合生效（仅对话，不执行工具）');
      panel.remove();
      resume();
    };
    panel.querySelector('[data-act=stop]').onclick = () => {
      panel.querySelector('.pause-btns').innerHTML = '<span class="pause-note">会话已终止，上下文已保留，可导出或新开对话继续。</span>';
      toast('会话已终止（上下文保留）', 'ok');
    };
  } else if (kind === 'loop') {
    let sigPreview = '';
    try { sigPreview = JSON.parse(info.sig).map(x => x[0]).join(' → '); } catch (e) {}
    panel.innerHTML =
      '<div class="pause-title">⚠ 检测到循环工具调用，已熔断</div>' +
      '<div class="pause-body">同一工具以相同参数已连续发起 <b>' + info.count + '</b> 次：<br><code>' +
      escapeHtml(sigPreview.slice(0, 200)) + '</code><br>已自动暂停以防持续扣费。</div>' +
      '<div class="pause-btns">' +
      '<button class="pause-btn" data-act="continue">我已手动指引，继续</button>' +
      '<button class="pause-btn primary" data-act="stop">终止</button></div>';
    panel.querySelector('[data-act=continue]').onclick = () => { panel.remove(); resume(); };
    panel.querySelector('[data-act=stop]').onclick = () => {
      panel.querySelector('.pause-btns').innerHTML = '<span class="pause-note">已终止。上下文保留，可换个问法继续。</span>';
    };
  } else {
    panel.innerHTML =
      '<div class="pause-title">⚠ 连续多步无进展，已熔断</div>' +
      '<div class="pause-body">连续 15 轮工具调用既无新产出也无正文，疑似空转，已自动暂停。</div>' +
      '<div class="pause-btns">' +
      '<button class="pause-btn" data-act="continue">继续</button>' +
      '<button class="pause-btn primary" data-act="stop">终止</button></div>';
    panel.querySelector('[data-act=continue]').onclick = () => { panel.remove(); resume(); };
    panel.querySelector('[data-act=stop]').onclick = () => {
      panel.querySelector('.pause-btns').innerHTML = '<span class="pause-note">已终止。上下文保留。</span>';
    };
  }
  aiContent.appendChild(panel);
  document.getElementById('chatContainer').scrollTop = document.getElementById('chatContainer').scrollHeight;
}
