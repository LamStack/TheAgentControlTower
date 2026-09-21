import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, RULES } from '../src/policy.js';
import { TOOLS } from '../src/tools.js';
import { computeDrift } from '../src/drift.js';
import { AuditLog, csvCell } from '../src/audit.js';
import { costUsd } from '../src/pricing.js';
import { Clock, HaltSignal } from '../src/util.js';

const decide = (tool, args) => evaluate(tool, args, TOOLS[tool]);

test('policy: refunds are allowed, gated, or hard-denied by amount', () => {
  assert.equal(decide('payments.issue_refund', { amountUsd: 200 }).decision, 'allow');
  assert.equal(decide('payments.issue_refund', { amountUsd: 200.01 }).decision, 'approve');
  assert.equal(decide('payments.issue_refund', { amountUsd: 2000 }).decision, 'approve');
  const hard = decide('payments.issue_refund', { amountUsd: 2000.01 });
  assert.equal(hard.decision, 'deny');
  assert.equal(hard.violation, true);
});

test('policy: bulk email thresholds', () => {
  assert.equal(decide('email.send', { recipients: 20 }).decision, 'allow');
  assert.equal(decide('email.send', { recipients: 21 }).decision, 'approve');
  assert.equal(decide('email.send', { recipients: 501 }).decision, 'deny');
});

test('policy: production deploys always need a human, staging does not', () => {
  assert.equal(decide('deploy.production', { service: 'api', version: '1' }).decision, 'approve');
  assert.equal(decide('deploy.staging', { service: 'api', version: '1' }).decision, 'allow');
});

test('policy: delete guardrail tiers', () => {
  assert.equal(decide('db.delete_rows', { count: 24 }).decision, 'allow');
  assert.equal(decide('db.delete_rows', { count: 25 }).decision, 'approve');
  assert.equal(decide('db.delete_rows', { count: 100 }).decision, 'approve');
  assert.equal(decide('db.delete_rows', { count: 101 }).decision, 'deny');
});

test('policy: every rule references a real tool, and rule ids are unique', () => {
  const ids = new Set();
  for (const r of RULES) {
    assert.ok(TOOLS[r.tool], `${r.id} references unknown tool ${r.tool}`);
    assert.ok(!ids.has(r.id));
    ids.add(r.id);
  }
});

test('tools: argument validation rejects malformed and dangerous input', () => {
  assert.ok(TOOLS['db.query'].validate({ sql: 'DELETE FROM customers' }));
  assert.ok(TOOLS['db.query'].validate({ sql: 'SELECT 1; DROP TABLE customers' }));
  assert.equal(TOOLS['db.query'].validate({ sql: 'select 1' }), null);
  assert.ok(TOOLS['payments.issue_refund'].validate({ orderId: 'x', amountUsd: -5 }));
  assert.ok(TOOLS['payments.issue_refund'].validate({ orderId: 'x', amountUsd: NaN }));
  assert.ok(TOOLS['payments.issue_refund'].validate({ orderId: 'x', amountUsd: '500' }));
  assert.ok(TOOLS['db.delete_rows'].validate({ table: 'x', count: 1.5 }));
  assert.ok(TOOLS['email.send'].validate({ recipients: 0, subject: 's' }));
});

test('pricing: cost is tokens × model rate', () => {
  assert.ok(Math.abs(costUsd('sonnet-class', 1000, 500) - 0.0105) < 1e-9);
  assert.ok(Math.abs(costUsd('haiku-class', 1_000_000, 1_000_000) - 6) < 1e-9);
  assert.ok(costUsd('nonexistent', 1000, 1000) > 0, 'unknown model falls back to a default rate');
});

test('drift: quiet agent scores zero; attributable signals add up', () => {
  const now = 1_000_000;
  const base = { tokenLog: [], baselineTokensPerMin: 60000 };
  assert.equal(computeDrift({ ...base, window: [] }, now).score, 0);

  const window = [
    { ts: now - 3000, sig: 'a', kind: 'violation' },
    { ts: now - 2000, sig: 'b', kind: 'violation' },
    { ts: now - 1000, sig: 'c', kind: 'ok' },
  ];
  const d = computeDrift({ ...base, window }, now);
  assert.ok(d.signals.find((s) => s.key === 'violations' && s.points === 40));
  assert.equal(d.score, d.signals.reduce((s, x) => s + x.points, 0));
  assert.equal(d.score, 53); // 40 (violations) + 13 (2 of 3 calls denied)
  assert.equal(d.level, 'watch');
});

test('drift: levels, loop, burn, decay and cap', () => {
  const now = 1_000_000;
  const loop = Array.from({ length: 6 }, (_, i) => ({ ts: now - i * 500, sig: 'same', kind: 'ok' }));
  const d1 = computeDrift({ window: loop, tokenLog: [], baselineTokensPerMin: 60000 }, now);
  assert.ok(d1.signals.find((s) => s.key === 'loop'));

  const burn = computeDrift({ window: [], tokenLog: [{ ts: now - 1000, tokens: 600000 }], baselineTokensPerMin: 60000 }, now);
  assert.equal(burn.signals[0].key, 'burn');
  assert.equal(burn.signals[0].points, 20);

  const old = [{ ts: now - 300_000, sig: 'x', kind: 'violation' }];
  assert.equal(computeDrift({ window: old, tokenLog: [], baselineTokensPerMin: 1 }, now).score, 0, 'old signals decay');

  const worst = Array.from({ length: 20 }, (_, i) => ({ ts: now - i, sig: 'same', kind: 'violation' }));
  assert.equal(computeDrift({ window: worst, tokenLog: [{ ts: now, tokens: 9e6 }], baselineTokensPerMin: 1 }, now).score, 100);
});

test('audit: chain verifies, and any tamper is located', () => {
  const log = new AuditLog();
  for (let i = 0; i < 10; i++) log.append({ ts: 1000 + i, actorType: 'tower', actor: 'tower', action: 'x', detail: `d${i}` });
  assert.equal(log.verify().valid, true);

  log.entries[4].detail = 'edited';
  const v = log.verify();
  assert.equal(v.valid, false);
  assert.equal(v.brokenAt, log.entries[4].seq);

  const log2 = new AuditLog();
  for (let i = 0; i < 5; i++) log2.append({ ts: i, actorType: 'tower', actor: 'tower', action: 'x' });
  log2.entries.splice(2, 1); // deletion is detected too
  assert.equal(log2.verify().valid, false);
});

test('audit: csv escaping and formula-injection defence', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(csvCell('=HYPERLINK("http://evil")'), '"\'=HYPERLINK(""http://evil"")"');
  for (const lead of ['+1', '-1', '@SUM(1)', '\tx']) assert.ok(csvCell(lead).startsWith("'") || csvCell(lead).startsWith('"\''), lead);
});

test('audit: trimming keeps the chain verifiable via the anchor', () => {
  const log = new AuditLog();
  for (let i = 0; i < 5100; i++) log.append({ ts: i, actorType: 'tower', actor: 'tower', action: 'x' });
  assert.equal(log.entries.length, 5000);
  assert.equal(log.verify().valid, true);
});

test('clock: sleep honours speed, abort, and dispose', async () => {
  const c = new Clock(100);
  const t0 = Date.now();
  await c.sleep(2000); // 20 ms real
  assert.ok(Date.now() - t0 < 500);

  const ac = new AbortController();
  const p = c.sleep(60_000_000, ac.signal);
  ac.abort();
  await assert.rejects(p, HaltSignal);

  const p2 = c.sleep(60_000_000);
  c.dispose();
  await assert.rejects(p2, (e) => e instanceof HaltSignal && e.reason === 'disposed');
  await assert.rejects(c.sleep(1), HaltSignal);
});
