/* ================= Agent 主循环 ================= */
function setSendButtonVisual(button, state) {
  if (!button) return;
  const icon = state === 'stop' ? 'stop' : (state === 'pause' ? 'pause' : 'send');
  const label = state === 'stop' ? '停止生成' : (state === 'pause' ? '正在停止' : '发送消息');
  button.innerHTML = '<svg class="ui-icon ui-icon-20" aria-hidden="true"><use href="#i-' + icon + '"></use></svg>';
  if (button.setAttribute) button.setAttribute('aria-label', label);
}

/* 实现 v1.6 T10③：流式速度文本（tokens/s）。
 * 有 usage（completion_tokens）→ 精确值；无 usage（本地/Ollama 常见）→ 按字符
 * 估算（/1.8，与生成中 token 预估同口径）并在数字旁标「估」。
 * 纯函数（无 DOM 依赖）——vm 单模块沙箱可直接抽取测试。 */
function streamSpeedText(totalChars, elapsedMs, completionTokens) {
  const secs = (Number(elapsedMs) || 0) / 1000;
  if (secs < 0.5) return '';
  if (completionTokens && completionTokens > 0) {
    return '⚡ ' + (completionTokens / secs).toFixed(1) + ' tok/s';
  }
  const est = Math.ceil((Number(totalChars) || 0) / 1.8);
  return '⚡ ' + (est / secs).toFixed(1) + ' tok/s（估）';
}

/* 修复 S3（三轮）：暂停/中止后把悬挂 tool_calls 配平——assistant.tool_calls 与 tool
 * 消息必须一一对应，否则会话被毒化、后续每轮 HTTP 400。暂停 break（工具批未跑完）
 * 与 AbortError 两条路径共用本函数（原只在 AbortError 分支内联处理）。
 * 修复 fe-H1（四轮）：原只检查「末条消息是否为带 tool_calls 的 assistant」——暂停的
 * 主场景（部分批次已执行、末条是 tool 结果）守卫不成立、配平 no-op，会话仍被毒化。
 * 改为回溯找最后一条 assistant 消息（无论其后有多少 tool 结果）再对 done 集配平。 */
function fillMissingToolResults(s, assistantMsg) {
  if (assistantMsg) {
    // 取消的旧 run 只能配平自己已落库的 assistant；即使同一会话已有新 run，
    // 也不能把旧 tool 结果追加到新 assistant 后面或误用新 run 的 tool_call_id。
    const assistantIndex = s.messages.indexOf(assistantMsg);
    if (assistantIndex < 0 || !assistantMsg.tool_calls || !assistantMsg.tool_calls.length) return;
    const done = new Set();
    let insertAt = assistantIndex + 1;
    while (insertAt < s.messages.length && s.messages[insertAt] &&
           s.messages[insertAt].role === 'tool') {
      done.add(s.messages[insertAt].tool_call_id);
      insertAt++;
    }
    assistantMsg.tool_calls.forEach(t => {
      if (!done.has(t.id)) {
        s.messages.splice(insertAt++, 0,
          { role: 'tool', tool_call_id: t.id, content: '（用户已停止，未执行）' });
      }
    });
    return;
  }
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (!m || m.role !== 'assistant') continue;
    if (!m.tool_calls || !m.tool_calls.length) return;   // 最近一条 assistant 无工具调用 → 无悬挂
    const done = new Set(s.messages.filter(x => x && x.role === 'tool').map(x => x.tool_call_id));
    m.tool_calls.forEach(t => {
      if (!done.has(t.id)) s.messages.push({ role: 'tool', tool_call_id: t.id, content: '（用户已停止，未执行）' });
    });
    return;
  }
}
