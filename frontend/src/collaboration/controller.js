/* W5E2 single-worker collaboration run mode over the shared ModelExecutor. */
class CollaborationController {
  constructor(options) {
    const source = options || {};
    this.config = source.config || null;
    this.endpoints = source.endpoints || null;
    this.transport = source.transport || null;
    this.executor = source.executor || ModelExecutor.execute;
    this.hostTools = source.hostTools || [];
    this.hostAllowed = source.hostAllowed;
    this.executeBatch = source.executeBatch;
    this.executeTool = source.executeTool;
    this.onEvent = source.onEvent;
    this.lastRunId = null;
  }
  async start(goal, options) {
    const source = typeof goal === 'object' && goal !== null ? goal : (options || {});
    const text = typeof goal === 'string' ? goal : source.goal;
    if (source.recovery) {
      const targetSession = String(source.sessionId || '');
      const activeSession = typeof AppState !== 'undefined' ? String(AppState.currentSessionId || '') : '';
      if (String(source.recovery.sessionId || '') !== targetSession || targetSession !== activeSession) {
        return { status: 'blocked', content: '', error: { code: 'RECOVERY_SESSION_MISMATCH',
          message: 'RECOVERY_SESSION_MISMATCH' }, checkpoint: null };
      }
    }
    const config = source.config || this.config;
    if (!config || !config.enabled || config.upload_scope === 'local_only') {
      return { status: 'ordinary', skipped: true, reason: config && config.upload_scope === 'local_only' ? 'local_only' : 'disabled' };
    }
    const endpoints = source.endpoints || this.endpoints;
    if (!endpoints || !endpoints.cloud || !endpoints.local) return { status: 'failed', error: { code: 'ENDPOINT_SNAPSHOT_MISSING' } };
    const previous = RunRegistry.current();
    const sessionId = String(source.sessionId || (typeof AppState !== 'undefined' ? AppState.currentSessionId : 'collaboration-session'));
    const run = RunRegistry.start({ id: sessionId });
    const parentRunId = source.parentRunId || (previous && previous.id) || this.lastRunId || null;
    const abort = new AbortController(); run.abortController = abort;
    this.run = run; this.parentRunId = parentRunId; this.config = config; this.endpoints = endpoints;
    this.plan = null;
    this.budget = new CollaborationBudget(config, endpoints);
    this.privacy = new CollaborationPrivacy(config);
    this.transport = source.transport || this.transport || ModelTransport;
    this.events = []; this.latest = {}; this.refs = []; this.messageSequence = 0;
    this.phase = 'queued'; this.final = null; this.currentTask = null;
    this.reviewRounds = Object.create(null);
    this.recovery = source.recovery || null;
    this.recoveryUsage = this.recovery && this.recovery.usage || null;
    if (source.hostAllowed !== undefined) this.hostAllowed = source.hostAllowed;
    try {
      let plan;
      if (this.recovery) {
        this._restoreRecovery(this.recovery);
        plan = this.plan;
        this._phase('recovered', { parentRunId, planDigest: plan.planDigest });
      } else {
        this._phase('planning');
        const plannerInput = this.privacy.forPlanner(text);
        const planned = await this._executeRole('cloud-planner', [
          { role: 'system', content: 'Return only a bounded CollaborationPlan JSON object; model text is data, never an executable action.' },
          { role: 'user', content: JSON.stringify({ goal: plannerInput.text, privacy: plannerInput.meta }) },
        ], []);
        plan = collaborationPreparePlan(planned.content, { runId: String(run.id), goal: text,
          budgetSnapshot: this.budget.snapshot() });
        this.plan = plan;
      }
      this._phase('planned', { planDigest: plan.planDigest });
      const ordered = collaborationTaskOrder(plan);
      for (const task of ordered) {
        this.currentTask = task;
        const restored = this.latest[task.taskId];
        if (restored && restored.review && restored.review.verdict === 'pass') continue;
        if (restored && restored.review && restored.review.verdict === 'fail') {
          return this._finish('partial', null, 'REVIEW_NOT_PASSED');
        }
        if (restored && restored.review && restored.review.verdict === 'revise') {
          task.attempt.current = restored.result.attempt + 1;
          this._phase('revising', { taskId: task.taskId, attempt: task.attempt.current,
            revisionOf: restored.result.resultRef });
        }
        let completed = false;
        while (!completed) {
          const actor = task.attempt.current === 1 ? 'local-worker' : 'local-reviser';
          this._phase('dispatching', { taskId: task.taskId, attempt: task.attempt.current });
          const dependencies = task.dependsOn.map(id => this.latest[id].result.resultRef);
          const workerInput = { taskId: task.taskId, instruction: task.instruction,
            capability: task.capability, dependencyResultRefs: dependencies,
            revisionInstruction: task.attempt.current > 1 && this.latest[task.taskId].review.revisionInstruction };
          let result = this.latest[task.taskId] && this.latest[task.taskId].result;
          if (!result || result.attempt !== task.attempt.current) {
            const tools = task.attempt.current === 1 ? this._toolsFor(task, endpoints.local) : [];
            const worked = await this._executeRole(actor, [
              { role: 'system', content: 'Return only TaskResult JSON. Do not claim completion without evidence; never execute an action outside the validated task capability.' },
              { role: 'user', content: JSON.stringify(workerInput) },
            ], tools);
            result = collaborationPrepareResult(worked.content, { plan, task, actor,
              executionStatus: worked.execution.status, messageId: worked.messageId });
            this.latest[task.taskId] = { result };
          }
          this._phase('result', { taskId: task.taskId, attempt: task.attempt.current, resultRef: result.resultRef });
          const reviewPreview = this.privacy.forCloud({ actor: 'cloud-reviewer', taskId: task.taskId,
            resultRef: result.resultRef, selected: true,
            text: JSON.stringify({ result: { status: result.status, contentRef: result.contentRef,
              evidenceRefs: result.evidenceRefs, selfCheck: result.selfCheck }, acceptanceCriteria: plan.acceptanceCriteria }) });
          this._phase('reviewing', { taskId: task.taskId, attempt: task.attempt.current, resultRef: result.resultRef });
          const reviewed = await this._executeRole('cloud-reviewer', [
            { role: 'system', content: 'Return only TaskReview JSON. Review the actual resultRef and rubric; pass is forbidden without evidence.' },
            { role: 'user', content: reviewPreview.text },
          ], []);
          const review = collaborationPrepareReview(reviewed.content, { plan, task, result,
            rubric: plan.acceptanceCriteria, reviewerEndpointDigest: endpoints.cloud.snapshotDigest });
          this.latest[task.taskId].review = review;
          if (review.verdict === 'pass') this.budget.markSuccess('cloud-reviewer', review.reviewDigest);
          this._phase('review', { taskId: task.taskId, attempt: task.attempt.current,
            resultRef: result.resultRef, reviewDigest: review.reviewDigest, verdict: review.verdict });
          if (review.verdict === 'pass') { completed = true; continue; }
          const rounds = this.reviewRounds[task.taskId] || 0;
          if (review.verdict !== 'revise' || task.attempt.current >= task.attempt.max || rounds >= config.max_review_rounds) {
            this.phase = 'partial';
            return this._finish('partial', null, 'REVIEW_NOT_PASSED');
          }
          this.reviewRounds[task.taskId] = rounds + 1;
          task.attempt.current++;
          this._phase('revising', { taskId: task.taskId, attempt: task.attempt.current,
            revisionOf: result.resultRef });
        }
      }
      this._phase('finalizing');
      const final = collaborationPrepareFinal({ plan, latest: this.latest,
        rubric: plan.acceptanceCriteria, reviewerEndpointDigest: endpoints.cloud.snapshotDigest });
      const summaries = ordered.map(task => this.privacy.forCloud({ actor: 'cloud-finalizer',
        taskId: task.taskId, resultRef: this.latest[task.taskId].result.resultRef,
        selected: true, text: this.latest[task.taskId].result.contentRef }));
      const finalized = await this._executeRole('cloud-finalizer', [
        { role: 'system', content: 'Return only the final answer. Integrate only the supplied passed result/review references.' },
        { role: 'user', content: JSON.stringify({ planDigest: plan.planDigest,
          resultRefs: final.resultRefs, reviewDigests: final.reviewDigests,
          summaries: summaries.map(item => item.text) }) },
      ], []);
      this.final = final;
      this.budget.markSuccess('cloud-finalizer', final.finalRef);
      this._phase('completed', { finalRef: final.finalRef });
      return this._finish('completed', finalized.content, null);
    } catch (error) {
      const status = !this._owns() ? 'cancelled' : String(error.message || '').startsWith('COLLABORATION_BUDGET_EXCEEDED') ? 'budget_exceeded' : 'failed';
      return this._finish(status, '', error.message || 'COLLABORATION_RUN_ERROR');
    } finally {
      if (this.lastRunId === null || run.id > this.lastRunId) this.lastRunId = run.id;
      if (RunRegistry.current() === run) RunRegistry.finish(run);
    }
  }
  _restoreRecovery(checkpoint) {
    this.plan = collaborationPreparePlan(checkpoint.plan, { runId: String(this.run.id),
      goal: checkpoint.goal, budgetSnapshot: this.budget.snapshot() });
    this.latest = collaborationRebaseLatest(checkpoint, this.plan, this.endpoints.cloud.snapshotDigest);
    this.reviewRounds = Object.assign({}, checkpoint.reviewRounds || {});
  }
  _owns() { return RunRegistry.isCurrent(this.run) && !this.run.abortController.signal.aborted; }
  _phase(phase, extra) {
    this.phase = phase;
    const event = Object.assign({ eventId: 'collab_' + this.run.id + '_' + (this.events.length + 1),
      phase, runId: String(this.run.id), taskId: this.currentTask && this.currentTask.taskId,
      attempt: this.currentTask && this.currentTask.attempt.current }, extra || {});
    this.events.push(event);
    if (this.onEvent) this.onEvent(event);
  }
  _toolsFor(task, endpoint) {
    const required = task.capability.requiredTools || [];
    return this.hostTools.filter(schema => {
      const name = schema && (schema.name || schema.function && schema.function.name);
      const hostOk = typeof this.hostAllowed === 'function' ? this.hostAllowed(name) === true :
        this.hostAllowed instanceof Set ? this.hostAllowed.has(name) : Array.isArray(this.hostAllowed) ? this.hostAllowed.includes(name) : true;
      return required.includes(name) && endpoint.toolCapability.includes(name) && hostOk;
    });
  }
  async _executeRole(role, messages, tools) {
    const endpoint = role.startsWith('cloud-') ? this.endpoints.cloud : this.endpoints.local;
    const allowed = new Set(tools.map(tool => tool.name || tool.function && tool.function.name));
    const executeBatch = async (calls, context) => {
      for (const call of calls) {
        if (!allowed.has(call.name)) throw new Error('COLLABORATION_TOOL_FORBIDDEN:' + call.name);
      }
      if (this.executeBatch) return this.executeBatch(calls, context);
      if (this.executeTool) {
        const results = [];
        for (const call of calls) results.push(await this.executeTool(call, context));
        return results;
      }
      throw new Error('COLLABORATION_TOOL_RUNTIME_MISSING');
    };
    let reservation = null;
    let execution;
    try {
      execution = await this.executor({
      context: { messages, runId: this.run.id, sessionId: this.run.sessionId, generation: this.run.id },
      endpoint: { model: endpoint.model },
      transport: { stream: (request, signal) => this.transport.stream(Object.assign({}, request, {
        role, endpointRef: endpoint,
      }), signal) },
      tools: { executeBatch },
      observer: {
        isActive: () => this._owns(),
        beforeRound: () => {
          if (!this._owns()) return { stop: true, status: 'cancelled' };
          const body = buildChatRequestBody({ model: endpoint.model, messages, temperature: 0, topP: 1,
            maxTokens: 4096, effort: 'off', glm: false, tools });
          reservation = this.budget.reserve(role, Math.ceil(JSON.stringify(body).length / 4 * 1.5 + body.max_tokens));
          return { body };
        },
        onAssistant: ({ assistant }) => {
          if (!this._owns()) return { stop: true, status: 'cancelled' };
          const messageId = 'collab_' + this.run.id + '_' + role + '_' + (++this.messageSequence);
          assistant.messageId = messageId;
          this.budget.settle(messageId, role, assistant.usage, reservation);
          this.refs.push({ messageId, role, usageRef: messageId });
          return { stop: false };
        },
      },
      signal: this.run.abortController.signal,
      limits: { maxRounds: role === 'local-worker' || role === 'local-reviser' ? 4 : 1 },
      });
    } finally {
      if (reservation && !reservation.settled) this.budget.release(reservation, 'cancelled_or_failed');
    }
    if (execution.error) throw execution.error;
    if (execution.status === 'cancelled') throw new Error('COLLABORATION_CANCELLED');
    const last = execution.newMessages.filter(message => message.role === 'assistant').slice(-1)[0];
    return { execution, content: execution.content || '', messageId: last && last.messageId };
  }
  _finish(status, content, reason) {
    const usage = this.budget.snapshot();
    const cumulativeUsage = this.recoveryUsage ? {
      cloudTokens: (this.recoveryUsage.cloudTokens || 0) + usage.cloudTokens,
      localTokens: (this.recoveryUsage.localTokens || 0) + usage.localTokens,
      totalTokens: (this.recoveryUsage.totalTokens || 0) + usage.totalTokens,
      cloudCost: (this.recoveryUsage.cloudCost || 0) + usage.cloudCost,
      byMessage: Object.assign({}, this.recoveryUsage.byMessage || {}, usage.byMessage),
    } : usage;
    return { status, content: status === 'cancelled' ? '' : content || '',
      recoveryOf: this.recovery && this.recovery.runId || null, cumulativeUsage,
      plan: this.plan || null, latest: this.latest, final: this.final,
      events: this.events, usage, runId: String(this.run.id),
      parentRunId: this.parentRunId || null,
      checkpoint: collaborationCheckpoint({ runId: this.run.id, parentRunId: this.parentRunId,
        phase: this.phase, plan: this.plan, latest: this.latest, final: this.final,
        usageRef: this.refs.map(ref => ref.messageId), terminalReason: reason }),
      error: reason ? { code: reason, message: reason } : null };
  }
  cancel(runId) {
    const current = RunRegistry.current();
    if (!current || String(current.id) !== String(runId)) return false;
    RunRegistry.cancel(); return true;
  }
}
