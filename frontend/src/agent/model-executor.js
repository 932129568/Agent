/* ================= 共享模型 ↔ 工具执行器（无 DOM/全局 active） ================= */
async function modelExecutorExecute(request) {
  const context = request.context;
  const messages = context.messages;
  const observer = request.observer || {};
  const runtime = request.tools;
  const transport = request.transport || ModelTransport;
  const signal = request.signal;
  const limits = request.limits || {};
  const maxRounds = limits.maxRounds || 60;
  const newMessages = [];
  const allToolCalls = [];
  let content = '';
  let usage = null;
  let finishReason = null;
  let partialContent = '';
  let modelTurns = 0;
  let status = 'running';
  let error = null;
  let terminal = {};

  const isActive = () => !(signal && signal.aborted) &&
    (!observer.isActive || observer.isActive(context));
  const stopWith = (control, fallback) => {
    terminal = control || {};
    status = (control && control.status) || fallback;
  };

  try {
    for (let round = 0; round < maxRounds; round++) {
      if (!isActive()) { status = 'cancelled'; break; }
      const prepared = observer.beforeRound
        ? await observer.beforeRound({ context, round, newMessages }) : { body: request.body };
      if (prepared && prepared.stop) {
        stopWith(prepared, 'stopped');
        break;
      }
      let body = prepared.body;
      let response = await transport.stream(Object.assign({}, request.endpoint, prepared, {
        body,
      }), signal);
      if (!response.ok && response.status === 400) {
        const errorText = await response.text().catch(() => '');
        const degraded = degradeChatBodyFor400(body, errorText);
        if (!degraded) throw new Error(`HTTP 400: ${errorText}`);
        if (observer.onDegrade) observer.onDegrade(degraded, errorText);
        response = await transport.stream(Object.assign({}, request.endpoint, prepared, {
          body,
        }), signal);
      }
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        let hdrMap = null;
        try {
          if (response.headers && typeof response.headers.forEach === 'function') {
            hdrMap = {};
            response.headers.forEach((value, key) => { hdrMap[key] = value; });
          }
        } catch (e) { hdrMap = null; }
        const httpError = new Error(`HTTP ${response.status}: ${errorText}`);
        httpError.headers = hdrMap;
        throw httpError;
      }
      const parsed = await parseSseStream(response.body, {
        round,
        onChunk: observer.onChunk,
        onBatch: observer.onBatch,
        onEvent: observer.onEvent,
        onDelta: (delta, current) => {
          partialContent = current.content;
          if (observer.onDelta) observer.onDelta(delta, current, context);
        },
        onFinishReason: observer.onFinishReason,
        onUsage: observer.onUsage,
      });
      modelTurns++;
      if (!isActive()) { status = 'cancelled'; break; }
      content = parsed.content;
      usage = parsed.usage;
      finishReason = parsed.finishReason;
      const toolCalls = Object.values(parsed.toolCallMap);
      const assistant = { role: 'assistant', content: content || null };
      if (usage) assistant.usage = Object.assign({}, usage, { model: prepared.model });
      if (toolCalls.length) {
        assistant.tool_calls = toolCalls.map(call => ({
          id: call.id, type: 'function',
          function: { name: call.name, arguments: call.argsStr },
        }));
      }
      newMessages.push(assistant);
      messages.push(assistant);
      allToolCalls.push(...toolCalls);
      const assistantControl = observer.onAssistant
        ? await observer.onAssistant({ assistant, parsed, toolCalls, round, context, newMessages })
        : null;
      if (assistantControl && assistantControl.stop) {
        stopWith(assistantControl, 'stopped');
        break;
      }
      if (!toolCalls.length) {
        status = finishReason === 'length' ? 'length' : 'completed';
        break;
      }
      const results = await runtime.executeBatch(toolCalls, {
        context, round, assistant, signal,
      });
      if (!isActive()) { status = 'cancelled'; break; }
      const toolMessages = results.map(result => ({
        role: 'tool', tool_call_id: result.id,
        content: result.content, __tool: result.name,
      }));
      newMessages.push(...toolMessages);
      messages.push(...toolMessages);
      const toolControl = observer.onToolResults
        ? await observer.onToolResults({ results, toolCalls, round, context, newMessages })
        : null;
      if (toolControl && toolControl.stop) {
        stopWith(toolControl, 'stopped');
        break;
      }
      if (!isActive()) { status = 'cancelled'; break; }
      if (round === maxRounds - 1) status = 'limit';
    }
    if (status === 'running') status = 'limit';
  } catch (caught) {
    error = caught;
    status = caught && caught.name === 'AbortError' ? 'cancelled' : 'error';
    if (observer.onError) observer.onError(caught, context);
  }
  return Object.assign({
    status, content, newMessages, usage, modelTurns,
    toolCalls: allToolCalls, finishReason, error, partialContent,
  }, terminal);
}

const ModelExecutor = Object.freeze({ execute: modelExecutorExecute });
