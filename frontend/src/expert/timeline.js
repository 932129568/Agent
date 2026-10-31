/* W5D session.expert.events projection: actor lanes + mailbox回流, not a flat log. */
function expertTimelineProjection(events, runId) {
  const seen = new Set();
  const unique = (events || []).filter(event => {
    if (!event || !event.eventId || seen.has(event.eventId)) return false;
    seen.add(event.eventId);
    return true;
  });
  const selectedRun = runId || (unique.length ? unique[unique.length - 1].runId : '');
  const selected = unique.filter(event => String(event.runId) === String(selectedRun));
  const actors = Object.create(null);
  const mailboxes = Object.create(null);
  let terminal = null;
  let phaseId = '';
  selected.forEach(event => {
    const actorId = event.memberRunId || 'lead';
    if (!actors[actorId]) actors[actorId] = { id: actorId,
      role: actorId === 'lead' ? 'lead' : 'member', events: [], status: 'running' };
    actors[actorId].events.push(event);
    if (event.phaseId) phaseId = event.phaseId;
    if ((event.type === 'waiting_member' || event.type === 'waiting_lead') && actors[actorId].status === 'running') {
      actors[actorId].status = event.type;
    }
    if (event.type === 'member_terminal') actors[actorId].status = event.payload.status || 'terminal';
    if (event.type === 'mailbox_delivered') mailboxes[event.eventId] = {
      eventId: event.eventId, from: event.payload.from, content: event.payload.content,
      summary: event.payload.summary, consumed: false,
    };
    if (event.type === 'mailbox_consumed' && mailboxes[event.payload.eventId]) {
      mailboxes[event.payload.eventId].consumed = true;
    }
    if (event.type === 'run_terminal') {
      terminal = event;
      actors[actorId].status = event.payload.status || 'terminal';
    }
  });
  return { runId: String(selectedRun || ''), phaseId, actors: Object.values(actors),
    mailboxes: Object.values(mailboxes), terminal,
    usage: selectExpertEventUsage(selected), events: selected };
}
class ExpertTimeline {
  constructor(root, options) { this.root = root || null; this.title = options && options.title || '专家运行'; }
  render(session, runId) {
    const projection = expertTimelineProjection(session && session.expert && session.expert.events, runId);
    if (!this.root) return projection;
    this.root.replaceChildren();
    this.root.hidden = !projection.events.length;
    this.root.setAttribute('aria-live', 'polite');
    if (!projection.events.length) return projection;
    const head = document.createElement('div');
    head.className = 'expert-timeline-head';
    const title = document.createElement('strong');
    title.textContent = this.title + ' · ' + projection.runId;
    head.appendChild(title);
    if (projection.phaseId) {
      const phase = document.createElement('span');
      phase.className = 'expert-package-meta';
      phase.textContent = 'phase · ' + projection.phaseId;
      head.appendChild(phase);
    }
    if (projection.terminal) {
      const status = document.createElement('span');
      status.className = 'expert-status';
      status.textContent = projection.terminal.payload.status || 'terminal';
      head.appendChild(status);
    }
    this.root.appendChild(head);
    projection.actors.forEach(actor => {
      const lane = document.createElement('section');
      lane.className = 'expert-actor-lane';
      const label = document.createElement('div');
      label.className = 'expert-actor-label';
      label.textContent = (actor.role === 'lead' ? 'Lead' : 'Member') + ' · ' + actor.id + ' · ' + actor.status;
      lane.appendChild(label);
      actor.events.filter(event => event.type === 'assistant').forEach(event => {
        const text = document.createElement('p');
        text.className = 'expert-actor-text';
        text.textContent = event.payload.content || '';
        lane.appendChild(text);
      });
      this.root.appendChild(lane);
    });
    projection.mailboxes.forEach(mailbox => {
      const row = document.createElement('div');
      row.className = 'expert-mailbox-row';
      row.textContent = mailbox.from + ' → lead · ' + mailbox.content +
        (mailbox.consumed ? ' · 已消费' : ' · 待消费');
      this.root.appendChild(row);
    });
    const usage = document.createElement('div');
    usage.className = 'expert-usage';
    usage.textContent = 'Usage · ' + projection.usage.total.total_tokens + ' tokens · ' +
      Object.entries(projection.usage.byActor).map(([actor, value]) => actor + ' ' + value.total_tokens).join(' / ');
    this.root.appendChild(usage);
    return projection;
  }
}
