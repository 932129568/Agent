/* G3 explicit model generation coordinator using the shared ModelExecutor. */
function uiGenerationMessages(kind, fallbackSpec, feedback, raw, answerText) {
  const actionRule = typeof UiGenerativeSettings !== 'undefined' && UiGenerativeSettings.actionsEnabled
    ? '低危动作仅允许 copy/export/refresh，仍需用户点击和宿主权限。' : 'actions 必须为空数组。';
  const system = [
    '你是 Harbor 生成式 UI 结构器，目标是产出**信息设计出色、视觉层次丰富**的界面结构，而不是把文字搬进框里。',
    '输出仅为逐行完整 JSON envelope，不要 Markdown、解释、HTML、JS、CSS、URL 或动作。',
    '每行形状：{"schemaVersion":1,"layout":"card-grid","title":"可选","block":{"blockId":"稳定语义ID","component":"StatTile","props":{},"actions":[]}}。',
    '布局限：' + UI_LAYOUTS.join('、') + '。组件限：' + UI_COMPONENTS.join('、') + '。',
    '',
    '组件选型指南（按信息性质选，禁止全用 TextBlock 堆字）：',
    '· StatTile：2-6 个关键指标并排大数字卡（数值+标签+涨跌 delta）。任何「概览/汇总」首选。',
    '· Progress：多条进度条（label+percent 0-100+status）。展示完成度、占比、达成率。',
    '· Checklist：可打卡清单（text+checked）。计划、待办、训练日/购物清单类内容首选。',
    '· Timeline：带状态的时间线（title+time+description+status）。步骤、日程、里程碑。',
    '· BarChart：横向条形对比（label+value 数值）。多项目数量对比。',
    '· Card：图文卡片（title+body+fields 键值对），group 可嵌 children 子块。',
    '· KeyValue：紧凑键值明细。Chips：标签/要点罗列。Table：规整二维数据。',
    '· Callout：info/success/warning/error 强调提示（注意事项、关键结论）。',
    '· SectionHeader：分节标题（text+sub），把长页面切成可扫读的节。',
    '',
    '排版原则：①开篇用 StatTile/SectionHeader 立骨架，禁止以大段 TextBlock 开头；',
    '②数值信息一律进 StatTile/Progress/BarChart，不要写在句子里；',
    '③并列要点用 Checklist/Chips，不要用长段落；④风险与结论用 Callout 突出；',
    '⑤layout 用 card-grid/two-column 制造并排层次；⑥blocks 6-12 个为佳，宁丰富勿寒酸。',
    '',
    'DataRef 只能使用当前输入中列出的 source/selector/scope/entityId；数字和正文由宿主绑定，不得写入 props 冒充真实数据。',
    '每行必须能独立 JSON.parse；不要输出半块；不要重复 blockId。' + actionRule,
    '',
    '示例（第 1 行展示 StatTile 用法，实际按场景组合 6-12 行）：',
    '{"schemaVersion":1,"layout":"card-grid","title":"训练概览","block":{"blockId":"overview.stats","component":"StatTile","props":{"items":[{"label":"周训练量","value":"5 天","delta":"↑ 1 天","deltaTone":"up"},{"label":"总时长","value":"4.5 小时"},{"label":"消耗","value":"3200 kcal"}]},"actions":[]}}',
  ].join('\n');
  const user = (answerText
    ? '需要转换的助手回答全文（数据唯一来源，不要编造、不要遗漏关键信息）：\n' + answerText + '\n\n'
    : '') +
    '场景：' + kind + '\n当前手写默认 UiSpec（仅结构参考，不是业务数据）：\n' +
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
      attempt ? attempts[attempt - 1].raw : '', options.answerText);
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
          // P0-4 真机修正：端点快照由调用方注入（时序上晚于 provider.js 的宿主
          // 用 uiEndpointSnapshot() 取真实密钥——controller 在 provider 之前,
          // 内联快照的 apiKey 全局恒空 → 生成调用 401,计划卡 AI生成从未真正可用）
          endpoint: options.endpoint,
          answerText: options.answerText,
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
