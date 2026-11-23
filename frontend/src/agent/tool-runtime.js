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

/* ================= R101 T03 · 工具类别（供轨迹与纠偏建议共用） =================
 * 为什么用**名称模式**而不是穷举清单：工具名由后端 build_tools 动态给出，
 * 前端硬编码一份全量清单必然与后端漂移（历史上 TOOLS 双源就是这么烂掉的）。
 * 模式匹配的好处是：新工具只要命名符合既有习惯就自动归类，不符合就老实落到 other，
 * 不会出现「清单里没有 ⇒ 假装它是文件工具」这种编造。
 * 'mcp' 单独一类：MCP 工具的失败语义与内置工具不同（多半是端点/鉴权问题），
 * 纠偏建议要分开给。
 */
function toolCategoryOf(name) {
  const n = String(name == null ? '' : name);
  if (!n) return 'other';
  if (n.indexOf('mcp__') === 0) return 'mcp';
  if (/^(read_|list_|write_|append_|search_replace|move_|copy_|delete_)/.test(n)) return 'file';
  if (/^(run_|kill_|exec_)/.test(n)) return 'shell';
  if (/^(browser_|open_|web_|fetch_)/.test(n)) return 'web';
  if (/(^|_)memory(_|$)/.test(n)) return 'memory';
  if (/^(clipboard_|take_screenshot|screenshot)/.test(n)) return 'ui';
  return 'other';
}

/** 类别的展示标签（中文短标签，直接进 DOM）。 */
function toolCategoryLabel(cat) {
  const map = { file: '文件', shell: '命令', web: '网络', memory: '记忆', ui: '界面', mcp: 'MCP', other: '其他' };
  return map[String(cat)] || '其他';
}
