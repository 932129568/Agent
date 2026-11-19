/* Harbor UiSpec v1: structural validation only; permissions stay outside schema. */
const UI_LIMITS = Object.freeze({
  specBytes: 64 * 1024, blocks: 16, depth: 3, title: 200, text: 10000,
});
const UI_LAYOUTS = Object.freeze([
  'single-column', 'two-column', 'card-grid', 'table-focus', 'timeline',
]);
const UI_COMPONENTS = Object.freeze([
  'Table', 'Card', 'KeyValue', 'Timeline', 'BarChart', 'TextBlock', 'EmptyState', 'Skeleton',
  'StatTile', 'Progress', 'Checklist', 'Chips', 'Callout', 'SectionHeader',
]);
const UI_DATA_REF_SCHEMA = UiSchema.z.object({
  source: UiSchema.z.enum(['appState', 'tool', 'session', 'run', 'artifact']),
  selector: UiSchema.z.string().min(1).max(200),
  scope: UiSchema.z.string().min(1).max(128).optional(),
  toolCallId: UiSchema.z.string().min(1).max(128).optional(),
  resultRevision: UiSchema.z.number().int().nonnegative().optional(),
  entityId: UiSchema.z.string().min(1).max(200).optional(),
}).strict();
const UI_ACTION_REF_SCHEMA = UiSchema.z.object({
  name: UiSchema.z.enum(['copy', 'export', 'refresh']),
  args: UiSchema.z.record(UiSchema.z.string(), UiSchema.z.unknown()).optional(),
}).strict();
const UI_BLOCK_SCHEMA = UiSchema.z.lazy(() => UiSchema.z.object({
  blockId: UiSchema.z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  component: UiSchema.z.string().min(1).max(64),
  props: UiSchema.z.record(UiSchema.z.string(), UiSchema.z.unknown()).default({}),
  bind: UI_DATA_REF_SCHEMA.optional(),
  actions: UiSchema.z.array(UI_ACTION_REF_SCHEMA).max(2).default([]),
  children: UiSchema.z.array(UI_BLOCK_SCHEMA).max(UI_LIMITS.blocks).optional(),
}).strict());
const UI_SPEC_SCHEMA = UiSchema.z.object({
  schemaVersion: UiSchema.z.literal(1),
  specId: UiSchema.z.string().min(1).max(128),
  revision: UiSchema.z.number().int().nonnegative().default(0),
  runId: UiSchema.z.string().min(1).max(128).optional(),
  sessionId: UiSchema.z.string().min(1).max(128).optional(),
  generation: UiSchema.z.number().int().nonnegative().optional(),
  layout: UiSchema.z.enum(UI_LAYOUTS),
  title: UiSchema.z.string().max(UI_LIMITS.title).optional(),
  blocks: UiSchema.z.array(UI_BLOCK_SCHEMA).max(UI_LIMITS.blocks),
}).strict();

function uiValidationError(code, issues) {
  return { ok: false, error: { code, message: code, issues: issues || [] } };
}
function uiCheckJson(value, depth) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && value.length > UI_LIMITS.text) return 'text_overflow';
    return null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? null : 'non_finite_number';
  if (typeof value !== 'object' || depth > 12) return 'invalid_json_value';
  if (Array.isArray(value)) {
    for (const item of value) {
      const error = uiCheckJson(item, depth + 1);
      if (error) return error;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') return 'unsafe_key';
    const error = uiCheckJson(item, depth + 1);
    if (error) return error;
  }
  return null;
}
function uiInspectBlocks(blocks, level, state) {
  if (level > UI_LIMITS.depth) return 'depth_overflow';
  for (const block of blocks) {
    state.count++;
    if (state.count > UI_LIMITS.blocks) return 'blocks_overflow';
    if (state.ids.has(block.blockId)) return 'duplicate_block_id';
    state.ids.add(block.blockId);
    if (block.children) {
      const error = uiInspectBlocks(block.children, level + 1, state);
      if (error) return error;
    }
  }
  return null;
}
function validateUiSpec(input) {
  const jsonError = uiCheckJson(input, 0);
  if (jsonError) return uiValidationError(jsonError);
  let encoded;
  try { encoded = JSON.stringify(input); } catch (error) { return uiValidationError('invalid_json'); }
  if (typeof encoded !== 'string') return uiValidationError('invalid_json');
  if (new TextEncoder().encode(encoded).length > UI_LIMITS.specBytes) {
    return uiValidationError('spec_overflow');
  }
  const parsed = UI_SPEC_SCHEMA.safeParse(input);
  if (!parsed.success) {
    return uiValidationError('invalid_schema', parsed.error.issues.map(issue => ({
      path: issue.path, code: issue.code,
    })));
  }
  const state = { count: 0, ids: new Set() };
  const blockError = uiInspectBlocks(parsed.data.blocks, 1, state);
  if (blockError) return uiValidationError(blockError);
  return { ok: true, value: parsed.data, warnings: [] };
}
