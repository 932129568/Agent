/* ================= Resume 恢复机制（Round 16，2026-11-05 主理人立项） =================
 * 主理人要求：「完整实现 resume 机制，并在全部功能场景中完整运用，确保中断后
 * 可接续且状态一致。」
 *
 * 盘点结论（本文件只管【主对话 Agent 任务】这一环）：
 * - 截断（length）→ 自动续跑 ≤5 次（run-controller 已有，continueLastGeneration）
 * - abort → W21 已固化部分正文 + fillMissingToolResults 配平 + runStatus=paused
 * - 群聊接力 → phase/turn/mentionQueue 持久化 + 「继续接力」（Round 13/15 已闭环）
 * - **网络断流（error 路径）→ 部分正文丢弃、tool_calls 不配平、runStatus=failed、
 *   无恢复入口** ← 本模块补齐的主缺口
 *
 * 组成：
 * 1. isResumableError(msg)：错误分类——网络/超时/5xx/429 可恢复（重试有意义）；
 *    401/余额/参数类确定性失败不可恢复（继续只会再失败，人话提示已足够）。
 * 2. shouldOfferResume(s)：会话是否值得显示恢复横幅——runStatus=paused 且消息流
 *    停在 assistant/tool（任务进行中被打断的特征）；空会话/自然完成不弹。
 * 3. resumeBannerMount(box, s, actions)：恢复横幅 DOM（继续任务 / 放弃）。
 * 4. persistResumeState(s, ok)：放弃时把状态收敛为 completed（normalize 白名单
 *   接受），继续时交给 continueLastGeneration（run-controller）。
 *
 * 状态一致性保证：继续 = runAgentLoop 重入。历史里 assistant.tool_calls 已被
 * fillMissingToolResults 配平（error 路径新增同样调用），模型看到的是合法
 * OpenAI 消息序列，从挂起点自然续写；不重发用户原文（防重复计费/重复执行）。

/** 错误分类：可恢复（网络层/限流/服务端临时故障）返回 true。 */
function isResumableError(msg) {
  const m = String(msg || '');
  return /(Failed to fetch|NetworkError|network|timeout|timed? ?out|socket|ECONN|EPIPE|fetch failed|HTTP 5\d\d|HTTP 429|aborted|连接|超时|限流)/i.test(m)
    && !/HTTP 40[13]:/i.test(m);   // 401/403 确定性失败；400 已由 degrade 链处理
}

/** 会话是否应显示恢复横幅。纯函数（不碰 DOM）。 */
function shouldOfferResume(s) {
  if (!s || !s.messages || !s.messages.length) return false;
  if (s.runStatus !== 'paused') return false;   // failed=确定性失败/群聊恢复另有入口
  const last = s.messages[s.messages.length - 1];
  if (!last) return false;
  // 任务进行中被切断的特征：最后一条是 assistant（可能带已配平 tool_calls）
  // 或 tool 结果（下一轮模型调用没跑）。自然完成的会话最后一条也是 assistant，
  // 但 runStatus 会是 completed，不会走到这里。
  return last.role === 'assistant' || last.role === 'tool';
}

/** 恢复横幅。actions = { onContinue, onDismiss }；DOM 桩安全（全部 typeof 守卫）。 */
function resumeBannerMount(box, s, actions) {
  if (!box || !box.appendChild || !shouldOfferResume(s)) return null;
  const round = (s._resumeRound != null) ? s._resumeRound
    : (s.messages.filter(m => m.role === 'assistant').length);
  const el = document.createElement('div');
  el.id = 'resumeBanner';
  el.className = 'resume-banner';
  if (el.setAttribute) el.setAttribute('role', 'status');   // DOM 桩安全
  el.innerHTML =
    '<span class="rb-ico">⚡</span>' +
    '<span class="rb-text"></span>' +
    '<span style="flex:1"></span>' +
    '<button type="button" class="rb-btn rb-continue">▸ 继续任务</button>' +
    '<button type="button" class="rb-btn rb-dismiss">放弃</button>';
  const textEl = el.querySelector('.rb-text');
  textEl.textContent =
    '上次任务在第 ' + round + ' 轮被中断，已输出内容与工具状态均已保留';
  el.__textEl = textEl;   // 桩的 querySelector 每次返回新元素——测试读侧通道
  const dismiss = () => {
    if (el.parentNode) el.parentNode.removeChild(el);
    persistResumeState(s, false);
    if (actions && typeof actions.onDismiss === 'function') { try { actions.onDismiss(); } catch (e) {} }
  };
  // onclick 赋值（与 run-controller contBtn 同款）；具名函数同时挂元素本体
  // __continue/__dismiss（__ 前缀约定，同 bubble.__finish）——DOM 桩的
  // querySelector 每次返回新元素，程序化触发/测试走侧通道
  const onContinue = () => {
    if (el.parentNode) el.parentNode.removeChild(el);
    if (actions && typeof actions.onContinue === 'function') { try { actions.onContinue(); } catch (e) {} }
  };
  el.querySelector('.rb-continue').onclick = onContinue;
  el.querySelector('.rb-dismiss').onclick = dismiss;
  el.__continue = onContinue;
  el.__dismiss = dismiss;
  // DOM 桩安全：真实容器 insertBefore；桩（无此方法）退化为 appendChild
  if (box.insertBefore) box.insertBefore(el, box.firstChild);
  else box.appendChild(el);
  return el;
}

/** 放弃 → 收敛为 completed（normalize 白名单内；不再弹横幅）。 */
function persistResumeState(s, resuming) {
  if (!s) return;
  if (!resuming) {
    s.runStatus = 'completed';
    try { if (typeof saveSessions === 'function') saveSessions(); } catch (e) {}
  }
}
