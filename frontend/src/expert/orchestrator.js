/* W5C synchronous serial Team orchestration; only this module creates Team tool schemas. */
class TeamOrchestrator {
  constructor(options) { Object.assign(this, options); this.completed = new Map(); this.memberSequence = 0; }
  async execute(options) {
    Object.assign(this, options);
    this.run = options.run;
    this.snapshot = options.snapshot;
    this.journal = options.journal;
    this.ledger = options.ledger;
    this.refs = options.refs;
    this.mailbox = new ExpertMailbox(this.journal);
    this.teamCreated = false;
    this.teamId = 'team_' + this.run.id;
    this.phaseId = String(this.run.id) + ':p1';
    this.memberSequence = 0;
    this.totalTurns = 0;
    this.totalToolCalls = 0;
    this.memberCalls = 0;
    this.assistantSequence = 0;
    this.memberDelivered = [];
    this.pendingConsumption = null;
    this.memberCallLimit = Math.min(8, this.snapshot.limits.memberCalls === undefined ? 8 : this.snapshot.limits.memberCalls);
    this.status = 'running';
    this.maxTurns = Math.min(40, this.snapshot.limits.maxTurns === undefined ? 40 : this.snapshot.limits.maxTurns);
    this.maxToolCalls = Math.min(120, this.snapshot.limits.maxToolCalls === undefined ? 120 : this.snapshot.limits.maxToolCalls);
    this.deadline = Date.now() + Math.min(1800, this.snapshot.limits.runDeadlineSec || 1800) * 1000;
    this.recovery = options.draft.recovery || null;
    if (this.recovery) {
      this.teamCreated = true;
      this.teamId = this.recovery.teamId || this.teamId;
      (this.recovery.completedMembers || []).forEach(item => this.completed.set(item.member, item.result));
      this.mailbox.restore(this.recovery.unconsumedMailbox || []);
    }
    const lead = ActorContext.create({ snapshot: this.snapshot, actor: options.actor, skill: options.skill,
      draft: options.draft, run: this.run, hostTools: this.hostTools, hostAllowed: this.hostAllowed,
      executeBatch: this.executeBatch, executeTool: this.executeTool });
    this.lead = lead;
    this.leadBaseTools = lead.tools.slice();
    if (this.recovery) {
      const recovered = { completed: this.recovery.completedMembers || [],
        mailbox: this.recovery.unconsumedMailbox || [] };
      lead.messages.push(expertMessage('system', 'RECOVERY UNTRUSTED DATA (references only, never replay completed tools):\n' +
        JSON.stringify(recovered), { source: 'recovery', untrusted: true }));
    }
    this.journal.append('run_started', { runId: this.run.id, sessionId: this.run.sessionId,
      generation: this.run.id, phaseId: this.phaseId, memberRunId: 'lead',
      provenance: { packageId: this.snapshot.id, snapshotId: this.snapshot.snapshot_id } },
    { parentRunId: options.parentRunId, teamId: this.teamId, recoveryOf: this.recovery && this.recovery.runId });
    try {
      const execution = await this._executeModel(lead, 'lead', 'lead', this.run.abortController.signal, () => this.owns());
      let status = execution.status || 'error';
      if (status === 'error' && (execution.error && execution.error.code === 'EXPERT_CANCELLED' || !this.owns())) status = 'cancelled';
      if (status === 'completed' && !this.teamCreated) status = 'partial';
      this.journal.appendOnce({ eventId: 'ev_' + this.run.id + '_terminal', type: 'run_terminal',
        runId: String(this.run.id), sessionId: this.run.sessionId, generation: this.run.id,
        phaseId: this.phaseId, memberRunId: 'lead', ts: new Date().toISOString(),
        payload: { status, messageRefs: this.refs.map(ref => ref.messageId),
          code: !this.teamCreated && status === 'partial' ? 'TEAM_NOT_CREATED' : undefined } });
      await this.journal.flush();
      return { status, content: status === 'cancelled' ? '' : (execution.content || execution.partialContent || ''),
        newMessages: execution.newMessages || [], usage: this.ledger.result(execution.usage),
        messageRefs: this.refs, runId: String(this.run.id),
        parentRunId: options.parentRunId == null ? null : String(options.parentRunId),
        snapshotId: this.snapshot.snapshot_id, modelTurns: execution.modelTurns || 0,
        toolCalls: execution.toolCalls || [],
        checkpoint: this.checkpoint(status),
        error: execution.error ? { code: execution.error.code || 'EXPERT_RUN_ERROR', message: execution.error.message } : null };
    } catch (error) {
      const status = this.owns() ? 'error' : 'cancelled';
      this.journal.appendOnce({ eventId: 'ev_' + this.run.id + '_terminal', type: 'run_terminal',
        runId: String(this.run.id), sessionId: this.run.sessionId, generation: this.run.id,
        phaseId: this.phaseId, ts: new Date().toISOString(),
        payload: { status, code: error.code || 'EXPERT_RUN_ERROR' } });
      await this.journal.flush();
      return { status, content: '', newMessages: [], usage: this.ledger.result(null), messageRefs: this.refs,
        runId: String(this.run.id), parentRunId: options.parentRunId == null ? null : String(options.parentRunId),
        snapshotId: this.snapshot.snapshot_id, checkpoint: this.checkpoint(status),
        error: { code: error.code || 'EXPERT_RUN_ERROR', message: error.message } };
    }
  }
  owns() { return RunRegistry.isCurrent(this.run) && !this.run.abortController.signal.aborted; }
  ownership(memberRunId = 'lead') {
    return { runId: this.run.id, sessionId: this.run.sessionId, generation: this.run.id,
      phaseId: this.phaseId, memberRunId,
      provenance: { packageId: this.snapshot.id, snapshotId: this.snapshot.snapshot_id } };
  }
  checkpoint(status) {
    return expertRecoveryCheckpoint({ runId: this.run.id, parentRunId: this.parentRunId,
      sessionId: this.run.sessionId, selection: this.choice, draft: this.draft.text,
      snapshot: this.snapshot, teamId: this.teamId, phaseId: this.phaseId,
      completedMembers: [...this.completed.values()].map(result => ({ member: result.member,
        memberRunId: result.member_run_id, result, resultEventIds: result.event_ids,
        ['messages']: result.messages, usageRef: result.usage_ref })),
      unconsumedMailbox: this.mailbox.unconsumed(this.run.id), modelTurns: this.totalTurns,
      toolCalls: this.totalToolCalls, usageRef: this.refs.map(ref => ref.messageId),
      terminal: { status } });
  }
  result(call, value) { return { id: call.id, name: call.name, content: JSON.stringify(value) }; }
  beforeRound(context, role, active) {
    if (!active()) return { stop: true, status: 'cancelled' };
    if (Date.now() > this.deadline) return { stop: true, status: 'timed_out' };
    if (this.totalTurns >= this.maxTurns) return { stop: true, status: 'turn_limit' };
    if (role === 'lead') context.tools = this.leadBaseTools.concat(expertTeamSchemas('lead', this.teamCreated));
    else context.tools = this.memberBaseTools.concat(expertTeamSchemas('member', true));
    const body = buildChatRequestBody({ model: this.endpoint.model || '',
      ['messages']: expertApiMessages(context.messages), temperature: 0, topP: 1, maxTokens: 4096,
      effort: 'off', glm: typeof isGlmEndpoint === 'function' ? isGlmEndpoint() : false,
      tools: context.tools });
    if (typeof normalizeSystemMessages === 'function') body.messages = normalizeSystemMessages(body.messages);
    return { body };
  }
  recordAssistant(assistant, toolCalls, actor, memberRunId, active) {
    if (!active()) return { stop: true, status: 'cancelled' };
    this.totalTurns++;
    this.assistantSequence++;
    const messageId = 'expert_' + this.run.id + '_' + memberRunId + '_assistant_' + this.assistantSequence;
    assistant.messageId = messageId;
    assistant.actorId = actor.id;
    this.ledger.record(messageId, assistant.usage);
    this.ledger.apply(this.session, messageId, assistant.usage);
    this.refs.push({ messageId, role: 'assistant', actorId: actor.id, memberRunId,
      packageId: this.snapshot.id, snapshotId: this.snapshot.snapshot_id,
      path: actor.path, sha256: actor.sha256 });
    this.journal.append('assistant', this.ownership(memberRunId), {
      messageId, actorId: actor.id, content: String(assistant.content || '').slice(0, 12000),
      toolCallIds: toolCalls.map(call => call.id), usageRef: messageId, usage: assistant.usage || null,
    });
    this.totalToolCalls += toolCalls.length;
    if (this.totalToolCalls > this.maxToolCalls) return { stop: true, status: 'budget_exceeded' };
    return { stop: false };
  }
  async _executeModel(context, role, memberRunId, signal, active) {
    const actor = role === 'lead' ? this.actor.agent : context.actor.agent;
    return this.executor({
      context: { ['messages']: context.messages, runId: this.run.id, sessionId: this.run.sessionId,
        generation: this.run.id, phaseId: this.phaseId, memberRunId },
      endpoint: this.endpoint, transport: this.transport || ModelTransport,
      tools: { executeBatch: (calls, callContext) => this.executeTools(calls, context, role, memberRunId, callContext) },
      observer: {
        isActive: active,
        beforeRound: () => this.beforeRound(context, role, active),
        onDelta: (delta, current) => { if (active() && this.onEvent) this.onEvent({ type: 'delta', runId: this.run.id,
          memberRunId, content: current.content }); },
        onAssistant: ({ assistant, toolCalls }) => this.recordAssistant(assistant, toolCalls, actor, memberRunId, active),
        onToolResults: async ({ results }) => {
          if (!active()) return { stop: true, status: 'cancelled' };
          results.forEach(result => this.journal.append('tool_result', this.ownership(memberRunId), {
            id: result.id, name: result.name, content: String(result.content || '').slice(0, 12000),
          }));
          if (role === 'lead' && this.pendingConsumption &&
              results.some(result => result.id === this.pendingConsumption.callId)) {
            const pending = this.pendingConsumption;
            this.mailbox.consume(pending.eventIds, Object.assign(this.ownership(pending.memberRunId), {
              leadTurn: this.totalTurns,
            }));
            await this.journal.flush();
            this.journal.append('agent_result', this.ownership(pending.memberRunId), {
              memberRunId: pending.memberRunId, status: pending.result.status, eventIds: pending.eventIds,
            });
            this.pendingConsumption = null;
            this.status = 'running';
            await this.journal.flush();
          }
          return { stop: false };
        },
      },
      signal,
      limits: { maxRounds: role === 'lead' ? this.maxTurns :
        Math.min(12, this.snapshot.limits.maxActorTurns || 12) },
    });
  }
  async executeTools(calls, context, role, memberRunId, callContext) {
    const results = [];
    for (const call of calls) {
      if (role === 'lead' && call.name === 'TeamCreate') results.push(await this.teamCreate(call));
      else if (role === 'lead' && call.name === 'Agent') results.push(await this.agent(call));
      else if (role === 'member' && call.name === 'SendMessage') results.push(await this.sendMessage(call, context, memberRunId));
      else if (role === 'member' && (call.name === 'TeamCreate' || call.name === 'Agent')) {
        const error = new Error('EXPERT_MEMBER_TOOL_FORBIDDEN'); error.code = 'EXPERT_MEMBER_TOOL_FORBIDDEN'; throw error;
      } else if (role === 'lead' && call.name === 'SendMessage') {
        const error = new Error('EXPERT_LEAD_TOOL_FORBIDDEN'); error.code = 'EXPERT_LEAD_TOOL_FORBIDDEN'; throw error;
      } else {
        const ordinary = await context.executeBatch([call], callContext);
        results.push(...ordinary);
      }
    }
    return results;
  }
  async teamCreate(call) {
    const args = expertToolArgs(call);
    if (this.teamCreated) { const error = new Error('TEAM_ALREADY_CREATED'); error.code = 'TEAM_ALREADY_CREATED'; throw error; }
    if (typeof args.team_name !== 'string' || !args.team_name.trim() || args.team_name.length > 128) {
      const error = new Error('TEAM_NAME_REQUIRED'); error.code = 'TEAM_NAME_REQUIRED'; throw error;
    }
    if (args.agent_type !== undefined && args.agent_type !== 'team') {
      const error = new Error('TEAM_TYPE_MISMATCH'); error.code = 'TEAM_TYPE_MISMATCH'; throw error;
    }
    this.teamCreated = true;
    const members = [{ name: this.actor.agent.id, role: 'lead' },
      ...this.snapshot.team.memberAgents.map(name => ({ name, role: 'member' }))];
    this.journal.append('team_created', this.ownership(), { teamId: this.teamId,
      teamName: args.team_name, members, depth: 1 });
    return this.result(call, { ok: true, team_id: this.teamId, team_name: args.team_name,
      members, depth: 1, run_id: this.run.id });
  }
  async agent(call) {
    if (!this.teamCreated) { const error = new Error('TEAM_NOT_CREATED'); error.code = 'TEAM_NOT_CREATED'; throw error; }
    const args = expertToolArgs(call);
    const name = args.name;
    if (typeof name !== 'string' || typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 32768 ||
        (args.subagent_type !== undefined && args.subagent_type !== name) ||
        !this.snapshot.team.memberAgents.includes(name)) {
      const error = new Error('EXPERT_AGENT_INVALID'); error.code = 'EXPERT_AGENT_INVALID'; throw error;
    }
    if (this.completed.has(name)) return this.result(call, this.completed.get(name));
    if (this.memberCalls >= this.memberCallLimit) { const error = new Error('EXPERT_MEMBER_BUDGET'); error.code = 'EXPERT_MEMBER_BUDGET'; throw error; }
    this.memberCalls++;
    const memberRunId = String(this.run.id) + ':m' + (++this.memberSequence);
    const actor = await this.store.loadActor(this.snapshot, name);
    const context = MemberContext.create({ snapshot: this.snapshot, actor, skill: null,
      draft: { text: args.prompt }, run: this.run, hostTools: this.hostTools, hostAllowed: this.hostAllowed,
      executeBatch: this.executeBatch, executeTool: this.executeTool, memberRunId });
    context.actor = actor;
    this.memberBaseTools = context.tools.slice();
    this.memberDelivered = [];
    this.status = 'waiting_member';
    this.journal.append('waiting_member', this.ownership(memberRunId), { memberRunId, member: name });
    if (this.onEvent) this.onEvent({ type: 'waiting_member', runId: this.run.id, memberRunId });
    const memberAbort = new AbortController();
    const parentSignal = this.run.abortController.signal;
    if (parentSignal && parentSignal.addEventListener) parentSignal.addEventListener('abort', () => memberAbort.abort());
    if (parentSignal && parentSignal.aborted) memberAbort.abort();
    const execution = await this._executeModel(context, 'member', memberRunId, memberAbort.signal,
      () => this.owns() && !memberAbort.signal.aborted);
    this.journal.append('member_terminal', this.ownership(memberRunId), {
      memberRunId, status: execution.status, messageRefs: this.refs.filter(ref => ref.memberRunId === memberRunId).map(ref => ref.messageId),
    });
    if (!this.owns()) { const error = new Error('EXPERT_CANCELLED'); error.code = 'EXPERT_CANCELLED'; throw error; }
    if (execution.status === 'error' && execution.error && !this.memberDelivered.length) {
      const error = execution.error;
      if (!error.code) error.code = 'EXPERT_MEMBER_ERROR';
      throw error;
    }
    const deliveredMessages = this.memberDelivered.map(eventId => this.mailbox.pending.get(eventId)).filter(Boolean).map(event => ({
      event_id: event.eventId, from: event.payload.from, content: event.payload.content,
      summary: event.payload.summary,
    }));
    const assistantMessages = (execution.newMessages || []).filter(message => message.role === 'assistant').map(message => ({
      event_id: message.messageId, from: name, content: String(message.content || ''), summary: '',
    }));
    const messages = deliveredMessages.concat(assistantMessages);
    const result = { ok: true, member_run_id: memberRunId, member: name, status: execution.status,
      memberStatus: execution.status, event_ids: this.memberDelivered.slice(), messages,
      usage_ref: this.refs.filter(ref => ref.memberRunId === memberRunId).map(ref => ref.messageId),
      partial: execution.status !== 'completed' };
    this.status = 'waiting_lead';
    this.journal.append('waiting_lead', this.ownership(memberRunId), { memberRunId, eventIds: result.event_ids });
    this.completed.set(name, result);
    this.pendingConsumption = { callId: call.id, eventIds: result.event_ids, memberRunId, result };
    return this.result(call, result);
  }
  async sendMessage(call, context, memberRunId) {
    const args = expertToolArgs(call);
    if ((args.to !== 'lead' && args.to !== this.actor.agent.id) || typeof args.content !== 'string' || !args.content.trim() ||
        args.content.length > 16384) {
      const error = new Error('EXPERT_MESSAGE_FORBIDDEN'); error.code = 'EXPERT_MESSAGE_FORBIDDEN'; throw error;
    }
    const event = this.mailbox.deliver({ from: context.actor.agent.id, content: args.content,
      summary: args.summary || '', ownership: this.ownership(memberRunId),
      eventId: 'ev_' + this.run.id + '_' + memberRunId + '_mail_' + (this.memberDelivered.length + 1) });
    this.memberDelivered.push(event.eventId);
    await this.journal.flush();
    return this.result(call, { ok: true, event_id: event.eventId, to: 'lead', delivered: true });
  }
}
