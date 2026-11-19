/* W5C selectors: one actor assistant messageId contributes usage exactly once. */
function expertUsageTotals(target, usage) {
  if (!usage) return;
  target.prompt_tokens = (target.prompt_tokens || 0) + Number(usage.prompt_tokens || 0);
  target.completion_tokens = (target.completion_tokens || 0) + Number(usage.completion_tokens || 0);
  target.total_tokens = (target.total_tokens || 0) + Number(usage.total_tokens ||
    (usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
}
function selectExpertUsage(input) {
  const source = input || {};
  const refs = new Map((source.messageRefs || []).map(ref => [ref.messageId, ref]));
  const byActor = {};
  const byMessage = {};
  const seen = new Set();
  (source.newMessages || source.messages || []).forEach(message => {
    if (!message || message.role !== 'assistant' || !message.messageId || seen.has(message.messageId)) return;
    seen.add(message.messageId);
    const ref = refs.get(message.messageId) || {};
    const actorId = message.actorId || ref.actorId || 'lead';
    if (!byActor[actorId]) byActor[actorId] = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    expertUsageTotals(byActor[actorId], message.usage);
    byMessage[message.messageId] = { actorId, usage: message.usage || null };
  });
  if (source.usage && source.usage.byMessage) {
    Object.entries(source.usage.byMessage).forEach(([messageId, usage]) => {
      if (seen.has(messageId)) return;
      seen.add(messageId);
      const ref = refs.get(messageId) || {};
      const actorId = ref.actorId || 'lead';
      if (!byActor[actorId]) byActor[actorId] = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      expertUsageTotals(byActor[actorId], usage);
      byMessage[messageId] = { actorId, usage };
    });
  }
  const total = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  Object.values(byActor).forEach(usage => expertUsageTotals(total, usage));
  return { byActor, byMessage, total };
}
function selectExpertEventUsage(events) {
  const byMessage = {};
  const refs = [];
  (events || []).forEach(event => {
    if (event.type !== 'assistant' || !event.payload || !event.payload.messageId) return;
    const messageId = event.payload.messageId;
    if (byMessage[messageId]) return;
    byMessage[messageId] = event.payload.usage || null;
    refs.push({ messageId, actorId: event.payload.actorId || event.memberRunId || 'lead' });
  });
  return selectExpertUsage({ usage: { byMessage }, messageRefs: refs });
}
