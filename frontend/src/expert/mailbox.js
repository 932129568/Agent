/* W5C persisted mailbox; delivered and consumed are separate idempotent events. */
class ExpertMailbox {
  constructor(journal) { this.journal = journal; this.pending = new Map(); }
  deliver(options) {
    const event = this.journal.append('mailbox_delivered', options.ownership, {
      from: options.from, to: 'lead', content: String(options.content || ''),
      summary: String(options.summary || ''),
    }, options.eventId);
    this.pending.set(event.eventId, event);
    return event;
  }
  consume(eventIds, ownership) {
    const consumed = [];
    (eventIds || []).forEach(eventId => {
      const delivered = this.pending.get(eventId);
      if (!delivered) return;
      const event = this.journal.appendOnce({
        eventId: 'ev_' + ownership.runId + '_consume_' + eventId,
        type: 'mailbox_consumed', runId: String(ownership.runId), sessionId: String(ownership.sessionId),
        generation: ownership.generation, phaseId: ownership.phaseId,
        memberRunId: ownership.memberRunId, ts: new Date().toISOString(),
        payload: { eventId, leadTurn: ownership.leadTurn || 0 },
      });
      this.pending.delete(eventId);
      consumed.push(event);
    });
    return consumed;
  }
  unconsumed(runId) {
    return [...this.pending.values()].filter(event => String(event.runId) === String(runId));
  }
  restore(events) {
    (events || []).forEach(event => { if (event && event.eventId) this.pending.set(event.eventId, event); });
  }
}
