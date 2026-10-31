/* W5E2 pre-reservation and messageId settlement; never calls accumulateUsage. */
class CollaborationBudget {
  constructor(config, endpoints) {
    this.config = config;
    this.endpoints = endpoints;
    this.cloudBudget = config.cloud_token_budget;
    this.totalBudget = config.total_token_budget;
    this.costBudget = config.cloud_cost_budget;
    this.usedCloud = 0; this.usedTotal = 0; this.usedCost = 0;
    this.byRole = {}; this.byMessage = {}; this.reservations = new Map(); this.reservationSequence = 0;
    const unit = Math.min(4000, this.cloudBudget * 0.2);
    this.mandatory = { 'cloud-planner': unit,
      'cloud-reviewer': unit * (1 + config.max_review_rounds), 'cloud-finalizer': unit };
    this.remainingMandatory = Object.values(this.mandatory).reduce((sum, value) => sum + value, 0);
    this.consumedMandatory = new Set();
  }
  reserve(role, estimate) {
    const estimated = Math.max(1, Math.ceil(Number(estimate) || 1));
    const cloud = role.startsWith('cloud-');
    const firstMandatory = !!this.mandatory[role] && !this.consumedMandatory.has(role);
    const future = firstMandatory ? this.remainingMandatory - this.mandatory[role] : this.remainingMandatory;
    if (cloud && this.usedCloud + estimated + future > this.cloudBudget) throw new Error('COLLABORATION_BUDGET_EXCEEDED:cloud');
    if (this.usedTotal + estimated + future > this.totalBudget) throw new Error('COLLABORATION_BUDGET_EXCEEDED:total');
    if (cloud) {
      const prices = this.endpoints.cloud.prices || { in: 0, out: 0 };
      const estimateCost = estimated * (prices.in + prices.out) / 2000;
      if (this.usedCost >= this.costBudget || this.usedCost + estimateCost > this.costBudget) {
        throw new Error('COLLABORATION_BUDGET_EXCEEDED:cost');
      }
    }
    if (firstMandatory) { this.remainingMandatory = future; this.consumedMandatory.add(role); }
    const reservation = { id: ++this.reservationSequence, role, estimate: estimated, cloud,
      settled: false, released: false, mandatoryFirst: firstMandatory };
    this.reservations.set(reservation.id, reservation);
    return reservation;
  }
  settle(messageId, role, usage, reservation) {
    if (!messageId || this.byMessage[messageId]) return false;
    const actual = usage || {};
    const cachedRaw = actual.prompt_tokens_details && actual.prompt_tokens_details.cached_tokens;
    const numericValues = [actual.total_tokens, actual.prompt_tokens, actual.completion_tokens, cachedRaw];
    if (usage && numericValues.some(value => value !== undefined &&
        (typeof value !== 'number' || !Number.isFinite(value) || value < 0))) {
      throw new Error('COLLABORATION_USAGE_INVALID');
    }
    const hasTotal = !!usage && actual.total_tokens !== undefined;
    const total = hasTotal ? actual.total_tokens : reservation.estimate;
    const prompt = hasTotal ? (actual.prompt_tokens || 0) : total;
    const completion = hasTotal ? (actual.completion_tokens || Math.max(0, total - prompt)) : 0;
    const cached = cachedRaw || 0;
    if (cached > prompt || (hasTotal && total < prompt + completion)) {
      throw new Error('COLLABORATION_USAGE_INVALID');
    }
    const cloud = role.startsWith('cloud-');
    const endpoint = this.endpoints[cloud ? 'cloud' : 'local'];
    const prices = endpoint.prices || { in: 0, out: 0, cache: 0 };
    const cost = cloud ? ((prompt - cached) * prices.in + cached * prices.cache + completion * prices.out) / 1000 : 0;
    this.usedTotal += total;
    if (cloud) { this.usedCloud += total; this.usedCost += cost; }
    if (!this.byRole[role]) this.byRole[role] = { tokens: 0, cost: 0, calls: 0 };
    this.byRole[role].tokens += total; this.byRole[role].cost += cost; this.byRole[role].calls++;
    this.byMessage[messageId] = { role, prompt_tokens: prompt, completion_tokens: completion,
      total_tokens: total, cost, estimated: !hasTotal };
    reservation.settled = true;
    if (this.usedTotal > this.totalBudget || this.usedCloud > this.cloudBudget || this.usedCost > this.costBudget) {
      throw new Error('COLLABORATION_BUDGET_EXCEEDED:settlement');
    }
    return true;
  }
  release(reservation, reason) {
    if (!reservation || reservation.released || reservation.settled) return false;
    reservation.released = true; reservation.releaseReason = reason || 'released';
    if (reservation.mandatoryFirst) {
      this.remainingMandatory = Math.min(this.remainingMandatory + this.mandatory[reservation.role],
        Object.values(this.mandatory).reduce((sum, value) => sum + value, 0));
      this.consumedMandatory.delete(reservation.role);
    }
    return true;
  }
  markSuccess(role, ref) {
    if (!this.byRole[role]) this.byRole[role] = { tokens: 0, cost: 0, calls: 0 };
    this.byRole[role].successes = (this.byRole[role].successes || 0) + 1;
    this.byRole[role].lastSuccessRef = ref || null;
  }
  snapshot() {
    const byRole = {};
    Object.entries(this.byRole).forEach(([role, value]) => {
      byRole[role] = Object.assign({}, value, { unitSuccessCost: value.successes ? value.cost / value.successes : null });
    });
    return { cloudTokens: this.usedCloud, totalTokens: this.usedTotal, cloudCost: this.usedCost,
      localTokens: this.usedTotal - this.usedCloud, localCost: 0,
      byRole, byMessage: this.byMessage,
      remainingMandatory: this.remainingMandatory,
      limits: { cloud: this.cloudBudget, total: this.totalBudget, cost: this.costBudget } };
  }
}
