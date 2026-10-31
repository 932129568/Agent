/* ================= 工具运行边界：Guard、写串行与原序结果 ================= */
const WRITE_SEQ_TOOLS = ['write_file', 'append_file', 'search_replace',
  'move_path', 'copy_path', 'delete_path'];

function createToolRuntime(options) {
  const handlers = options || {};
  const execute = async (call, context) => {
    if (handlers.guard) {
      const verdict = await handlers.guard(call, context);
      if (verdict === false || (verdict && verdict.allow === false)) {
        return { id: call.id, name: call.name,
          content: JSON.stringify({ skipped: true, error: {
            code: 'GUARD_DENIED', message: '工具执行被 Guard 拒绝' } }) };
      }
    }
    if (!handlers.executeTool) throw new Error('ToolRuntime.executeTool 未注入');
    const value = await handlers.executeTool(call, context);
    if (value && typeof value === 'object' && value.id && value.content !== undefined) return value;
    return { id: call.id, name: call.name, content: value };
  };
  return Object.freeze({
    load: handlers.loadTools || (async () => []),
    execute,
    async executeBatch(calls, context) {
      if (handlers.executeBatch) return handlers.executeBatch(calls, context);
      const results = [];
      let pending = calls.slice();
      while (pending.length) {
        const seqIndex = pending.findIndex(call => WRITE_SEQ_TOOLS.includes(call.name));
        const batch = seqIndex >= 0 ? pending.slice(0, seqIndex + 1) : pending;
        results.push(...await Promise.all(batch.map(call => execute(call, context))));
        pending = pending.slice(batch.length);
      }
      return results;
    },
  });
}
