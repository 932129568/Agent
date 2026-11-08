/* ================= 纯 SSE 流读取与聚合（无 DOM/状态存储） ================= */
async function parseSseStream(stream, hooks) {
  const options = hooks || {};
  const result = {
    content: '', reasoning: '', toolCallMap: {},
    usage: null, finishReason: null,
  };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const round = options.round == null ? 0 : options.round;
  let lastBucket = '0';
  let pending = '';

  const handleLine = line => {
    // R37 修复（D17）：SSE 规范允许 `data:{...}`（冒号后无空格）——原只认带
    // 空格形态，个别网关/供应商的整流内容被静默全丢。
    if (!line.startsWith('data:')) return;
    const data = (line.slice(5).startsWith(' ') ? line.slice(6) : line.slice(5)).trim();
    if (!data || data === '[DONE]') return;
    try {
      const json = JSON.parse(data);
      if (options.onEvent) options.onEvent(json, result);
      const delta = json.choices && json.choices[0] && json.choices[0].delta;
      if (delta && delta.reasoning_content) result.reasoning += delta.reasoning_content;
      if (delta && delta.content) result.content += delta.content;
      if (delta && delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          let idx;
          if (tc.index != null) idx = tc.index;
          else if (tc.function && tc.function.name) {
            idx = tc.function.name;
            lastBucket = idx;
          } else if (tc.id) idx = tc.id;
          else idx = lastBucket;
          if (!result.toolCallMap[idx]) {
            result.toolCallMap[idx] = {
              id: 'call_r' + round + '_' + String(idx).replace(/[^\w-]/g, ''),
              name: '', argsStr: '',
            };
          }
          if (tc.id) result.toolCallMap[idx].id = tc.id;
          if (tc.function && tc.function.name) result.toolCallMap[idx].name = tc.function.name;
          if (tc.function && tc.function.arguments) {
            result.toolCallMap[idx].argsStr += tc.function.arguments;
          }
        }
      }
      if (delta && options.onDelta) options.onDelta(delta, result);
      const finish = json.choices && json.choices[0] && json.choices[0].finish_reason;
      if (finish) {
        result.finishReason = finish;
        if (options.onFinishReason) options.onFinishReason(finish, result);
      }
      if (json.usage) {
        result.usage = json.usage;
        if (options.onUsage) options.onUsage(json.usage, result);
      }
    } catch (e) {}
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (options.onChunk) options.onChunk(value, result);
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop() || '';
    for (const line of lines) handleLine(line);
    if (options.onBatch) options.onBatch(result);
  }
  pending += decoder.decode();
  if (pending) handleLine(pending);
  return result;
}
