/* G3 bounded complete-block artifacts: JSONL envelopes, schema + business validation. */
const UI_ARTIFACT_LIMITS = Object.freeze({ rawBytes: 128 * 1024, feedbackChars: 4096 });
const UI_ARTIFACT_ENVELOPE_SCHEMA = UiSchema.z.object({
  schemaVersion: UiSchema.z.literal(1),
  layout: UiSchema.z.enum(UI_LAYOUTS).optional(),
  title: UiSchema.z.string().max(UI_LIMITS.title).optional(),
  block: UiSchema.z.object({
    blockId: UiSchema.z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    component: UiSchema.z.string().min(1).max(64),
    props: UiSchema.z.record(UiSchema.z.string(), UiSchema.z.unknown()).default({}),
    bind: UI_DATA_REF_SCHEMA.optional(),
    actions: UiSchema.z.array(UI_ACTION_REF_SCHEMA).max(2).default([]),
  }).strict(),
}).strict();

function uiArtifactError(code, message) {
  return { ok: false, error: { code, message: message || code } };
}

function uiArtifactUtf8Length(text) {
  return new TextEncoder().encode(text).length;
}

function uiArtifactValidateEnvelope(value) {
  const parsed = UI_ARTIFACT_ENVELOPE_SCHEMA.safeParse(value);
  if (!parsed.success) {
    return uiArtifactError('invalid_envelope', parsed.error.issues.map(issue =>
      issue.path.join('.') + ':' + issue.code).join(';'));
  }
  return { ok: true, value: parsed.data };
}

class UiArtifactStream {
  constructor() {
    this.buffer = '';
    this.received = '';
    this.objects = [];
    this.errors = [];
    this.finished = false;
  }
  push(chunk) {
    if (this.finished || typeof chunk !== 'string' || !chunk) return [];
    this.received += chunk;
    if (uiArtifactUtf8Length(this.received) > UI_ARTIFACT_LIMITS.rawBytes) {
      this.errors.push(uiArtifactError('spec_overflow'));
      this.finished = true;
      return [];
    }
    // Markdown fence 仅是传输包装；除此之外不允许模型附加解释或脚本。
    this.buffer += chunk.replace(/^```(?:json)?\s*$/gmu, '');
    const emitted = [];
    let cursor = 0;
    while (cursor < this.buffer.length) {
      const start = this.buffer.indexOf('{', cursor);
      if (start < 0) {
        const rest = this.buffer.slice(cursor);
        if (rest.trim() && !rest.includes('}')) {
          this.errors.push(uiArtifactError('invalid_envelope'));
          this.buffer = '';
        }
        break;
      }
      const prefix = this.buffer.slice(cursor, start);
      if (prefix.trim()) {
        this.errors.push(uiArtifactError('invalid_envelope'));
        this.buffer = this.buffer.slice(start);
        cursor = 0;
        continue;
      }
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;
      for (let index = start; index < this.buffer.length; index++) {
        const char = this.buffer[index];
        if (escaped) { escaped = false; continue; }
        if (char === '\\' && inString) { escaped = true; continue; }
        if (char === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (char === '{') depth++;
        else if (char === '}') {
          depth--;
          if (depth === 0) { end = index; break; }
          if (depth < 0) break;
        }
      }
      if (end < 0) break; // 半 block 不调用 JSON.parse。
      const raw = this.buffer.slice(start, end + 1);
      try {
        const value = JSON.parse(raw);
        const validated = uiArtifactValidateEnvelope(value);
        if (validated.ok) emitted.push({ value: validated.value, raw });
        else this.errors.push(validated);
      } catch (error) {
        this.errors.push(uiArtifactError('invalid_json', String(error && error.message || error)));
      }
      cursor = end + 1;
      this.buffer = this.buffer.slice(cursor);
      cursor = 0;
    }
    this.objects.push(...emitted);
    return emitted;
  }
  finish() {
    this.finished = true;
    if (this.buffer.trim()) this.errors.push(uiArtifactError('incomplete_block'));
    this.buffer = '';
    return this.errors;
  }
}

function uiArtifactValidateSemantics(block, dataRefHost) {
  const descriptor = UiComponentRegistry.get(block.component);
  if (!descriptor) return uiArtifactError('unknown_component');
  const props = block.props || {};
  const businessCard = block.component === 'Card' && (props.body ||
    (Array.isArray(props.fields) && props.fields.length) || props.entityKey ||
    (props.status && props.status !== 'normal'));
  if ((['Table', 'KeyValue', 'Timeline', 'BarChart'].includes(block.component) || businessCard) && !block.bind) {
    return uiArtifactError('binding.missing');
  }
  let resolved = block;
  if (block.bind) {
    const result = DataRefResolver.resolve(block.bind, dataRefHost, block.component);
    if (!result.ok) return uiArtifactError('binding.' + (result.code || 'not_found'));
    const injected = DataRefResolver.inject(block, result);
    if (!injected.ok) return uiArtifactError('binding.type_mismatch');
    resolved = injected.block;
  }
  const parsed = descriptor.schema.safeParse(resolved.props || {});
  if (!parsed.success) return uiArtifactError('invalid_props');
  if (block.children && block.children.length) {
    for (const child of block.children) {
      const checked = uiArtifactValidateSemantics(child, dataRefHost);
      if (!checked.ok) return checked;
    }
  }
  return { ok: true };
}

function uiArtifactValidateCandidate(spec, dataRefHost) {
  const validated = validateUiSpec(spec);
  if (!validated.ok) return validated;
  for (const block of spec.blocks) {
    const checked = uiArtifactValidateSemantics(block, dataRefHost);
    if (!checked.ok) return checked;
  }
  return { ok: true, value: validated.value };
}

function uiArtifactFeedback(errors, raw) {
  const codes = errors.map(error => '- ' + (error.code || (error.error && error.error.code) || 'invalid'));
  return '上一次输出未通过校验。仅修复以下问题并重新输出完整 JSONL，不要解释：\n' +
    codes.join('\n') + '\n原始输出（截断）：\n' + String(raw || '').slice(0, UI_ARTIFACT_LIMITS.feedbackChars);
}

const UI_STRICT_JSON_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'block'],
  properties: {
    schemaVersion: { const: 1 },
    layout: { type: 'string', enum: UI_LAYOUTS },
    title: { type: 'string', maxLength: UI_LIMITS.title },
    block: {
      type: 'object', additionalProperties: false,
      required: ['blockId', 'component', 'props', 'actions'],
      properties: {
        blockId: { type: 'string', minLength: 1, maxLength: 64 },
        component: { type: 'string', minLength: 1, maxLength: 64 },
        props: { type: 'object' },
        bind: {
          type: 'object', additionalProperties: false,
          required: ['source', 'selector', 'scope'],
          properties: {
            source: { type: 'string', enum: ['appState', 'tool'] },
            selector: { type: 'string', maxLength: 200 },
            scope: { type: 'string', maxLength: 128 },
            toolCallId: { type: 'string', maxLength: 128 },
            resultRevision: { type: 'integer', minimum: 0 },
            entityId: { type: 'string', maxLength: 200 },
          },
        },
        actions: { type: 'array', maxItems: 2,
          items: { type: 'object', additionalProperties: false,
            required: ['name'], properties: {
              name: { type: 'string', enum: ['copy', 'export', 'refresh'] },
              args: { type: 'object' },
            } } },
      },
    },
  },
});
