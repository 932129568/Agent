/* G2 handwritten UiSpec constructors and the existing-state host adapter. */
function uiFixtureId(value) {
  return String(value == null ? 'current' : value).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 110);
}
function uiActiveRunContext() {
  let active = null;
  try {
    if (typeof RunRegistry !== 'undefined' && RunRegistry.current) active = RunRegistry.current();
  } catch (error) {}
  const app = typeof AppState !== 'undefined' ? AppState : {};
  const sessionId = String(app.currentSessionId || 'current-session');
  const matchingActive = active && String(active.sessionId || '') === sessionId ? active : null;
  const last = app.uiGenerative && app.uiGenerative.lastRun;
  const matchingLast = last && String(last.sessionId || '') === sessionId ? last : null;
  const runId = matchingActive && matchingActive.id !== undefined ? String(matchingActive.id)
    : (matchingLast ? String(matchingLast.runId) : 'ui-generate');
  return { runId, sessionId, generation: matchingActive && matchingActive.id !== undefined
    ? matchingActive.id : (matchingLast && matchingLast.generation !== undefined ? matchingLast.generation : 1) };
}
function uiFixtureContext(options) {
  const source = options || {};
  const active = uiActiveRunContext();
  return {
    runId: source.runId !== undefined ? String(source.runId) : active.runId,
    sessionId: source.sessionId || active.sessionId,
    generation: source.generation === undefined ? active.generation : source.generation,
  };
}
function createUiDataRefHost(context) {
  const source = context || {};
  const active = uiActiveRunContext();
  const identity = {
    runId: source.runId !== undefined ? String(source.runId) : active.runId,
    sessionId: String(source.sessionId || active.sessionId),
    generation: source.generation === undefined ? active.generation : source.generation,
  };
  const read = ref => {
    if (ref.source === 'tool') {
      const entry = uiToolResultEntry(ref, identity);
      if (!entry) return undefined;
      if (ref.selector === 'mcp.servers') {
        return entry.value && Array.isArray(entry.value.servers) ? entry.value.servers : entry.value;
      }
      if (ref.selector === 'plan.current') return entry.value && (entry.value.plan || entry.value);
      if (ref.selector === 'plan.steps') {
        const plan = entry.value && (entry.value.plan || entry.value);
        return plan && plan.steps;
      }
      return entry.value;
    }
    if (ref.selector === 'plan.current') return typeof planCurrent !== 'undefined' ? planCurrent : undefined;
    if (ref.selector === 'plan.steps') return planCurrent && Array.isArray(planCurrent.steps) ? planCurrent.steps : undefined;
    if (ref.selector === 'mcp.servers') {
      return typeof AppState !== 'undefined' ? AppState.mcpServers :
        (typeof mcpServers !== 'undefined' ? mcpServers : undefined);
    }
    if (ref.selector === 'memory.items') return typeof mmLastItems !== 'undefined' ? mmLastItems : undefined;
    return undefined;
  };
  const revision = ref => {
    if (ref.source === 'tool') {
      const entry = uiToolResultEntry(ref, identity);
      return entry && Number.isInteger(entry.revision) ? entry.revision : -1;
    }
    if (ref.selector.startsWith('plan.')) return typeof planUiRevision === 'number' ? planUiRevision : 0;
    if (ref.selector === 'mcp.servers') return typeof mcpServersRevision === 'number' ? mcpServersRevision : 0;
    if (ref.selector === 'memory.items') return typeof memoryReqSeq === 'number' ? memoryReqSeq : 0;
    return -1;
  };
  const permission = ref => {
    if (ref.source === 'tool') {
      const entry = uiToolResultEntry(ref, identity);
      return !!(entry && entry.allowed === true &&
        (!entry.toolName || UI_TOOL_RESULT_READERS.includes(entry.toolName)));
    }
    return ref.source === 'appState' && (
      (ref.selector.startsWith('plan.') && ref.scope === 'current-plan') ||
      (ref.selector === 'mcp.servers' && ref.scope === 'mcp-servers') ||
      (ref.selector === 'memory.items' && ref.scope === 'memory')
    );
  };
  const provenance = ref => ({
    runId: identity.runId,
    sessionId: identity.sessionId,
    taskId: ref.selector.startsWith('plan.') && typeof planCurrent !== 'undefined' && planCurrent
      ? String(planCurrent.task_id || planCurrent.taskId || 'current') : undefined,
  });
  return { read, permission, revision, provenance, identity };
}
function uiFixtureBase(options, layout, specId, blocks) {
  const source = options || {};
  const context = uiFixtureContext(source);
  return Object.assign({
    schemaVersion: 1, specId: uiFixtureId(specId),
    revision: source.revision === undefined ? 0 : source.revision,
    layout, title: source.title, blocks,
  }, context);
}
const UiSpecFixtures = Object.freeze({
  plan(options) {
    const source = options || {};
    const plan = source.plan !== undefined ? source.plan :
      (typeof planCurrent !== 'undefined' ? planCurrent : null);
    const taskId = plan && (plan.task_id || plan.taskId) || 'current';
    const revision = source.revision === undefined
      ? (typeof planUiRevision === 'number' ? planUiRevision : 0) : source.revision;
    if (!plan || plan.error) {
      return uiFixtureBase(Object.assign({}, source, { revision, title: '计划进度' }), 'timeline',
        'plan-' + taskId, [{ blockId: 'plan-empty', component: 'EmptyState', props: {
          title: plan && plan.error ? '计划加载失败' : '暂无计划',
          body: plan && plan.error ? '请返回原始视图查看错误说明。' : '当前没有可显示的计划数据。',
        } }]);
    }
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    if (!steps.length) {
      return uiFixtureBase(Object.assign({}, source, { revision, title: '计划进度' }), 'timeline',
        'plan-' + taskId, [{ blockId: 'plan-empty', component: 'EmptyState', props: {
          title: '暂无计划步骤', body: '当前计划没有可显示的步骤。',
        } }]);
    }
    return uiFixtureBase(Object.assign({}, source, { revision, title: '计划进度' }), 'timeline',
      'plan-' + taskId, [
        { blockId: 'plan-summary', component: 'Card', props: {},
          bind: { source: 'appState', selector: 'plan.current', scope: 'current-plan' } },
        { blockId: 'plan-steps', component: 'Timeline', props: { title: '执行步骤' },
          bind: { source: 'appState', selector: 'plan.steps', scope: 'current-plan' } },
      ]);
  },
  mcp(options) {
    const source = options || {};
    const servers = source.servers !== undefined ? source.servers :
      (typeof AppState !== 'undefined' ? AppState.mcpServers : []);
    const revision = source.revision === undefined
      ? (typeof mcpServersRevision === 'number' ? mcpServersRevision : 0) : source.revision;
    if (source.error || !Array.isArray(servers) || !servers.length) {
      return uiFixtureBase(Object.assign({}, source, { revision, title: 'MCP 服务器' }), 'table-focus',
        'mcp-servers', [{ blockId: 'mcp-empty', component: 'EmptyState', props: {
          title: source.error ? 'MCP 列表加载失败' : '暂无 MCP 服务器',
          body: source.error ? '请使用原始视图重试。' : '添加服务器后，这里会显示真实状态。',
        } }]);
    }
    return uiFixtureBase(Object.assign({}, source, { revision, title: 'MCP 服务器' }), 'table-focus',
      'mcp-servers', [
        { blockId: 'mcp-summary', component: 'Card', props: {},
          bind: { source: 'appState', selector: 'mcp.servers', scope: 'mcp-servers' } },
        { blockId: 'mcp-table', component: 'Table', props: {
          columns: ['名称', '传输', '工具数', '状态'], pageSize: 10, caption: '真实服务器列表',
        }, bind: { source: 'appState', selector: 'mcp.servers', scope: 'mcp-servers' } },
      ]);
  },
  memory(options) {
    const source = options || {};
    const items = source.items !== undefined ? source.items :
      (typeof mmLastItems !== 'undefined' ? mmLastItems : []);
    const revision = source.revision === undefined
      ? (typeof memoryReqSeq === 'number' ? memoryReqSeq : 0) : source.revision;
    if (source.error || !Array.isArray(items) || !items.length) {
      return uiFixtureBase(Object.assign({}, source, { revision, title: '记忆' }), 'card-grid',
        'memory-items', [{ blockId: 'memory-empty', component: 'EmptyState', props: {
          title: source.error ? '记忆加载失败' : '暂无记忆',
          body: source.error ? '请使用原始视图重试。' : '添加第一条记忆后，这里会显示真实内容。',
        } }]);
    }
    const blocks = items.slice(0, 10).map((item, index) => ({
      blockId: 'memory-' + uiFixtureId(uiMemoryEntityId(item, index)),
      component: 'Card', props: {},
      bind: { source: 'appState', selector: 'memory.items', scope: 'memory',
        entityId: uiMemoryEntityId(item, index) },
    }));
    if (items.length > 10) {
      blocks.push({ blockId: 'memory-overflow', component: 'TextBlock', props: {
        text: '还有 ' + (items.length - 10) + ' 条记忆未显示，请使用原始视图搜索。',
      } });
    }
    return uiFixtureBase(Object.assign({}, source, { revision, title: '记忆' }), 'card-grid',
      'memory-items', blocks);
  },
});
