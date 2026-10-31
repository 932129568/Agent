/* W5B single-agent controller; no Team tools, DOM observer or second active run. */
class ExpertUsageLedger {
  constructor() { this.byMessage = {}; this.applied = new Set(); }
  record(messageId, usage) {
    if (!messageId || !usage || this.byMessage[messageId]) return false;
    this.byMessage[messageId] = expertClone(usage);
    return true;
  }
  apply(session, messageId, usage) {
    if (!usage || this.applied.has(messageId)) return;
    this.applied.add(messageId);
    if (typeof accumulateUsage === 'function') accumulateUsage(session, usage);
  }
  result(fallback) {
    if (!Object.keys(this.byMessage).length && fallback) this.byMessage.run = expertClone(fallback);
    const totals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    Object.values(this.byMessage).forEach(usage => {
      totals.prompt_tokens += Number(usage.prompt_tokens || 0);
      totals.completion_tokens += Number(usage.completion_tokens || 0);
      totals.total_tokens += Number(usage.total_tokens ||
        (usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
    });
    return { byMessage: this.byMessage, totals };
  }
}
function createExpertEndpointSnapshot() {
  const provider = typeof providerState !== 'undefined' ? providerState : {};
  const local = typeof localState !== 'undefined' ? localState : {};
  return {
    endpoint: typeof resolveApiEndpoint === 'function' ? resolveApiEndpoint() : '',
    apiKey: typeof apiKey !== 'undefined' ? apiKey : '',
    model: provider.model || local.model || '',
    local: !!local.mode,
    proxyHeaders: typeof localProxyHeaders === 'function' ? localProxyHeaders() : {},
  };
}
function expertSessionForRun(sessionId) {
  const app = typeof AppState !== 'undefined' ? AppState : null;
  const list = app ? app.sessions : (typeof sessions !== 'undefined' ? sessions : []);
  let session = list.find(item => item.id === sessionId);
  if (!session) {
    session = { id: sessionId, title: '', createdAt: Date.now(), updatedAt: Date.now(), ['messages']: [] };
    list.push(session);
  }
  return session;
}
class ExpertRunController {
  constructor(options) {
    const source = options || {};
    this.store = source.store || new ExpertPackageStore({ call: source.call });
    this.transport = source.transport;
    this.endpoint = source.endpoint;
    this.executor = source.executor || ModelExecutor.execute;
    this.hostTools = source.hostTools || [];
    this.hostAllowed = source.hostAllowed;
    this.executeBatch = source.executeBatch;
    this.executeTool = source.executeTool;
    this.onEvent = source.onEvent;
    this.save = source.save;
    this.lastRunId = null;
  }
  async start(selection, draft) {
    if (!selection) return { status: 'ordinary', skipped: true };
    const choice = expertSelection(selection);
    const requestDraft = expertDraft(draft);
    const app = typeof AppState !== 'undefined' ? AppState : {};
    if (app.currentSessionId && requestDraft.sessionId !== String(app.currentSessionId)) {
      return { status: 'error', error: { code: 'EXPERT_SESSION_NOT_CURRENT', message: '专家选择不能跨会话继承' } };
    }
    const previous = RunRegistry.current();
    const session = expertSessionForRun(requestDraft.sessionId);
    const run = RunRegistry.start({ id: requestDraft.sessionId });
    const parentRunId = requestDraft.parentRunId || (previous && previous.id) || this.lastRunId || null;
    const abort = new AbortController();
    run.abortController = abort;
    const journal = new ExpertEventJournal(session, { save: this.save });
    const ledger = new ExpertUsageLedger();
    const refs = [];
    let actor;
    let snapshot;
    let assistantSequence = 0;
    let toolCount = 0;
    const owns = () => RunRegistry.isCurrent(run) && !abort.signal.aborted;
    const deadline = Date.now() + 30 * 60 * 1000;
    try {
      snapshot = await this.store.get(choice.packageId, choice.snapshotId);
      actor = await this.store.loadActor(snapshot, choice.agentId);
      const skill = await this.store.loadSkill(snapshot, choice.skillName, choice.resourcePaths);
      if (snapshot.kind === 'team') {
        const orchestrator = new TeamOrchestrator({ store: this.store,
          hostTools: this.hostTools, hostAllowed: this.hostAllowed,
          executeBatch: this.executeBatch, executeTool: this.executeTool, onEvent: this.onEvent });
        return await orchestrator.execute({ run, session, snapshot, actor, skill,
          draft: requestDraft, choice, parentRunId, journal, ledger, refs,
          endpoint: this.endpoint || createExpertEndpointSnapshot(),
          transport: this.transport || ModelTransport, executor: this.executor });
      }
      const context = ActorContext.create({ snapshot, actor, skill, draft: requestDraft, run,
        hostTools: this.hostTools, hostAllowed: this.hostAllowed,
        executeBatch: this.executeBatch, executeTool: this.executeTool });
      const maxTurns = Math.min(40, snapshot.limits.maxTurns === undefined ? 40 : snapshot.limits.maxTurns);
      const maxToolCalls = Math.min(120, snapshot.limits.maxToolCalls === undefined ? 120 : snapshot.limits.maxToolCalls);
      const runDeadline = Math.min(deadline, Date.now() +
        (snapshot.limits.runDeadlineSec === undefined ? 1800 : snapshot.limits.runDeadlineSec) * 1000);
      journal.append('run_started', { runId: run.id, sessionId: run.sessionId, generation: run.id,
        provenance: { packageId: snapshot.id, snapshotId: snapshot.snapshot_id } },
      { parentRunId, agentId: actor.agent.id });
      const endpoint = this.endpoint || createExpertEndpointSnapshot();
      const execution = await this.executor({
        context: { ['messages']: context.messages, runId: run.id, sessionId: run.sessionId, generation: run.id },
        endpoint, transport: this.transport || ModelTransport,
        tools: { executeBatch: (calls, callContext) => context.executeBatch ?
          context.executeBatch(calls, callContext) : (async () => {
            for (const call of calls) {
              if (!context.allowedToolNames.has(call.name)) {
                const error = new Error('EXPERT_TOOL_FORBIDDEN'); error.code = 'EXPERT_TOOL_FORBIDDEN'; throw error;
              }
            }
            if (this.executeBatch) return this.executeBatch(calls, callContext);
            if (this.executeTool) {
              const results = [];
              for (const call of calls) results.push(await this.executeTool(call, callContext));
              return results;
            }
            throw new Error('EXPERT_TOOL_RUNTIME_MISSING');
          })() },
        observer: {
          isActive: () => owns() && Date.now() <= runDeadline,
          beforeRound: ({ round }) => {
            if (Date.now() > runDeadline) return { stop: true, status: 'deadline' };
            const body = buildChatRequestBody({
              model: endpoint.model || (typeof providerState !== 'undefined' ? providerState.model : ''),
              ['messages']: expertApiMessages(context.messages), temperature: 0, topP: 1,
              maxTokens: 4096, effort: 'off',
              glm: typeof isGlmEndpoint === 'function' ? isGlmEndpoint() : false,
              tools: context.tools,
            });
            if (typeof normalizeSystemMessages === 'function') body.messages = normalizeSystemMessages(body.messages);
            return { body };
          },
          onDelta: (delta, current) => {
            if (owns() && this.onEvent) this.onEvent({ type: 'delta', runId: run.id, content: current.content });
          },
          onAssistant: ({ assistant, toolCalls }) => {
            if (!owns()) return { stop: true, status: 'cancelled' };
            assistantSequence++;
            const messageId = 'expert_' + run.id + '_assistant_' + assistantSequence;
            assistant.messageId = messageId;
            ledger.record(messageId, assistant.usage);
            ledger.apply(session, messageId, assistant.usage);
            refs.push({ messageId, role: 'assistant', actorId: actor.agent.id,
              packageId: snapshot.id, snapshotId: snapshot.snapshot_id,
              path: actor.agent.path, sha256: actor.agent.sha256 });
            journal.append('assistant', { runId: run.id, sessionId: run.sessionId, generation: run.id,
              provenance: { packageId: snapshot.id, snapshotId: snapshot.snapshot_id,
                path: actor.agent.path, sha256: actor.agent.sha256 } },
            { messageId, content: String(assistant.content || '').slice(0, 12000),
              toolCallIds: toolCalls.map(call => call.id) });
            toolCount += toolCalls.length;
            if (toolCount > maxToolCalls) return { stop: true, status: 'budget' };
            return { stop: false };
          },
          onToolResults: ({ results }) => {
            if (!owns()) return { stop: true, status: 'cancelled' };
            results.forEach(result => journal.append('tool_result', {
              runId: run.id, sessionId: run.sessionId, generation: run.id,
              provenance: { packageId: snapshot.id, snapshotId: snapshot.snapshot_id },
            }, { id: result.id, name: result.name, content: String(result.content || '').slice(0, 12000) }));
            return { stop: false };
          },
        },
        signal: abort.signal,
        limits: { maxRounds: maxTurns },
      });
      const status = execution.status || 'error';
      journal.appendOnce({ eventId: 'ev_' + run.id + '_terminal', type: 'run_terminal',
        runId: String(run.id), sessionId: run.sessionId, generation: run.id,
        ts: new Date().toISOString(), payload: { status, messageRefs: refs.map(ref => ref.messageId) } });
      await journal.flush();
      return { status, content: status === 'cancelled' ? '' : (execution.content || execution.partialContent || ''),
        newMessages: execution.newMessages || [], usage: ledger.result(execution.usage),
        messageRefs: refs, runId: String(run.id),
        parentRunId: parentRunId == null ? null : String(parentRunId), snapshotId: snapshot.snapshot_id,
        modelTurns: execution.modelTurns || 0, toolCalls: execution.toolCalls || [],
        error: execution.error ? { code: execution.error.code || 'EXPERT_RUN_ERROR',
          message: execution.error.message } : null, accepted: true };
    } catch (error) {
      const status = abort.signal.aborted || !owns() ? 'cancelled' : 'error';
      try {
        journal.appendOnce({ eventId: 'ev_' + run.id + '_terminal', type: 'run_terminal',
          runId: String(run.id), sessionId: run.sessionId, generation: run.id,
          ts: new Date().toISOString(), payload: { status, code: error.code || 'EXPERT_RUN_ERROR' } });
        await journal.flush();
      } catch (ignored) {}
      return { status, content: '', newMessages: [], usage: ledger.result(null), messageRefs: refs,
        runId: String(run.id), parentRunId: parentRunId == null ? null : String(parentRunId),
        snapshotId: snapshot && snapshot.snapshot_id,
        error: { code: error.code || 'EXPERT_RUN_ERROR', message: error.message },
        accepted: !!(snapshot && actor) };
    } finally {
      if (this.lastRunId === null || run.id > this.lastRunId) this.lastRunId = run.id;
      if (RunRegistry.current() === run) RunRegistry.finish(run);
    }
  }
  cancel(runId) {
    const run = RunRegistry.current();
    if (!run || String(run.id) !== String(runId)) return false;
    RunRegistry.cancel();
    return true;
  }
  async recover(checkpoint) {
    return new ExpertRecovery(this).recover(checkpoint);
  }
}
