/* W5E4 collaboration projection reusing ExpertTimeline, with no second usage ledger. */
function collaborationTimelineProjection(result) {
  const seen = new Set();
  const events = (result.events || []).filter(event => {
    if (!event || seen.has(event.eventId)) return false;
    seen.add(event.eventId); return true;
  });
  const tasks = Object.entries(result.latest || {}).map(([taskId, entry]) => ({ taskId,
    attempt: entry.result.attempt, resultRef: entry.result.resultRef,
    reviewDigest: entry.review && entry.review.reviewDigest,
    verdict: entry.review && entry.review.verdict, status: entry.result.status }));
  return { runId: result.runId, parentRunId: result.parentRunId, events, tasks,
    finalRef: result.final && result.final.finalRef, status: result.status,
    terminalReason: result.error && result.error.code, usage: result.usage || {} };
}
class CollaborationTimeline {
  constructor(root) { this.root = root || null; }
  render(result) {
    const projection = collaborationTimelineProjection(result);
    if (!this.root) return projection;
    const usageByMessage = projection.usage.byMessage || {};
    const events = projection.events.map(event => ({
      eventId: event.eventId, type: event.phase === 'completed' ? 'run_terminal' : 'member_terminal',
      runId: result.runId, sessionId: 'collaboration', phaseId: event.phase,
      memberRunId: event.taskId || 'lead',
      payload: { status: event.phase === 'completed' ? 'completed' : event.phase,
        resultRef: event.resultRef, reviewDigest: event.reviewDigest },
    }));
    const represented = new Set();
    Object.entries(result.latest || {}).forEach(([taskId, entry]) => {
      const resultUsage = usageByMessage[entry.result.usageRef];
      if (resultUsage) represented.add(entry.result.usageRef);
      events.push({ eventId: 'assistant-' + entry.result.resultRef, type: 'assistant', runId: result.runId,
        sessionId: 'collaboration', memberRunId: taskId + ':a' + entry.result.attempt,
        payload: { messageId: entry.result.usageRef, actorId: entry.result.actor,
          content: entry.result.contentRef, usage: resultUsage } });
      events.push({ eventId: 'terminal-' + entry.result.resultRef, type: 'member_terminal', runId: result.runId,
        sessionId: 'collaboration', memberRunId: taskId + ':a' + entry.result.attempt,
        payload: { status: entry.result.status } });
      if (entry.review) {
        events.push({ eventId: 'mailbox-' + entry.review.reviewDigest, type: 'mailbox_delivered',
          runId: result.runId, sessionId: 'collaboration', memberRunId: taskId,
          payload: { from: entry.result.actor, content: entry.result.resultRef + ' → ' + entry.review.reviewDigest,
            summary: entry.review.verdict } });
        events.push({ eventId: 'consumed-' + entry.review.reviewDigest, type: 'mailbox_consumed',
          runId: result.runId, sessionId: 'collaboration', memberRunId: 'lead',
          payload: { eventId: 'mailbox-' + entry.review.reviewDigest } });
      }
    });
    Object.entries(usageByMessage).forEach(([messageId, usage]) => {
      if (represented.has(messageId)) return;
      events.push({ eventId: 'usage-' + messageId, type: 'assistant', runId: result.runId,
        sessionId: 'collaboration', memberRunId: usage.role,
        payload: { messageId, actorId: usage.role, content: usage.role, usage } });
      events.push({ eventId: 'terminal-' + messageId, type: 'member_terminal', runId: result.runId,
        sessionId: 'collaboration', memberRunId: usage.role, payload: { status: result.status } });
    });
    events.push({ eventId: 'terminal-' + result.runId, type: 'run_terminal', runId: result.runId,
      sessionId: 'collaboration', memberRunId: 'lead', payload: { status: result.status } });
    const shared = new ExpertTimeline(this.root, { title: '协同运行' }).render({ expert: { events } }, result.runId);
    const refs = document.createElement('section');
    refs.className = 'collaboration-ref-list';
    projection.tasks.forEach(task => {
      const row = document.createElement('div'); row.className = 'collaboration-ref-row';
      row.textContent = task.taskId + ' · attempt=' + task.attempt + ' · ' + task.verdict +
        '\nresultRef=' + task.resultRef + '\nreviewDigest=' + (task.reviewDigest || 'pending');
      refs.appendChild(row);
    });
    if (projection.finalRef) { const final = document.createElement('div'); final.className = 'collaboration-ref-row';
      final.textContent = 'finalRef=' + projection.finalRef; refs.appendChild(final); }
    const usage = document.createElement('div'); usage.className = 'collaboration-usage';
    usage.textContent = 'local=' + (projection.usage.localTokens || 0) + ' tokens · cloud=' +
      (projection.usage.cloudTokens || 0) + ' tokens · cost=¥' + Number(projection.usage.cloudCost || 0).toFixed(4) +
      (projection.terminalReason ? ' · ' + projection.terminalReason : '');
    refs.appendChild(usage);
    Object.entries(projection.usage.byRole || {}).forEach(([role, value]) => {
      if (value.unitSuccessCost !== null && value.unitSuccessCost !== undefined) {
        const cost = document.createElement('small'); cost.textContent = role + ' · unitSuccessCost=¥' + Number(value.unitSuccessCost).toFixed(6);
        refs.appendChild(cost);
      }
    });
    this.root.appendChild(refs);
    return { projection, shared };
  }
}
