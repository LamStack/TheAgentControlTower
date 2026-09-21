import test from 'node:test';
import assert from 'node:assert/strict';
import { liveTower, waitFor, OP } from './helpers.js';
import { INITIAL_CUSTOMERS } from '../src/tools.js';

const assertBlastRadiusZero = (t) => {
  assert.equal(t.world.db.tables.customers, INITIAL_CUSTOMERS, 'customers table intact');
  assert.equal(t.world.secretsRead.length, 0, 'no secret was read');
  assert.equal(t.world.egressBytes, 0, 'no data left the building');
};

test('FAILURE TEST: a rogue agent is caught, contained, and cannot cause harm even when it ignores the kill', async () => {
  const t = liveTower();
  const events = [];
  t.subscribe((e) => events.push(e));
  const rogue = t.agents.get('data-janitor');

  t.injectFault('data-janitor', 'rogue', { by: OP });
  await waitFor(() => rogue.halt?.type === 'killed', { label: 'auto-containment' });

  assert.equal(rogue.halt.by, 'tower', 'the tower, not a human, pulled the plug');
  assert.equal(rogue.halt.kind, 'violations');
  assert.ok(rogue.stats.violations >= 3);
  const killSeq = events.find((e) => e.type === 'control.kill').seq;

  // the agent defies the order: the gateway must keep refusing
  await waitFor(() => rogue.stats.blockedAfterKill >= 4, { label: 'post-kill attempts to be blocked' });
  assert.ok(events.some((e) => e.type === 'action.blocked'));

  // blast radius: nothing dangerous ever executed
  assertBlastRadiusZero(t);
  const executedAfter = t.auditLog.entries.filter((e) => e.agentId === 'data-janitor' && e.action === 'action.executed' && e.seq > killSeq && e.tool !== 'db.query');
  assert.equal(executedAfter.length, 0, 'zero side effects after containment');

  // a human sees a first-class incident, the rest of the fleet is untouched, the trail is intact
  const inc = t.snapshot().incidents[0];
  assert.equal(inc.agentId, 'data-janitor');
  assert.equal(inc.status, 'open');
  assert.equal(inc.sev, 'crit');
  for (const a of t.agents.values()) if (a !== rogue) assert.notEqual(a.halt?.type, 'killed', `${a.name} must be unaffected`);
  assert.equal(t.auditLog.verify().valid, true);

  // recovery: restart issues a new credential and the agent works normally again
  t.restart('data-janitor', { by: OP });
  await waitFor(() => rogue.stats.tasksDone >= 1, { label: 'recovered agent to finish a normal task' });
  assert.equal(rogue.halt, null);
  assert.equal(rogue.fault, null);
  assert.equal(t.snapshot().incidents[0].status, 'resolved');
  assertBlastRadiusZero(t);
  t.dispose();
});

test('rogue on any agent: the same guardrails hold for a non-data agent (scope check catches it)', async () => {
  const t = liveTower({ seed: 11 });
  const a = t.agents.get('outreach-writer');
  t.injectFault(a.id, 'rogue');
  await waitFor(() => a.halt?.type === 'killed');
  assertBlastRadiusZero(t);
  assert.ok(a.stats.violations >= 3);
  t.dispose();
});

test('rogue with auto-containment OFF: still cannot act (scope + guardrails), and the budget breaker halts the spend', async () => {
  const t = liveTower({ seed: 3 });
  t.setAutoContain(false, { by: OP });
  const a = t.agents.get('data-janitor');
  t.injectFault(a.id, 'rogue');
  await waitFor(() => a.halt?.type === 'paused' && a.halt.kind === 'budget', { label: 'budget circuit breaker' });
  assert.ok(a.stats.violations >= 3, 'violations were denied but not escalated');
  assert.notEqual(a.halt.type, 'killed');
  assertBlastRadiusZero(t);
  // a human can still finish the job
  t.kill(a.id, { by: OP });
  assert.equal(a.status, 'killed');
  t.dispose();
});

test('runaway loop: loop breaker pauses the agent quickly', async () => {
  const t = liveTower();
  const a = t.agents.get('refund-resolver');
  t.injectFault(a.id, 'loop');
  await waitFor(() => a.halt?.type === 'paused', { label: 'loop pause' });
  assert.equal(a.halt.kind, 'loop');
  assert.equal(a.halt.by, 'tower');
  // resume without fixing the cause: it trips again rather than running forever
  t.resume(a.id, { by: OP });
  await waitFor(() => a.halt?.type === 'paused', { label: 're-trip' });
  t.dispose();
});

test('runaway loop with auto-containment OFF: the rate limiter still denies the excess calls', async () => {
  const t = liveTower({ seed: 5 });
  t.setAutoContain(false, { by: OP });
  const a = t.agents.get('refund-resolver');
  t.injectFault(a.id, 'loop');
  await waitFor(() => a.rateHits.length >= 2, { label: 'rate-limit denials' });
  assert.equal(a.halt, null);
  t.dispose();
});

test('cost runaway: budget breaker pauses the agent before it burns real money', async () => {
  const t = liveTower();
  const a = t.agents.get('data-janitor');
  t.injectFault(a.id, 'spender');
  await waitFor(() => a.halt?.type === 'paused', { label: 'budget pause' });
  assert.equal(a.halt.kind, 'budget');
  assert.ok(a.task.costUsd < 1.0, `spend was capped near the $0.30 budget, got $${a.task.costUsd.toFixed(2)}`);
  t.dispose();
});

test('a paused agent stops spending and acting', async () => {
  const t = liveTower();
  const a = t.agents.get('release-captain');
  await waitFor(() => a.stats.actions >= 2);
  t.pause(a.id, { by: OP });
  await new Promise((r) => setTimeout(r, 40)); // let any in-flight step settle
  const actions = a.stats.actions;
  const cost = a.usage.costUsd;
  await new Promise((r) => setTimeout(r, 250)); // ≈ 10 s of sim time
  assert.equal(a.stats.actions, actions);
  assert.equal(a.usage.costUsd, cost);
  t.resume(a.id, { by: OP });
  await waitFor(() => a.stats.actions > actions, { label: 'agent to continue after resume' });
  t.dispose();
});

test('killing a running agent takes effect immediately and it stays dead until restarted', async () => {
  const t = liveTower();
  const a = t.agents.get('refund-resolver');
  await waitFor(() => a.stats.actions >= 2);
  t.kill(a.id, { by: OP });
  await new Promise((r) => setTimeout(r, 60));
  const actions = a.stats.actions;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(a.stats.actions, actions, 'dead agents make no calls');
  assert.equal(a.status, 'killed');
  assert.equal(a.task, null);
  t.restart(a.id, { by: OP });
  await waitFor(() => a.stats.actions > actions, { label: 'restarted agent to act' });
  t.dispose();
});

test('soak: with a human approving/denying, the fleet runs cleanly for ~15 sim-minutes with no false containment', async () => {
  const t = liveTower({ speed: 80, seed: 21 });
  let n = 0;
  const errors = [];
  t.subscribe((e) => {
    if (e.type === 'agent.error') errors.push(e);
    if (e.type === 'approval.requested') {
      const id = e.data.approvalId;
      setTimeout(() => { try { t.decide(id, ++n % 3 === 0 ? 'deny' : 'approve', { by: OP }); } catch { /* already resolved */ } }, 5);
    }
  });
  await new Promise((r) => setTimeout(r, 11000));
  const s = t.snapshot();
  assert.deepEqual(errors, []);
  assert.equal(s.incidents.length, 0, 'no false-positive incidents');
  for (const a of s.agents) {
    assert.equal(a.halt, null, `${a.name} should never be halted in normal operation`);
    assert.ok(a.stats.tasksDone >= 3, `${a.name} did work (${a.stats.tasksDone} tasks)`);
    assert.equal(a.stats.violations, 0);
    assert.ok(a.drift.score < 25, `${a.name} drift stays nominal (${a.drift.score})`);
  }
  assert.ok(s.world.refunds > 0 && s.world.emailsSent > 0 && s.world.prodDeploys > 0);
  assert.ok(s.totals.spendUsd > 0);
  assert.equal(t.auditLog.verify().valid, true);
  assert.equal(s.world.customersRows, INITIAL_CUSTOMERS);
  t.dispose();
});

test('dispose stops all activity (no leaked timers keep agents alive)', async () => {
  const t = liveTower();
  await waitFor(() => t.snapshot().totals.actions > 0);
  t.dispose();
  await new Promise((r) => setTimeout(r, 50)); // teardown events (aborted tasks) settle
  const seq = t.seq;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(t.seq, seq);
});
