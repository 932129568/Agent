/* G3 explicit model generation coordinator using the shared ModelExecutor. */
function uiGenerationMessages(kind, fallbackSpec, feedback, raw) {
  const actionRule = typeof UiGenerativeSettings !== 'undefined' && UiGenerativeSettings.actionsEnabled
    ? '低危动作仅允许 copy/export/refresh，仍需用户点击和宿主权限。' : 'actions 必须为空数组。';
  const system = [
    '你是 Harbor 生成式 UI 结构器。你只选择宿主白名单中的布局、组件和绑定，不编造业务数据。',
    '输出仅为逐行完整 JSON envelope，不要 Markdown、解释、HTML、JS、CSS、URL 或动作。',
    '每行形状：{"schemaVersion":1,"layout":"single-column","title":"可选","block":{"blockId":"稳定语义ID","component":"TextBlock","props":{},"actions":[]}}。',
    '布局限：' + UI_LAYOUTS.join('、') + '。组件限：' + UI_COMPONENTS.join('、') + '。',
    'DataRef 只能使用当前输入中列出的 source/selector/scope/entityId；数字和正文由宿主绑定，不得写入 props 冒充真实数据。',
    '每行必须能独立 JSON.parse；不要输出半块；不要重复 blockId。' + actionRule,
  ].join('\n');
  const user = '场景：' + kind + '\n当前手写默认 UiSpec（仅结构参考，不是业务数据）：\n' +
    JSON.stringify(fallbackSpec).slice(0, 12000) +
    (feedback ? '\n\n' + feedback + '\n原始输出：\n' + String(raw || '').slice(0, UI_ARTIFACT_LIMITS.feedbackChars) : '');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

function uiGenerationModel() {
  if (typeof providerState !== 'undefined' && providerState && providerState.model) return providerState.model;
  if (typeof localState !== 'undefined' && localState && localState.model) return localState.model;
  return '';
}

function createUiGenerationBody(options) {
  const normalizedMessages = typeof normalizeSystemMessages === 'function'
    ? normalizeSystemMessages(options.messages) : options.messages;
  const body = buildChatRequestBody({
    model: options.model || uiGenerationModel(), ['messages']: normalizedMessages,
    temperature: 0, topP: 1, maxTokens: 4096, effort: 'off',
    glm: typeof isGlmEndpoint === 'function' ? isGlmEndpoint() : false,
  });
  if (options.strictSchema) {
    body.response_format = { type: 'json_schema', json_schema: {
      name: 'harbor_ui_artifact', schema: UI_STRICT_JSON_SCHEMA, strict: true,
    } };
  }
  return body;
}

function createUiEndpointSnapshot() {
  return {
    endpoint: typeof resolveApiEndpoint === 'function' ? resolveApiEndpoint() : '',
    apiKey: typeof apiKey !== 'undefined' ? apiKey : '',
    local: typeof localState !== 'undefined' && !!(localState && localState.mode),
    proxyHeaders: typeof localProxyHeaders === 'function' ? localProxyHeaders() : {},
  };
}

function uiStrictSchemaUnsupported(result) {
  if (!result || result.status !== 'error') return false;
  const error = result.error || result;
  const parts = [];
  if (typeof error === 'string') parts.push(error);
  else if (error && typeof error === 'object') {
    ['name', 'code', 'message', 'text', 'body', 'detail'].forEach(key => {
      if (typeof error[key] === 'string') parts.push(error[key]);
    });
    try { parts.push(JSON.stringify(error)); } catch (caught) {}
  }
  const text = parts.join(' ').toLowerCase();
  if (/abort|cancel|timeout|network|fetch|tools_not_allowed/.test(text)) return false;
  return /response_format|json_schema|structured.?output|schema.*unsupported|unsupported.*schema/.test(text);
}

function productionUiGenerate(options) {
  return async ({ messages, signal, onText, strictSchema }) => {
    const endpoint = options.endpoint || createUiEndpointSnapshot();
    const execute = options.executor || ModelExecutor.execute;
    const run = async useStrict => execute({
      context: { messages, runId: options.runId || 'ui-generate',
        sessionId: options.sessionId || 'current-session', generation: options.generation || 1 },
      endpoint,
      transport: options.transport || ModelTransport,
      tools: { executeBatch: async () => { throw new Error('tools_not_allowed'); } },
      observer: {
        beforeRound: ({ context }) => ({ body: createUiGenerationBody({
          ['messages']: context.messages, model: options.model, strictSchema: useStrict,
        }) }),
        onDelta(delta) { if (delta && delta.content) onText(delta.content); },
        onAssistant({ toolCalls }) {
          return toolCalls.length ? { stop: true, status: 'error', error: { code: 'tools_not_allowed' } } : { stop: false };
        },
      },
      signal,
    });
    let result = await run(!!strictSchema);
    if (strictSchema && uiStrictSchemaUnsupported(result)) {
      const fallback = await run(false);
      fallback.schemaFallback = true;
      return fallback;
    }
    return result;
  };
}

async function generateUiSpec(options) {
  const kind = options.kind;
  const fallbackSpec = options.fallbackSpec;
  const dataRefHost = options.dataRefHost || createUiDataRefHost({
    runId: fallbackSpec.runId, sessionId: fallbackSpec.sessionId, generation: fallbackSpec.generation,
  });
  const signal = options.signal;
  const maxRepairs = options.maxRepairs === undefined ? 1 : options.maxRepairs;
  const generate = options.generate || productionUiGenerate(options);
  const baseRevision = (fallbackSpec.revision || 0) + 1;
  const pending = Object.assign({}, fallbackSpec, {
    revision: baseRevision,
    blocks: [{ blockId: 'generation-skeleton', component: 'Skeleton', props: { lines: 3 }, actions: [] }],
  });
  const projection = options.projection || UiProjection.mount(options.host, pending,
    { dataRefHost, focusTitle: false, actionHandlers: options.actionHandlers,
      actionPermission: options.actionPermission });
  if (options.projection) projection.commit(pending);
  const attempts = [];
  let lastError = null;
  let fallbackCommitted = false;
  const isActive = () => !(signal && signal.aborted) &&
    (typeof options.isActive !== 'function' || options.isActive() === true);
  const ownsHost = () => typeof options.ownsHost !== 'function' || options.ownsHost() === true;
  const canCommit = () => isActive() && ownsHost();
  const recordSemanticError = error => {
    if (error && error.code === 'unknown_component') {
      projection.metrics.unknown_component = (projection.metrics.unknown_component || 0) + 1;
    }
  };

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    if (signal && signal.aborted) {
      lastError = { code: 'cancelled' };
      break;
    }
    const revision = baseRevision + attempt;
    const accepted = [];
    const errors = [];
    let currentLayout = fallbackSpec.layout;
    let currentTitle = fallbackSpec.title;
    const stream = new UiArtifactStream();
    const messages = uiGenerationMessages(kind, fallbackSpec,
      attempt ? uiArtifactFeedback(lastError ? [lastError] : [], attempts[attempt - 1].raw) : null,
      attempt ? attempts[attempt - 1].raw : '');
    const onText = chunk => {
      if (!canCommit()) return;
      for (const item of stream.push(chunk)) {
        if (!canCommit()) return;
        const envelope = item.value;
        const candidate = Object.assign({}, fallbackSpec, {
          revision,
          layout: envelope.layout || currentLayout,
          title: envelope.title || currentTitle,
          blocks: accepted.concat([envelope.block]),
        });
        const checked = uiArtifactValidateCandidate(candidate, dataRefHost);
        if (!checked.ok) {
          recordSemanticError(checked.error);
          errors.push(checked.error || { code: 'invalid_candidate' });
          continue;
        }
        if (!canCommit()) return;
        accepted.push(envelope.block);
        currentLayout = candidate.layout;
        currentTitle = candidate.title;
        const committed = projection.commit(candidate);
        if (!committed.ok) errors.push({ code: committed.error || 'commit_rejected' });
      }
    };
    let result;
    try {
      result = await generate({ messages, signal, onText, strictSchema: !!options.strictSchema });
    } catch (error) {
      result = { status: 'error', error };
      errors.push({ code: String(error && error.message || 'model_error') });
    }
    if (!canCommit()) errors.push({ code: 'cancelled' });
    if (canCommit() && result && result.content && !stream.received) {
      // onDelta 已消费过正文；result.content 只用于未流式 fake/适配器。
      onText(result.content);
    }
    const finalErrors = stream.finish();
    errors.push(...finalErrors);
    if (result && result.status && !['completed', 'finished'].includes(result.status)) {
      errors.push({ code: result.error && result.error.code ? result.error.code : 'model_' + result.status });
    }
    const raw = stream.received;
    attempts.push({ attempt, raw, accepted: accepted.length, errors: errors.slice(),
      usage: result && result.usage, schemaFallback: !!(result && result.schemaFallback) });
    if (accepted.length && !errors.length && !stream.buffer && canCommit()) {
      const finalSpec = Object.assign({}, fallbackSpec, {
        revision, layout: currentLayout, title: currentTitle, blocks: accepted,
      });
      const checked = uiArtifactValidateCandidate(finalSpec, dataRefHost);
      if (checked.ok && canCommit()) {
        const committed = projection.commit(finalSpec);
        if (committed.ok && canCommit()) {
          return { status: 'completed', spec: finalSpec, projection, attempts,
            metrics: { acceptedBlocks: accepted.length, modelTurns: attempt + 1 } };
        }
        errors.push({ code: committed.error });
      } else {
        recordSemanticError(checked.error);
        errors.push(checked.error);
      }
    }
    lastError = errors[0] || { code: 'empty_artifact' };
  }

  const fallback = Object.assign({}, fallbackSpec, { revision: baseRevision + maxRepairs + 1 });
  if (!fallbackCommitted && ownsHost()) {
    fallbackCommitted = true;
    projection.commit(fallback);
  }
  return { status: !isActive() ? 'cancelled' : 'fallback',
    reason: !isActive() ? 'cancelled' : uiGenerationErrorCode(lastError),
    spec: fallback, projection, attempts,
    metrics: { acceptedBlocks: 0, modelTurns: attempts.length } };
}

function uiGenerationErrorCode(error) {
  return error && (error.code || (error.error && (error.error.code || error.error.message)) || error.message) || 'generation_failed';
}

function uiGenerationToast(message, kind) {
  if (typeof toast === 'function') toast(message, kind || 'info');
}

function createUiGenerationController(options) {
  let active = null;
  let sequence = 0;
  const finish = ticket => {
    if (!active || active.ticket !== ticket) return;
    active = null;
    if (options.button) options.button.disabled = false;
    if (options.cancelButton) options.cancelButton.hidden = true;
  };
  const cancel = () => {
    if (!active) return false;
    const current = active;
    active = null;
    if (options.button) options.button.disabled = false;
    if (options.cancelButton) options.cancelButton.hidden = true;
    current.controller.abort();
    uiGenerationToast('已取消 AI 视图生成', 'info');
    return true;
  };
  const start = () => {
    if (active) return active.promise;
    const ticket = ++sequence;
    const controller = new AbortController();
    const fallbackSpec = typeof options.fallback === 'function' ? options.fallback() : options.fallback;
    if (options.button) options.button.disabled = true;
    if (options.cancelButton) options.cancelButton.hidden = false;
    const run = (async () => {
      let result;
      try {
        result = await generateUiSpec({
          kind: options.kind, fallbackSpec, host: options.host,
          dataRefHost: options.dataRefHost || createUiDataRefHost({
            runId: fallbackSpec.runId, sessionId: fallbackSpec.sessionId,
            generation: fallbackSpec.generation,
          }),
          signal: controller.signal, generate: options.generate,
          strictSchema: options.strictSchema === undefined
            ? (typeof UiGenerativeSettings !== 'undefined' && UiGenerativeSettings.strictSchema)
            : options.strictSchema === true,
          actionHandlers: options.actionHandlers, actionPermission: options.actionPermission,
          isActive: () => ticket === sequence,
          ownsHost: () => ticket === sequence,
          maxRepairs: options.maxRepairs,
        });
      } catch (error) {
        result = { status: 'fallback', reason: 'generation_failed', projection: null };
      }
      if (ticket !== sequence || controller.signal.aborted) {
        return Object.assign({}, result, { status: 'cancelled', reason: 'cancelled' });
      }
      finish(ticket);
      if (typeof options.onResult === 'function') options.onResult(result);
      if (result.status === 'completed' && result.attempts && result.attempts.some(attempt => attempt.schemaFallback)) {
        uiGenerationToast('端点不支持 strictSchema，已回退普通 JSON', 'info');
      } else if (result.status === 'completed') uiGenerationToast('AI 视图生成完成', 'ok');
      else if (result.status === 'cancelled') uiGenerationToast('已取消 AI 视图生成', 'info');
      else uiGenerationToast('AI 输出未通过校验，已使用手写默认视图', 'warn');
      return result;
    })();
    active = { ticket, controller, promise: run };
    return run;
  };
  return { start, cancel, isBusy: () => !!active };
}
