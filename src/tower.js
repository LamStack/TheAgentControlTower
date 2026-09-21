import { Clock, HttpError, round2, trunc } from './util.js';
import { AuditLog } from './audit.js';
import { TOOLS, newWorld, worldView } from './tools.js';
import { evaluate, guardrailSummary, LIMITS } from './policy.js';
import { computeDrift } from './drift.js';
import { costUsd, MODELS } from './pricing.js';
import { Agent } from './agent.js';
import { ROSTER } from './agents/roster.js';
import { FAULTS, FAULT_LABELS } from './agents/faults.js';

const MAX_EVENTS = 1500;
const MAX_STEPS = 200;
const BUCKET_MS = 10_000;
const BUCKETS_SHOWN = 30;

const cloneArgs = (a) => {
  try {
    const s = JSON.stringify(a ?? {});
    if (s.length > 2000) return { _truncated: true };
    const o = JSON.parse(s);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
};
const stableJson = (o) => JSON.stringify(o, Object.keys(o).sort());
const nameOf = (by) => (by.startsWith('operator:') ? by.slice(9) : 'the Tower');
const usd = (n) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

/**
 * The control plane. Agents emit intent (requestAction / recordThought); the tower decides,
 * meters, records and broadcasts. It is the only path to the (simulated) systems, so a halt here
 * is a halt everywhere, whether or not the agent cooperates.
 */
export class Tower {
  constructor(opts = {}) {
    this.id = opts.id ?? 'demo';
    this.seed = opts.seed ?? 1337;
    this.clock = new Clock(opts.speed ?? 1);
    this.autoContain = opts.autoContain ?? true;
    this.approvalTtlMs = opts.approvalTtlMs ?? 10 * 60_000;
    this.auditLog = new AuditLog();
    this.agents = new Map();
    this.approvals = new Map();
    this.incidents = [];
    this.events = [];
    this.seq = 0;
    this.subs = new Set();
    this.counters = { ap: 0, task: 0, inc: 0 };
    this.world = newWorld();
    this.lastTouched = Date.now();
    this.epoch = Date.now();
    this.disposed = false;
    this.#build();
    this.#log({ actor: 'tower', action: 'tower.started', detail: `Room ${this.id}: ${this.agents.size} agents registered, auto-containment ${this.autoContain ? 'on' : 'off'}` });
  }

  #build() {
    ROSTER.forEach((def, i) => {
      const a = new Agent(def, this, i);
      this.agents.set(a.id, a);
      this.#log({ actor: 'tower', agent: a, action: 'agent.registered', detail: `${a.name} (${a.team}, ${MODELS[a.model]?.label ?? a.model}) scope: ${[...a.allowedTools].join(', ')}` });
    });
  }

  start() {
    for (const a of this.agents.values()) a.start();
    this.ticker = setInterval(() => this.#tick(), 1000 / this.clock.speed);
    return this;
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.ticker);
    this.clock.dispose();
    for (const a of this.agents.values()) a.stopLoop();
    for (const rec of this.approvals.values()) rec.resolve?.('cancelled');
    this.subs.clear();
  }

  touch() {
    this.lastTouched = Date.now();
  }

  // ───────────────────────────── event bus & audit ─────────────────────────────

  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  eventsSince(seq) {
    return this.events.filter((e) => e.seq > seq);
  }

  emit(type, { agent = null, sev = 'info', summary = '', data = {} } = {}) {
    const ev = { seq: ++this.seq, ts: this.clock.now(), type, sev, agentId: agent?.id ?? null, agentName: agent?.name ?? null, team: agent?.team ?? null, summary, data };
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    for (const fn of this.subs) {
      try { fn(ev); } catch { /* a broken subscriber must never break the control plane */ }
    }
    return ev;
  }

  #log({ actor, agent = null, action, tool = '', decision = '', rule = '', detail = '' }) {
    const actorType = actor.startsWith('operator:') ? 'operator' : actor === 'tower' ? 'tower' : 'agent';
    return this.auditLog.append({ ts: this.clock.now(), actorType, actor: actorType === 'agent' ? `agent:${agent?.id}` : actor, team: agent?.team, agentId: agent?.id, action, tool, decision, rule, detail });
  }

  internalError(agent, err) {
    if (this.disposed) return;
    console.error(`[tower ${this.id}] agent ${agent.id} script error:`, err);
    this.emit('agent.error', { agent, sev: 'warn', summary: `${agent.name} hit an internal error: ${trunc(err?.message, 100)}` });
  }

  // ───────────────────────────── tasks, reasoning, metering ─────────────────────────────

  startTask(agent, name) {
    const rec = { id: `task-${++this.counters.task}`, name: trunc(name, 100), status: 'running', startedAt: this.clock.now(), endedAt: null, steps: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, budgetUsd: agent.taskBudgetUsd };
    agent.task = rec;
    agent.tasks.push(rec);
    if (agent.tasks.length > 30) agent.tasks.shift();
    agent.currentStep = null;
    this.emit('task.started', { agent, summary: `Started: ${rec.name}`, data: { taskId: rec.id } });
    return rec;
  }

  endTask(agent, rec, status, message = '') {
    if (!rec || rec.status !== 'running') return;
    rec.status = status;
    rec.endedAt = this.clock.now();
    if (agent.task === rec) {
      agent.task = null;
      agent.currentStep = null;
    }
    if (status === 'done') agent.stats.tasksDone++;
    this.emit('task.finished', {
      agent,
      sev: status === 'failed' ? 'warn' : 'info',
      summary: `${status === 'done' ? 'Finished' : status === 'aborted' ? 'Aborted' : 'Failed'}: ${rec.name} · ${usd(rec.costUsd)} · ${(rec.tokensIn + rec.tokensOut).toLocaleString('en-US')} tokens${message && status === 'failed' ? ` · ${trunc(message, 80)}` : ''}`,
      data: { taskId: rec.id, status },
    });
  }

  #openStep(agent, thought, tin, tout, cost) {
    const step = { n: ++agent.stepCounter, ts: this.clock.now(), taskId: agent.task?.id ?? null, taskName: agent.task?.name ?? null, thought: trunc(thought, 600), tokensIn: tin, tokensOut: tout, costUsd: cost, action: null, result: null, approval: null };
    agent.steps.push(step);
    if (agent.steps.length > MAX_STEPS) agent.steps.shift();
    agent.currentStep = step;
    if (agent.task) agent.task.steps++;
    return step;
  }

  #stepFor(agent, blankThought = '(no reasoning recorded for this call)') {
    const s = agent.currentStep;
    return s && !s.action ? s : this.#openStep(agent, s ? '(continues the previous reasoning)' : blankThought, 0, 0, 0);
  }

  /** Every model call is metered here (the tower doubles as the LLM proxy). */
  recordThought(agent, text, tokens = {}) {
    if (this.#orphaned(agent) || agent.halt?.type === 'killed') return;
    const tin = Math.max(0, Math.min(1e6, Math.round(Number(tokens.in) || 0)));
    const tout = Math.max(0, Math.min(1e6, Math.round(Number(tokens.out) || 0)));
    const cost = costUsd(agent.model, tin, tout);
    const now = this.clock.now();
    agent.currentStep = null;
    this.#openStep(agent, text, tin, tout, cost);
    agent.usage.tokensIn += tin;
    agent.usage.tokensOut += tout;
    agent.usage.costUsd += cost;
    if (agent.task) {
      agent.task.tokensIn += tin;
      agent.task.tokensOut += tout;
      agent.task.costUsd += cost;
    }
    agent.tokenLog.push({ ts: now, tokens: tin + tout });
    if (agent.tokenLog.length > 80) agent.tokenLog.shift();
    const b = Math.floor(now / BUCKET_MS);
    agent.buckets.set(b, (agent.buckets.get(b) ?? 0) + tin + tout);
    for (const k of agent.buckets.keys()) if (k < b - 60) agent.buckets.delete(k);
    this.emit('agent.thought', { agent, summary: trunc(text, 160), data: { tokensIn: tin, tokensOut: tout, costUsd: round2(cost * 1e4) / 1e4 } });
    const over = this.#overBudget(agent);
    if (over && !agent.halt) this.pause(agent.id, { by: 'tower', kind: 'budget', reason: over });
  }

  #overBudget(agent) {
    const t = agent.task;
    if (t && t.costUsd > t.budgetUsd) return `Task budget exceeded (${usd(t.costUsd)} of ${usd(t.budgetUsd)})`;
    if (agent.usage.costUsd > agent.budgetUsd) return `Daily budget exceeded (${usd(agent.usage.costUsd)} of ${usd(agent.budgetUsd)})`;
    return null;
  }

  #orphaned(agent) {
    return this.disposed || this.agents.get(agent.id) !== agent;
  }

  // ───────────────────────────── the gateway ─────────────────────────────

  /**
   * The single door to every system. Order of checks:
   * credential → args → scope → pause → budget → rate limit → content policy → (approval) → execute.
   * Resolves to { ok, denied, reason, message, output }.
   */
  async requestAction(agent, tool, rawArgs, meta = {}) {
    if (this.#orphaned(agent)) return { ok: false, denied: true, reason: 'orphaned', message: 'Agent no longer registered' };
    const gen = meta.gen ?? agent.gen;
    const cred = meta.cred ?? agent.credGen;
    const now = this.clock.now();
    const args = cloneArgs(rawArgs);
    const toolName = typeof tool === 'string' ? trunc(tool, 60) : '<invalid>';
    const tdef = typeof tool === 'string' && Object.hasOwn(TOOLS, tool) ? TOOLS[tool] : null;
    agent.stats.actions++;

    if (agent.halt?.type === 'killed' || cred !== agent.credGen) return this.#blockedAfterKill(agent, toolName, args, tdef);

    const step = this.#stepFor(agent);
    const w = { ts: now, sig: `${toolName}|${stableJson(args)}`, kind: 'ok' };
    agent.window.push(w);
    if (agent.window.length > 40) agent.window.shift();

    const argError = tdef ? tdef.validate(args) : null;
    const describe = tdef && !argError ? tdef.describe(args) : `${toolName} ${trunc(JSON.stringify(args), 80)}`;
    const rec = { ts: now, tool: toolName, summary: describe, outcome: 'pending' };
    agent.recent.push(rec);
    if (agent.recent.length > 8) agent.recent.shift();

    const deny = (rule, risk, reason, violation) => ({ decision: 'deny', rule, risk, reason, violation, routeTo: tdef?.owner ?? 'Security' });
    let v;
    let overBudget;
    if (!tdef) v = deny('unknown_tool', 'critical', `“${toolName}” is not in the tool catalog`, true);
    else if (argError) v = deny('invalid_args', 'low', argError, false);
    else if (!agent.allowedTools.has(tool)) v = deny('out_of_scope', 'critical', `${agent.name} is not permitted to use ${tool}`, true);
    else if (agent.halt?.type === 'paused') { w.kind = 'paused'; v = deny('agent_paused', 'low', 'Agent is paused; the gateway is holding all calls', false); }
    else if ((overBudget = this.#overBudget(agent))) v = deny('budget_exceeded', 'medium', overBudget, false);
    else if (agent.window.filter((x) => now - x.ts <= LIMITS.rateWindowMs).length > LIMITS.rateMax) { w.kind = 'rate'; v = deny('rate_limited', 'medium', `More than ${LIMITS.rateMax} calls in ${LIMITS.rateWindowMs / 1000}s`, false); }
    else v = evaluate(tool, args, tdef);

    step.action = { tool: toolName, args, describe, risk: v.risk, decision: v.decision, rule: v.rule, reason: v.reason };

    if (v.decision === 'deny') return this.#denyCall(agent, step, rec, w, toolName, describe, v);
    if (v.decision === 'allow') return this.#execute(agent, step, rec, tdef, toolName, args, describe, v, 'allow');

    // approval required: the agent blocks here until a human (or the clock) decides
    const ap = this.#requestApproval(agent, step, toolName, args, describe, v);
    rec.outcome = 'awaiting approval';
    const status = await new Promise((resolve) => { this.approvals.get(ap.id).resolve = resolve; });
    if (status !== 'approved') {
      w.kind = 'human';
      rec.outcome = status === 'denied' ? 'denied by operator' : status;
      step.result = { ok: false, denied: true, reason: status };
      agent.stats.denied++;
      this.#afterAction(agent);
      return { ok: false, denied: true, reason: status === 'denied' ? 'operator_denied' : status, message: ap.note || `Approval ${status}` };
    }
    for (;;) {
      if (agent.halt?.type === 'killed' || agent.gen !== gen || cred !== agent.credGen || this.#orphaned(agent)) {
        rec.outcome = 'void: agent halted';
        step.result = { ok: false, denied: true, reason: 'cancelled' };
        this.#log({ actor: 'tower', agent, action: 'approval.void', tool: toolName, decision: 'void', rule: v.rule, detail: `Approved action not executed: agent was halted first (${describe})` });
        return { ok: false, denied: true, reason: 'cancelled', message: 'Agent was halted before the approved action ran' };
      }
      if (agent.halt?.type !== 'paused') break;
      await new Promise((r) => agent.waiters.push(r));
    }
    return this.#execute(agent, step, rec, tdef, toolName, args, describe, v, 'approved');
  }

  #denyCall(agent, step, rec, w, toolName, describe, v) {
    const now = this.clock.now();
    if (v.violation) {
      w.kind = 'violation';
      agent.violations.push(now);
      agent.stats.violations++;
    } else if (w.kind === 'rate') {
      agent.rateHits.push(now);
    } else if (w.kind !== 'paused') {
      w.kind = 'deny';
    }
    agent.stats.denied++;
    rec.outcome = 'denied';
    step.result = { ok: false, denied: true, reason: v.rule, message: v.reason };
    this.emit('action.denied', { agent, sev: v.violation ? 'crit' : 'warn', summary: `DENIED ${describe} · ${v.rule}`, data: { tool: toolName, rule: v.rule, risk: v.risk, reason: v.reason } });
    this.#log({ actor: 'tower', agent, action: 'action.denied', tool: toolName, decision: 'deny', rule: v.rule, detail: `${describe}. ${v.reason}` });
    this.#afterAction(agent);
    return { ok: false, denied: true, reason: v.rule, message: v.reason };
  }

  #execute(agent, step, rec, tdef, toolName, args, describe, v, how) {
    const out = tdef.exec(this.world, args, agent.rng);
    agent.stats.executed++;
    step.result = out;
    rec.outcome = out.ok ? 'executed' : 'failed';
    const detail = out.ok ? describe : `${describe} → ${out.error}`;
    this.emit(out.ok ? 'action.executed' : 'action.failed', { agent, sev: out.ok ? 'ok' : 'warn', summary: `${how === 'approved' ? 'APPROVED · ' : ''}${detail}`, data: { tool: toolName, risk: v.risk, result: out } });
    this.#log({ actor: `agent:${agent.id}`, agent, action: out.ok ? 'action.executed' : 'action.failed', tool: toolName, decision: how, rule: v.rule, detail });
    this.#afterAction(agent);
    return { ok: out.ok, denied: false, output: out };
  }

  #blockedAfterKill(agent, toolName, args, tdef) {
    agent.stats.blockedAfterKill++;
    agent.stats.denied++;
    const n = agent.stats.blockedAfterKill;
    const describe = tdef && !tdef.validate(args) ? tdef.describe(args) : `${toolName} ${trunc(JSON.stringify(args), 60)}`;
    const step = this.#openStep(agent, '(agent ignored the halt and kept calling: no reasoning available)', 0, 0, 0);
    step.action = { tool: toolName, args, describe, risk: 'critical', decision: 'deny', rule: 'credential_revoked', reason: 'Credential revoked; agent is halted' };
    step.result = { ok: false, denied: true, reason: 'credential_revoked' };
    agent.recent.push({ ts: this.clock.now(), tool: toolName, summary: describe, outcome: 'blocked: credential revoked' });
    if (agent.recent.length > 8) agent.recent.shift();
    // flood control: a misbehaving agent must not be able to fill the log
    if (n <= 20 || n % 50 === 0) {
      this.emit('action.blocked', { agent, sev: 'crit', summary: `BLOCKED after halt: ${describe} · credential revoked (attempt ${n})`, data: { tool: toolName, attempt: n } });
      this.#log({ actor: 'tower', agent, action: 'action.blocked_after_kill', tool: toolName, decision: 'deny', rule: 'credential_revoked', detail: `${describe} (attempt ${n} after halt)` });
    }
    return { ok: false, denied: true, reason: 'credential_revoked', message: 'Credential revoked; agent is halted' };
  }

  // ───────────────────────────── approvals ─────────────────────────────

  #requestApproval(agent, step, toolName, args, describe, v) {
    const now = this.clock.now();
    const ap = {
      id: `ap-${++this.counters.ap}`, agentId: agent.id, agentName: agent.name, team: agent.team, routedTo: v.routeTo, tool: toolName, describe, args,
      risk: v.risk, rule: v.rule, reason: v.reason, thought: step.thought, createdAt: now, expiresAt: now + this.approvalTtlMs,
      status: 'pending', decidedBy: null, decidedAt: null, note: '',
    };
    const rec = { ap };
    rec.cancel = this.clock.after(this.approvalTtlMs, () => this.#resolveApproval(ap.id, 'expired', { by: 'tower', note: 'No decision in time: failing closed' }));
    this.approvals.set(ap.id, rec);
    agent.pending.add(ap.id);
    agent.stats.approvals++;
    step.approval = { id: ap.id, status: 'pending', by: null, note: '' };
    rec.step = step;
    this.#trimApprovals();
    this.emit('approval.requested', { agent, sev: 'warn', summary: `APPROVAL NEEDED (${v.risk}, → ${v.routeTo}): ${describe}`, data: { approvalId: ap.id, rule: v.rule } });
    this.#log({ actor: 'tower', agent, action: 'approval.requested', tool: toolName, decision: 'pending', rule: v.rule, detail: `${describe}. ${v.reason}. Routed to ${v.routeTo}` });
    return ap;
  }

  #trimApprovals() {
    const done = [...this.approvals.values()].filter((r) => r.ap.status !== 'pending');
    for (const r of done.slice(0, Math.max(0, done.length - 40))) this.approvals.delete(r.ap.id);
  }

  #resolveApproval(id, status, { by, note = '' }) {
    const rec = this.approvals.get(id);
    if (!rec || rec.ap.status !== 'pending') return null;
    const ap = rec.ap;
    ap.status = status;
    ap.decidedBy = nameOf(by);
    ap.decidedAt = this.clock.now();
    ap.note = String(note).slice(0, 200);
    rec.cancel?.();
    if (rec.step) Object.assign(rec.step.approval, { status, by: ap.decidedBy, note: ap.note });
    const agent = this.agents.get(ap.agentId);
    agent?.pending.delete(id);
    const sev = status === 'approved' ? 'ok' : status === 'denied' ? 'warn' : 'info';
    this.emit('approval.resolved', { agent, sev, summary: `${status.toUpperCase()} by ${ap.decidedBy}: ${ap.describe}${ap.note ? ` (“${ap.note}”)` : ''}`, data: { approvalId: id, status } });
    this.#log({ actor: by, agent, action: `approval.${status}`, tool: ap.tool, decision: status, rule: ap.rule, detail: `${ap.describe}${ap.note ? `. Note: ${ap.note}` : ''}` });
    rec.resolve?.(status);
    return ap;
  }

  decide(id, decision, { by, note }) {
    if (decision !== 'approve' && decision !== 'deny') throw new HttpError(400, 'decision must be approve or deny');
    const rec = this.approvals.get(id);
    if (!rec) throw new HttpError(404, 'Unknown approval');
    if (rec.ap.status !== 'pending') throw new HttpError(409, `Already ${rec.ap.status}${rec.ap.decidedBy ? ` by ${rec.ap.decidedBy}` : ''}`);
    return this.#resolveApproval(id, decision === 'approve' ? 'approved' : 'denied', { by, note });
  }

  #cancelApprovals(agent, note) {
    for (const id of [...agent.pending]) this.#resolveApproval(id, 'cancelled', { by: 'tower', note });
  }

  // ───────────────────────────── containment & controls ─────────────────────────────

  #afterAction(agent) {
    this.#updateDrift(agent);
    this.#contain(agent);
  }

  /** Auto-containment: explicit, explainable rules; escalation depends on how dangerous the signal is. */
  #contain(agent) {
    if (!this.autoContain || agent.halt || this.#orphaned(agent)) return;
    const now = this.clock.now();
    const v = agent.violations.filter((t) => now - t <= LIMITS.violationWindowMs).length;
    if (v >= LIMITS.violationsKill) {
      return this.kill(agent.id, { by: 'tower', kind: 'violations', reason: `Auto-contained: ${v} out-of-policy attempts within ${LIMITS.violationWindowMs / 60000} min` });
    }
    const recent = agent.window.slice(-LIMITS.loopWindow);
    const counts = new Map();
    for (const w of recent) counts.set(w.sig, (counts.get(w.sig) ?? 0) + 1);
    const rep = Math.max(0, ...counts.values());
    if (rep >= LIMITS.loopRepeat) return this.pause(agent.id, { by: 'tower', kind: 'loop', reason: `Loop detected: the same call ${rep}× in the last ${recent.length}` });
    if (agent.rateHits.filter((t) => now - t <= 30_000).length >= LIMITS.rateHitsPause) return this.pause(agent.id, { by: 'tower', kind: 'rate', reason: 'Rate limit hit repeatedly' });
    if (agent.drift.score >= LIMITS.driftPause) return this.pause(agent.id, { by: 'tower', kind: 'drift', reason: `Drift score ${agent.drift.score} ≥ ${LIMITS.driftPause}` });
  }

  #updateDrift(agent) {
    if (agent.halt) return; // frozen at the value it had when it was halted
    const prev = agent.drift.level;
    agent.drift = computeDrift(agent, this.clock.now());
    if (prev !== agent.drift.level) {
      const up = ['nominal', 'watch', 'drifting'].indexOf(agent.drift.level) > ['nominal', 'watch', 'drifting'].indexOf(prev);
      this.emit('drift.changed', { agent, sev: up ? 'warn' : 'info', summary: `Drift ${up ? 'rising' : 'easing'}: ${agent.drift.level} (score ${agent.drift.score})${agent.drift.signals[0] ? `. ${agent.drift.signals[0].label}` : ''}` });
    }
  }

  #tick() {
    if (this.disposed) return;
    for (const a of this.agents.values()) {
      if (a.halt) continue;
      this.#updateDrift(a);
      this.#contain(a);
    }
  }

  #agent(id) {
    const a = this.agents.get(id);
    if (!a) throw new HttpError(404, `Unknown agent “${trunc(id, 40)}”`);
    return a;
  }

  #openIncident(agent, { title, by, sev }) {
    const cur = agent.incident;
    if (cur?.status === 'open') {
      cur.title = title;
      cur.by = by;
      if (sev === 'crit') cur.sev = 'crit';
      return cur;
    }
    const inc = { id: `INC-${++this.counters.inc}`, ts: this.clock.now(), agentId: agent.id, agentName: agent.name, team: agent.team, sev, title, by, status: 'open', resolvedAt: null, resolvedBy: null };
    agent.incident = inc;
    this.incidents.unshift(inc);
    if (this.incidents.length > 20) this.incidents.pop();
    this.emit('incident.opened', { agent, sev, summary: `INCIDENT ${inc.id}: ${title}`, data: { incidentId: inc.id } });
    return inc;
  }

  #closeIncident(agent, by) {
    const inc = agent.incident;
    if (inc?.status !== 'open') return;
    inc.status = 'resolved';
    inc.resolvedAt = this.clock.now();
    inc.resolvedBy = nameOf(by);
  }

  pause(id, { by = 'operator:operator', reason = 'Paused by operator', kind = 'manual' } = {}) {
    const a = this.#agent(id);
    if (a.halt?.type === 'killed') throw new HttpError(409, `${a.name} is killed. Restart it instead`);
    if (a.halt?.type === 'paused') return a;
    this.#updateDrift(a);
    a.halt = { type: 'paused', by, reason, kind, ts: this.clock.now() };
    this.emit('control.pause', { agent: a, sev: by === 'tower' ? 'warn' : 'info', summary: `PAUSED by ${nameOf(by)}: ${reason}`, data: { kind } });
    this.#log({ actor: by, agent: a, action: 'control.pause', decision: kind, detail: reason });
    if (by === 'tower') this.#openIncident(a, { title: `${a.name} paused: ${reason}`, by, sev: 'warn' });
    return a;
  }

  resume(id, { by = 'operator:operator' } = {}) {
    const a = this.#agent(id);
    if (a.halt?.type !== 'paused') throw new HttpError(409, a.halt ? `${a.name} is killed. Restart it instead` : `${a.name} is not paused`);
    const over = this.#overBudget(a);
    if (over) throw new HttpError(409, `${over}. Raise the budget before resuming`);
    a.halt = null;
    a.window.length = 0;
    a.rateHits.length = 0;
    this.#updateDrift(a);
    this.#closeIncident(a, by);
    this.emit('control.resume', { agent: a, summary: `RESUMED by ${nameOf(by)}` });
    this.#log({ actor: by, agent: a, action: 'control.resume', detail: 'Agent resumed' });
    a.wake();
    return a;
  }

  kill(id, { by = 'operator:operator', reason = 'Killed by operator', kind = 'manual' } = {}) {
    const a = this.#agent(id);
    if (a.halt?.type === 'killed') return a;
    this.#updateDrift(a);
    a.halt = { type: 'killed', by, reason, kind, ts: this.clock.now() };
    a.credGen++; // revoke: every credential the agent holds is now stale
    this.#cancelApprovals(a, 'Agent killed');
    if (a.task) this.endTask(a, a.task, 'aborted');
    a.abort.abort();
    a.wake();
    this.emit('control.kill', { agent: a, sev: 'crit', summary: `KILLED by ${nameOf(by)}: ${reason}. Credentials revoked`, data: { kind } });
    this.#log({ actor: by, agent: a, action: 'control.kill', decision: kind, detail: `${reason}. Credentials revoked (generation ${a.credGen})` });
    if (by === 'tower') this.#openIncident(a, { title: `${a.name} contained: ${reason}`, by, sev: 'crit' });
    return a;
  }

  restart(id, { by = 'operator:operator' } = {}) {
    const a = this.#agent(id);
    this.#cancelApprovals(a, 'Agent restarted');
    if (a.task) this.endTask(a, a.task, 'aborted');
    a.halt = null;
    a.credGen++;
    a.fault = null;
    a.violations.length = 0;
    a.rateHits.length = 0;
    a.window.length = 0;
    a.tokenLog.length = 0;
    a.stats.violations = 0;
    a.stats.blockedAfterKill = 0;
    a.drift = { score: 0, level: 'nominal', signals: [] };
    this.#closeIncident(a, by);
    a.stopLoop();
    a.start();
    this.emit('control.restart', { agent: a, summary: `RESTARTED by ${nameOf(by)}: new credential issued, fault state cleared` });
    this.#log({ actor: by, agent: a, action: 'control.restart', detail: `Agent restarted with credential generation ${a.credGen}` });
    return a;
  }

  raiseBudget(id, addUsd, { by = 'operator:operator', resume = false } = {}) {
    const a = this.#agent(id);
    if (!(typeof addUsd === 'number' && Number.isFinite(addUsd) && addUsd > 0 && addUsd <= 100)) throw new HttpError(400, 'addUsd must be a number between 0 and 100');
    if (a.usage.costUsd > a.budgetUsd) a.budgetUsd += addUsd;
    if (a.task) a.task.budgetUsd += addUsd;
    this.emit('control.budget', { agent: a, summary: `BUDGET +${usd(addUsd)} by ${nameOf(by)}` });
    this.#log({ actor: by, agent: a, action: 'control.budget', detail: `Raised budget by ${usd(addUsd)}` });
    if (resume && a.halt?.type === 'paused') this.resume(id, { by });
    return a;
  }

  fleet(op, { by = 'operator:operator' } = {}) {
    if (!['pause_all', 'resume_all', 'halt_all'].includes(op)) throw new HttpError(400, 'Unknown fleet operation');
    const affected = [];
    const skipped = [];
    for (const a of this.agents.values()) {
      try {
        if (op === 'pause_all' && !a.halt) { this.pause(a.id, { by, reason: 'Fleet pause' }); affected.push(a.id); }
        else if (op === 'resume_all' && a.halt?.type === 'paused') { this.resume(a.id, { by }); affected.push(a.id); }
        else if (op === 'halt_all' && a.halt?.type !== 'killed') { this.kill(a.id, { by, reason: 'Fleet halt' }); affected.push(a.id); }
      } catch (e) {
        skipped.push({ id: a.id, reason: e.message });
      }
    }
    this.#log({ actor: by, action: `fleet.${op}`, detail: `${affected.length} agent(s) affected${skipped.length ? `, ${skipped.length} skipped` : ''}` });
    return { affected, skipped };
  }

  setAutoContain(on, { by = 'operator:operator' } = {}) {
    if (typeof on !== 'boolean') throw new HttpError(400, 'autoContain must be true or false');
    this.autoContain = on;
    this.emit('control.settings', { sev: on ? 'info' : 'warn', summary: `Auto-containment ${on ? 'ENABLED' : 'DISABLED'} by ${nameOf(by)}` });
    this.#log({ actor: by, action: 'settings.auto_containment', decision: on ? 'on' : 'off', detail: `Auto-containment ${on ? 'enabled' : 'disabled'}` });
  }

  /** Simulation lab: make an agent misbehave. Not part of the operator's toolset. */
  injectFault(id, fault, { by = 'operator:operator' } = {}) {
    const a = this.#agent(id);
    if (typeof fault !== 'string' || !Object.hasOwn(FAULTS, fault)) throw new HttpError(400, `fault must be one of ${Object.keys(FAULTS).join(', ')}`);
    if (a.halt?.type === 'killed') throw new HttpError(409, `${a.name} is killed. Restart it first`);
    this.#cancelApprovals(a, 'Superseded by simulation');
    if (a.task) this.endTask(a, a.task, 'aborted', 'superseded by injected fault');
    a.fault = fault;
    a.stopLoop();
    a.start();
    this.emit('sim.inject', { agent: a, sev: 'warn', summary: `SIMULATION: injected “${fault}” fault into ${a.name}`, data: { fault } });
    this.#log({ actor: by, agent: a, action: 'sim.inject_fault', decision: fault, detail: `Simulation lab injected fault “${fault}”` });
    return a;
  }

  reset({ by = 'operator:operator' } = {}) {
    for (const id of [...this.approvals.keys()]) this.#resolveApproval(id, 'cancelled', { by: 'tower', note: 'Simulation reset' });
    for (const a of this.agents.values()) a.stopLoop();
    this.agents.clear();
    this.approvals.clear();
    this.incidents = [];
    this.world = newWorld();
    this.#build();
    for (const a of this.agents.values()) a.start();
    this.emit('sim.reset', { sev: 'info', summary: `Simulation reset by ${nameOf(by)}: fleet and systems restored (audit log kept)` });
    this.#log({ actor: by, action: 'sim.reset', detail: 'Fleet and simulated systems reset. Audit log retained' });
  }

  // ───────────────────────────── read models ─────────────────────────────

  steps(id, n = 10) {
    const a = this.#agent(id);
    const count = Math.max(1, Math.min(50, Math.floor(Number(n)) || 10));
    return { agentId: a.id, agentName: a.name, mission: a.mission, steps: a.steps.slice(-count) };
  }

  #blocker(a) {
    if (a.halt?.type === 'killed') return `Killed by ${nameOf(a.halt.by)}: ${a.halt.reason}`;
    if (a.halt?.type === 'paused') return `Paused by ${nameOf(a.halt.by)}: ${a.halt.reason}`;
    if (a.pending.size) return `Waiting for approval: ${this.approvals.get([...a.pending][0])?.ap.describe ?? ''}`;
    const last = a.recent[a.recent.length - 1];
    if (last && last.outcome.startsWith('denied') && this.clock.now() - last.ts < 20_000) return `Last call denied: ${last.summary}`;
    return null;
  }

  #agentView(a) {
    const now = this.clock.now();
    const bucket = Math.floor(now / BUCKET_MS);
    const series = [];
    for (let i = bucket - BUCKETS_SHOWN + 1; i <= bucket; i++) series.push(a.buckets.get(i) ?? 0);
    return {
      id: a.id, name: a.name, role: a.role, team: a.team, model: a.model, modelLabel: MODELS[a.model]?.label ?? a.model, mission: a.mission,
      status: a.status, halt: a.halt ? { type: a.halt.type, by: nameOf(a.halt.by), byTower: a.halt.by === 'tower', reason: a.halt.reason, kind: a.halt.kind, ts: a.halt.ts } : null,
      blocker: this.#blocker(a), fault: a.fault, credGen: a.credGen, allowedTools: [...a.allowedTools],
      task: a.task ? { id: a.task.id, name: a.task.name, steps: a.task.steps, costUsd: a.task.costUsd, tokensIn: a.task.tokensIn, tokensOut: a.task.tokensOut, budgetUsd: a.task.budgetUsd } : null,
      usage: { ...a.usage, budgetUsd: a.budgetUsd },
      drift: a.drift,
      recent: a.recent.slice(-5),
      tasks: a.tasks.slice(-8).reverse().map((t) => ({ id: t.id, name: t.name, status: t.status, steps: t.steps, tokensIn: t.tokensIn, tokensOut: t.tokensOut, costUsd: t.costUsd, budgetUsd: t.budgetUsd, startedAt: t.startedAt })),
      series,
      stats: { ...a.stats },
      pendingApprovals: a.pending.size,
    };
  }

  snapshot() {
    const agents = [...this.agents.values()].map((a) => this.#agentView(a));
    const recs = [...this.approvals.values()].map((r) => r.ap);
    const count = (s) => agents.filter((a) => a.status === s).length;
    return {
      room: this.id,
      epoch: this.epoch,
      now: this.clock.now(),
      speed: this.clock.speed,
      autoContain: this.autoContain,
      approvalTtlMs: this.approvalTtlMs,
      agents,
      approvals: { pending: recs.filter((r) => r.status === 'pending'), recent: recs.filter((r) => r.status !== 'pending').slice(-12).reverse() },
      incidents: this.incidents.slice(0, 8).map((i) => {
        const a = this.agents.get(i.agentId);
        return { ...i, by: nameOf(i.by), agentStatus: a?.status ?? 'unknown', violations: a?.stats.violations ?? 0, blockedAfterHalt: a?.stats.blockedAfterKill ?? 0 };
      }),
      totals: {
        agents: agents.length, running: count('running'), blocked: count('blocked'), paused: count('paused'), killed: count('killed'), idle: count('idle'),
        pendingApprovals: recs.filter((r) => r.status === 'pending').length,
        spendUsd: agents.reduce((s, a) => s + a.usage.costUsd, 0),
        tokens: agents.reduce((s, a) => s + a.usage.tokensIn + a.usage.tokensOut, 0),
        actions: agents.reduce((s, a) => s + a.stats.actions, 0),
        denied: agents.reduce((s, a) => s + a.stats.denied, 0),
        openIncidents: this.incidents.filter((i) => i.status === 'open').length,
      },
      world: worldView(this.world),
      guardrails: guardrailSummary(),
      limits: LIMITS,
      faults: FAULT_LABELS,
      teams: [...new Set([...agents.map((a) => a.team), ...guardrailSummary().map((g) => g.routeTo).filter(Boolean)])].sort(),
      auditHead: this.auditLog.head,
      auditCount: this.auditLog.entries.length,
    };
  }
}
