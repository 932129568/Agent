/* G2 registered DataRefResolver. Host supplies read/permission/revision/provenance. */
const UI_DATA_REF_SELECTORS = Object.create(null);
function uiDataRefError(code) {
  return { ok: false, code, error: code };
}
const UI_TOOL_RESULT_READERS = Object.freeze(['mcp_list_servers', 'get_memory', 'plan_get']);
const UI_TOOL_RESULT_LIMITS = Object.freeze({ bytes: 128 * 1024, depth: 8, nodes: 2048, arrayLength: 200 });
function uiToolContentBytes(content) {
  try {
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    return text === undefined ? 0 : new TextEncoder().encode(text).length;
  } catch (error) { return -1; }
}
function uiToolPayloadWithin(value) {
  if (!value || typeof value !== 'object') return true;
  const seen = new WeakSet();
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    if (current.depth > UI_TOOL_RESULT_LIMITS.depth || ++nodes > UI_TOOL_RESULT_LIMITS.nodes) return false;
    const item = current.value;
    if (!item || typeof item !== 'object') continue;
    if (seen.has(item)) return false;
    seen.add(item);
    if (Array.isArray(item) && item.length > UI_TOOL_RESULT_LIMITS.arrayLength) return false;
    const values = Array.isArray(item) ? item : Object.values(item);
    values.forEach(child => {
      if (child && typeof child === 'object') stack.push({ value: child, depth: current.depth + 1 });
      else nodes++;
    });
  }
  return nodes <= UI_TOOL_RESULT_LIMITS.nodes;
}
function uiToolResultEntry(ref, identity) {
  const app = typeof AppState !== 'undefined' && AppState.uiGenerative;
  const production = app && app.toolResults && app.toolResults[ref.toolCallId];
  const entry = production || (globalThis.__uiToolResults || {})[ref.toolCallId];
  if (!entry) return null;
  // Production entries always carry identity; only the explicit legacy test adapter may omit it.
  if (production && (entry.runId !== identity.runId || entry.sessionId !== identity.sessionId)) return null;
  if (entry.runId && entry.runId !== identity.runId) return null;
  if (entry.sessionId && entry.sessionId !== identity.sessionId) return null;
  return entry;
}
function registerUiToolResult(result, context) {
  if (!result || !result.id || result.content === undefined || !context ||
      !UI_TOOL_RESULT_READERS.includes(result.name) || context.runId === undefined || !context.sessionId) {
    return 0;
  }
  const bytes = uiToolContentBytes(result.content);
  if (bytes < 0 || bytes > UI_TOOL_RESULT_LIMITS.bytes) return 0;
  let value;
  try { value = typeof result.content === 'string' ? JSON.parse(result.content) : result.content; }
  catch (error) { return 0; }
  if (!uiToolPayloadWithin(value)) return 0;
  const store = uiGenerativeStore();
  const entry = {
    value, runId: String(context.runId), sessionId: String(context.sessionId),
    generation: context.generation === undefined ? 0 : context.generation,
    allowed: true, toolName: result.name, revision: ++store.toolRevision,
  };
  store.lastRun = { runId: entry.runId, sessionId: entry.sessionId, generation: entry.generation };
  store.toolResults[result.id] = entry;
  const keys = Object.keys(store.toolResults);
  while (keys.length > 32) delete store.toolResults[keys.shift()];
  return entry.revision;
}
function uiDataRefHash(value) {
  let hash = 2166136261;
  const text = String(value == null ? '' : value);
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
function uiMemoryText(item) {
  if (item == null) return '';
  if (typeof item === 'string') return item;
  if (typeof item === 'object' && typeof item.text === 'string') return item.text;
  try { return JSON.stringify(item); } catch (error) { return String(item); }
}
function uiMemoryEntityId(item, index) {
  if (item && (item.entityId != null || item.id != null)) {
    return 'memory-' + String(item.entityId != null ? item.entityId : item.id);
  }
  const actualIndex = item && Number.isInteger(item.index) ? item.index : index;
  return 'memory-' + actualIndex + '-' + uiDataRefHash(uiMemoryText(item));
}
function uiRedactFields(value, key) {
  if (key && /(?:secret|password|passwd|api[_-]?key|credential|private[_-]?key|access[_-]?token|refresh[_-]?token|env|headers)/i.test(key)) {
    return '[redacted]';
  }
  if (typeof value === 'string') {
    return value.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
      .replace(/\b(?:api[_-]?key|secret|password)\s*[:=]\s*\S+/gi, '[redacted]');
  }
  if (Array.isArray(value)) return value.map(item => uiRedactFields(item));
  if (value && typeof value === 'object') {
    const output = {};
    Object.entries(value).forEach(([childKey, child]) => {
      output[childKey] = uiRedactFields(child, childKey);
    });
    return output;
  }
  return value;
}
function registerDataRefSelector(selector, definition) {
  if (!definition || !['array', 'object', 'scalar'].includes(definition.type) ||
      typeof definition.scope !== 'string' || typeof definition.map !== 'function' ||
      typeof definition.entityKey !== 'function') {
    throw new Error('data_ref_selector_incomplete');
  }
  if (UI_DATA_REF_SELECTORS[selector]) throw new Error('duplicate_data_ref_selector');
  UI_DATA_REF_SELECTORS[selector] = definition;
}
function uiDataRefProvenance(ref, revision, host) {
  const result = { source: ref.source, selector: ref.selector, scope: ref.scope || '', revision };
  if (ref.toolCallId) result.toolCallId = ref.toolCallId;
  if (ref.resultRevision !== undefined) result.resultRevision = ref.resultRevision;
  try {
    const extra = host.provenance(ref);
    if (extra && typeof extra === 'object') {
      ['runId', 'sessionId', 'taskId', 'entityId'].forEach(key => {
        if (typeof extra[key] === 'string' || typeof extra[key] === 'number') result[key] = String(extra[key]);
      });
    }
  } catch (error) {}
  return result;
}
function resolveDataRef(ref, host, component) {
  if (!ref || typeof ref !== 'object' || !host) return uiDataRefError('forbidden');
  const definition = UI_DATA_REF_SELECTORS[ref.selector];
  if (!definition || ref.scope !== definition.scope) return uiDataRefError('forbidden');
  if (ref.source === 'tool' && !ref.toolCallId) return uiDataRefError('forbidden');
  if (ref.source === 'tool' && ref.resultRevision === undefined) return uiDataRefError('stale');
  if (typeof host.permission !== 'function' || typeof host.read !== 'function' ||
      typeof host.revision !== 'function' || typeof host.provenance !== 'function') {
    return uiDataRefError('forbidden');
  }
  let permission;
  try { permission = host.permission(ref); } catch (error) { return uiDataRefError('forbidden'); }
  if (permission !== true) return uiDataRefError('forbidden');
  let revision;
  try { revision = host.revision(ref); } catch (error) { return uiDataRefError('stale'); }
  if (!Number.isInteger(revision) || revision < 0) return uiDataRefError('stale');
  if (ref.resultRevision !== undefined && ref.resultRevision !== revision) {
    return uiDataRefError('stale');
  }
  let value;
  try { value = host.read(ref); } catch (error) {
    return uiDataRefError(error && error.code === 'forbidden' ? 'forbidden' : 'not_found');
  }
  if (value && value.ok === false && value.code) return uiDataRefError(value.code);
  if (value == null) return uiDataRefError('not_found');
  if (definition.type === 'array' && !Array.isArray(value)) return uiDataRefError('type_mismatch');
  if (definition.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
    return uiDataRefError('type_mismatch');
  }
  let selected = value;
  let selectedIndex;
  if (ref.entityId !== undefined) {
    if (typeof definition.select !== 'function') return uiDataRefError('not_found');
    const found = definition.select(value, ref.entityId);
    if (!found || found.item == null) return uiDataRefError('not_found');
    selected = found.item;
    selectedIndex = found.index;
  }
  let mapped;
  try { mapped = definition.map(selected, ref, host, component, selectedIndex); } catch (error) {
    return uiDataRefError('type_mismatch');
  }
  if (mapped == null) return uiDataRefError('not_found');
  return {
    ok: true,
    value: uiRedactFields(mapped),
    revision,
    entityKey: ref.entityId || definition.entityKey(selected, ref),
    entityKeys: typeof definition.entityKeys === 'function' ? definition.entityKeys(selected, ref, host) : undefined,
    provenance: uiDataRefProvenance(ref, revision, host),
  };
}
function injectDataRef(block, resolved) {
  if (!resolved || !resolved.ok) return { ok: false, code: resolved && resolved.code || 'not_found' };
  const descriptor = UiComponentRegistry.get(block.component);
  if (!descriptor || descriptor.bindProp == null) return { ok: false, code: 'type_mismatch' };
  const props = Object.assign({}, block.props || {});
  if (descriptor.bindProp === '$props') {
    if (!resolved.value || typeof resolved.value !== 'object' || Array.isArray(resolved.value)) {
      return { ok: false, code: 'type_mismatch' };
    }
    Object.assign(props, resolved.value);
    if (resolved.entityKey) props.entityKey = resolved.entityKey;
  } else {
    props[descriptor.bindProp] = resolved.value;
    if (resolved.entityKeys && descriptor.bindProp === 'items' && Array.isArray(resolved.value)) {
      props[descriptor.bindProp] = resolved.value.map((item, index) => Object.assign({}, item, {
        entityKey: resolved.entityKeys[index],
      }));
    }
    if (resolved.entityKeys && descriptor.bindProp === 'rows') props.rowEntities = resolved.entityKeys;
  }
  return { ok: true, block: Object.assign({}, block, { props }) };
}

registerDataRefSelector('plan.current', {
  type: 'object', scope: 'current-plan',
  entityKey: value => 'plan:' + String(value.task_id || value.taskId || 'current'),
  entityKeys: value => ['plan:' + String(value.task_id || value.taskId || 'current')],
  map(value, ref, host, component) {
    const taskId = String(value.task_id || value.taskId || 'current');
    const title = String(value.title || '任务计划');
    const status = String(value.status || 'pending');
    const fields = [{ label: '任务 ID', value: taskId }, { label: '状态', value: status }];
    return component === 'KeyValue' ? { items: fields } : { title, fields, status: 'normal' };
  },
});
registerDataRefSelector('plan.steps', {
  type: 'array', scope: 'current-plan',
  entityKey: value => 'plan-steps:' + String(value.length),
  entityKeys: (value, ref, host) => {
    let task = 'current';
    try { task = host.provenance(ref).taskId || 'current'; } catch (error) {}
    const occurrences = Object.create(null);
    return value.map(step => {
      const realId = step.id || step.stepId || step.key;
      const text = String(step.text || step.title || '').trim().replace(/\s+/g, ' ');
      const occurrence = occurrences[text] || 0;
      occurrences[text] = occurrence + 1;
      const stableKey = realId !== undefined && realId !== null && realId !== ''
        ? String(realId) : uiDataRefHash(text) + '-' + occurrence;
      return 'plan-' + uiDataRefHash(task) + '-step-' + stableKey;
    });
  },
  map(value, ref, host, component) {
    const items = value.map((step, index) => ({
      title: String(step.text || step.title || '步骤 ' + (index + 1)),
      description: step.description == null ? undefined : String(step.description),
      time: step.time == null ? undefined : String(step.time),
      status: ['pending', 'doing', 'done', 'blocked', 'skipped'].includes(step.status) ? step.status : 'pending',
    }));
    return component === 'Table' ? items.map(item => [item.title, item.status]) : items;
  },
});
registerDataRefSelector('mcp.servers', {
  type: 'array', scope: 'mcp-servers',
  entityKey: () => 'mcp-servers',
  entityKeys: (value, ref) => Array.isArray(value)
    ? value.map(server => 'mcp-' + String(server.name))
    : [ref.entityId || 'mcp-' + String(value.name)],
  select(value, entityId) {
    const index = value.findIndex(item => String(item.name) === String(entityId));
    return index < 0 ? null : { item: value[index], index };
  },
  map(value, ref, host, component, selectedIndex) {
    const one = ref.entityId !== undefined;
    const rows = (one ? [value] : value).map(server => [
      String(server.name || ''), String(server.transport || 'stdio'),
      Number.isFinite(server.tool_count) ? server.tool_count : 0,
      String(server.status || 'untested'),
    ]);
    if (component === 'Card') {
      if (one) return { title: String(value.name || 'MCP 服务器'), fields: [
        { label: '传输', value: String(value.transport || 'stdio') },
        { label: '状态', value: String(value.status || 'untested') },
      ], status: 'normal' };
      return { title: 'MCP 概览', fields: [
        { label: '服务器数', value: value.length },
        { label: '已启用', value: value.filter(item => item.enabled).length },
      ], status: 'normal' };
    }
    return rows;
  },
});
registerDataRefSelector('memory.items', {
  type: 'array', scope: 'memory',
  entityKey: () => 'memory-items',
  entityKeys: (value, ref) => Array.isArray(value)
    ? value.map((item, index) => uiMemoryEntityId(item, index))
    : [ref.entityId || uiMemoryEntityId(value, 0)],
  select(value, entityId) {
    const index = value.findIndex((item, i) => uiMemoryEntityId(item, i) === String(entityId));
    return index < 0 ? null : { item: value[index], index };
  },
  map(value, ref, host, component, selectedIndex) {
    const index = selectedIndex == null ? 0 : selectedIndex;
    if (ref.entityId !== undefined) {
      return { title: '记忆 #' + (index + 1), body: uiMemoryText(value),
        fields: value && value.ts ? [{ label: '时间', value: String(value.ts) }] : [], status: 'normal' };
    }
    return value.map((item, i) => ({
      title: '记忆 #' + (i + 1), description: uiMemoryText(item),
      time: item && item.ts ? String(item.ts) : undefined, status: 'done',
    }));
  },
});

const DataRefResolver = Object.freeze({
  register: registerDataRefSelector,
  resolve: resolveDataRef,
  inject: injectDataRef,
  selectors() { return Object.keys(UI_DATA_REF_SELECTORS); },
});
