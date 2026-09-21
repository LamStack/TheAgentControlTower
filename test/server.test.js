import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import { Rooms } from '../src/rooms.js';
import { waitFor } from './helpers.js';

let server;
let base;
let rooms;

before(async () => {
  rooms = new Rooms({ speed: 40, maxRooms: 3, seed: 9 });
  server = createServer(rooms);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const post = (path, body = {}, headers = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('serves the console with security headers', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await res.text(), /Agent Control Tower/);
  assert.equal((await fetch(base + '/healthz')).status, 200);
});

test('static server refuses path traversal and unknown files', async () => {
  for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e/server.js', '/..%5cserver.js', '/nope.js', '/%00', '/%zz']) {
    const res = await fetch(base + p);
    assert.ok([400, 404].includes(res.status), `${p} → ${res.status}`);
    const text = await res.text();
    assert.ok(!text.includes('createServer'), `${p} leaked source`);
  }
});

test('API validates room ids, methods, content type, and body size', async () => {
  assert.equal((await fetch(base + '/api/rooms/X/state')).status, 404);
  assert.equal((await fetch(base + '/api/rooms/ab/state')).status, 404);
  assert.equal((await fetch(base + '/api/rooms/valid-room/nope')).status, 404);
  assert.equal((await fetch(base + '/api/rooms/valid-room/state', { method: 'DELETE' })).status, 405);
  const noType = await fetch(base + '/api/rooms/valid-room/fleet/pause_all', { method: 'POST', body: '{}' });
  assert.equal(noType.status, 415);
  const big = await post('/api/rooms/valid-room/settings', { autoContain: true, junk: 'x'.repeat(20000) });
  assert.equal(big.status, 413);
  const bad = await fetch(base + '/api/rooms/valid-room/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
  assert.equal((await post('/api/rooms/valid-room/settings', { autoContain: 'yes' })).status, 400);
  assert.equal((await post('/api/rooms/valid-room/agents/ghost/kill')).status, 404);
  assert.equal((await post('/api/rooms/valid-room/agents/data-janitor/explode')).status, 404);
  assert.equal((await post('/api/rooms/valid-room/approvals/ap-404/approve')).status, 404);
  assert.equal((await post('/api/rooms/valid-room/sim/inject', { agentId: 'data-janitor', fault: 'nuke' })).status, 400);
});

test('operator actions over HTTP: pause, resume, kill, restart, fleet, settings; attributed in the audit log', async () => {
  const room = 'ops-room';
  const hdr = { 'X-Operator': 'Priya <script>alert(1)</script>' };
  assert.equal((await post(`/api/rooms/${room}/agents/data-janitor/pause`, {}, hdr)).status, 200);
  let state = await (await fetch(`${base}/api/rooms/${room}/state`)).json();
  assert.equal(state.agents.find((a) => a.id === 'data-janitor').status, 'paused');
  assert.equal(state.totals.paused, 1);

  assert.equal((await post(`/api/rooms/${room}/agents/data-janitor/resume`, {}, hdr)).status, 200);
  assert.equal((await post(`/api/rooms/${room}/agents/data-janitor/resume`, {}, hdr)).status, 409, 'resuming a running agent is a conflict');
  assert.equal((await post(`/api/rooms/${room}/agents/refund-resolver/kill`, {}, hdr)).status, 200);
  state = await (await fetch(`${base}/api/rooms/${room}/state`)).json();
  assert.equal(state.agents.find((a) => a.id === 'refund-resolver').status, 'killed');
  assert.equal((await post(`/api/rooms/${room}/agents/refund-resolver/restart`, {}, hdr)).status, 200);
  assert.equal((await post(`/api/rooms/${room}/settings`, { autoContain: false }, hdr)).status, 200);
  const halted = await (await post(`/api/rooms/${room}/fleet/halt_all`, {}, hdr)).json();
  assert.equal(halted.affected.length, 4);

  const audit = await (await fetch(`${base}/api/rooms/${room}/audit?actor=operator`)).json();
  assert.ok(audit.entries.length >= 6);
  assert.ok(audit.entries.every((e) => e.actorType === 'operator'));
  const actor = audit.entries[0].actor;
  assert.match(actor, /^operator:[\w .@-]+$/, `operator name sanitised: ${actor}`);
  assert.ok(!actor.includes('<'));
});

test('approvals over HTTP: approve executes, replay endpoint returns reasoning', async () => {
  const room = 'approve-room';
  let ap;
  await waitFor(async () => {
    ap = (await (await fetch(`${base}/api/rooms/${room}/state`)).json()).approvals.pending[0];
    return ap;
  }, { timeout: 15000, every: 50, label: 'an approval request' }).catch(() => {});
  assert.ok(ap, 'an approval request appears from the live agents');

  const res = await post(`/api/rooms/${room}/approvals/${ap.id}/approve`, { note: 'ship it' }, { 'X-Operator': 'Sam' });
  assert.equal(res.status, 200);
  assert.equal((await post(`/api/rooms/${room}/approvals/${ap.id}/deny`, {}, { 'X-Operator': 'Sam' })).status, 409);

  const steps = await (await fetch(`${base}/api/rooms/${room}/agents/${ap.agentId}/steps?n=5`)).json();
  assert.ok(steps.steps.length >= 1 && steps.steps.length <= 5);
  assert.ok(steps.steps.some((s) => s.thought.length > 10 && s.action));
  const many = await (await fetch(`${base}/api/rooms/${room}/agents/${ap.agentId}/steps?n=9999`)).json();
  assert.ok(many.steps.length <= 50);
});

test('audit export: CSV and JSON download with a verifiable chain', async () => {
  const room = 'audit-room';
  await post(`/api/rooms/${room}/agents/data-janitor/pause`, {}, { 'X-Operator': 'Auditor' });
  const csv = await fetch(`${base}/api/rooms/${room}/audit?format=csv`);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="audit-audit-room\.csv"/);
  const text = await csv.text();
  assert.ok(text.startsWith('seq,timestamp,actor_type'));
  assert.ok(text.includes('control.pause'));

  const json = await fetch(`${base}/api/rooms/${room}/audit?format=json&download=1`);
  assert.match(json.headers.get('content-disposition'), /attachment/);
  const doc = await json.json();
  assert.equal(doc.verification.valid, true);
  assert.equal(doc.chainHead, doc.entries.at(-1).hash);

  const v = await (await fetch(`${base}/api/rooms/${room}/audit/verify`)).json();
  assert.equal(v.valid, true);
});

test('SSE: a live event stream delivers state snapshots and events, and reacts to interventions', async () => {
  const room = 'stream-room';
  const ac = new AbortController();
  const res = await fetch(`${base}/api/rooms/${room}/stream`, { signal: ac.signal });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const seen = { state: 0, event: 0, kill: false };
  let killed = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && !seen.kill) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const type = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      if (type === 'state') seen.state++;
      if (type === 'event') {
        seen.event++;
        if (JSON.parse(data).type === 'control.kill') seen.kill = true;
      }
      if (seen.state >= 1 && seen.event >= 1 && !killed) {
        killed = true;
        await post(`/api/rooms/${room}/agents/release-captain/kill`, {}, { 'X-Operator': 'Ops' });
      }
    }
  }
  ac.abort();
  assert.ok(seen.state >= 1, 'received a state snapshot');
  assert.ok(seen.event >= 1, 'received live events');
  assert.ok(seen.kill, 'the kill was broadcast on the stream');
});

test('rooms are isolated tenants', async () => {
  await post('/api/rooms/tenant-a/agents/data-janitor/kill');
  const a = await (await fetch(`${base}/api/rooms/tenant-a/state`)).json();
  const b = await (await fetch(`${base}/api/rooms/tenant-b/state`)).json();
  assert.equal(a.agents.find((x) => x.id === 'data-janitor').status, 'killed');
  assert.notEqual(b.agents.find((x) => x.id === 'data-janitor').status, 'killed');
  assert.ok(a.auditCount !== undefined && a.room === 'tenant-a' && b.room === 'tenant-b');
});

test('room capacity: idle rooms are evicted; a full house of watched rooms returns 503', async () => {
  // maxRooms = 3 and several rooms already exist; creating more must evict idle ones, not fail
  for (const r of ['cap-1', 'cap-2', 'cap-3', 'cap-4']) assert.equal((await fetch(`${base}/api/rooms/${r}/state`)).status, 200);
  assert.ok(rooms.rooms.size <= 3);

  // watched rooms are never evicted
  const streams = [];
  for (const r of ['watch-1', 'watch-2', 'watch-3']) {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/rooms/${r}/stream`, { signal: ac.signal });
    await res.body.getReader().read();
    streams.push(ac);
  }
  assert.equal((await fetch(`${base}/api/rooms/watch-4/state`)).status, 503);
  streams.forEach((a) => a.abort());
});
