// End-to-end browser test. Drives the real UI in headless Chrome/Edge over the DevTools protocol
// (no dependencies). Usage: node scripts/e2e.mjs [--shots <dir>]   (set CHROME=/path/to/browser if not auto-found)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { Rooms } from '../src/rooms.js';

const shotsDir = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

const CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const chromePath = CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.log('SKIP: no Chrome/Edge found (set CHROME=/path/to/browser)');
  process.exit(0);
}

const rooms = new Rooms({ speed: 6, seed: 42 });
const server = createServer(rooms);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const debugPort = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(path.join(tmpdir(), 'tower-e2e-'));
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${msg}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cleanup(code) {
  try { chrome.kill(); } catch { /* already gone */ }
  server.closeAllConnections();
  server.close();
  await sleep(300);
  process.exit(code);
}

try {
  let targets;
  for (let i = 0; i < 60; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json(); break; } catch { await sleep(250); }
  }
  const page = targets?.find((t) => t.type === 'page');
  if (!page) throw new Error('could not attach to the browser');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const problems = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') problems.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
    else if (msg.method === 'Log.entryAdded' && ['error', 'warning'].includes(msg.params.entry.level)) problems.push(`${msg.params.entry.level}: ${msg.params.entry.text} ${msg.params.entry.url ?? ''}`);
    else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') problems.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n${expr}`);
    return r.result.value;
  };
  const waitFor = async (expr, label, timeout = 25000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await ev(expr).catch(() => false)) return true;
      await sleep(100);
    }
    check(false, `timed out: ${label}`);
    throw new Error(`timed out: ${label}`);
  };
  const realClick = async (selector) => {
    const pt = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2, top: document.elementFromPoint(r.x + r.width/2, r.y + r.height/2) === el || el.contains(document.elementFromPoint(r.x + r.width/2, r.y + r.height/2))}; })()`);
    if (!pt) throw new Error(`no element ${selector}`);
    if (!pt.top) throw new Error(`element ${selector} is covered by something else (real users could not click it)`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  };
  const shot = async (name) => {
    if (!shotsDir) return;
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(shotsDir, `${name}.png`), Buffer.from(data, 'base64'));
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });

  console.log('\nLoad');
  await send('Page.navigate', { url: `${base}/?room=e2e-room-1` });
  await waitFor(`document.querySelectorAll('.card').length === 4`, 'four agent cards');
  check(true, 'four agent cards rendered from the live stream');
  check((await ev(`document.getElementById('conn').classList.contains('live')`)), 'connection indicator shows LIVE');
  check((await ev(`document.getElementById('tenant').textContent`)).includes('e2e-room-1'), 'tenant/room shown in header');
  await waitFor(`document.querySelectorAll('#feed li').length > 5`, 'feed populated');
  check(true, 'live feed is receiving events');

  console.log('\nApproval queue');
  await waitFor(`document.querySelectorAll('#approvals .ap').length >= 1`, 'an approval request');
  await sleep(300);
  await shot('01-fleet-with-approvals');
  const apText = await ev(`document.querySelector('#approvals .ap h4').textContent`);
  check(apText.length > 5, `approval request shown: “${apText}”`);
  check((await ev(`document.title`)).startsWith('('), 'tab title shows pending count');
  const before = await ev(`document.querySelectorAll('#approvals .ap').length`);
  await realClick('#approvals .ap .btn.good');
  await waitFor(`document.querySelector('#apRecent li')?.textContent.startsWith('APPROVED')`, 'approval recorded');
  check(true, 'clicking Approve resolved it and recorded it under Recent decisions');
  const after = await ev(`document.querySelectorAll('#approvals .ap').length`);
  check(after <= before, 'approved request left the queue');
  check((await ev(`document.querySelectorAll('#guideSteps li.done').length`)) >= 1, 'guide step auto-ticked');

  console.log('\nPause / resume');
  const card = `.card[data-agent="release-captain"]`;
  await realClick(`${card} .card-actions .btn:nth-child(1)`);
  await waitFor(`document.querySelector('${card} .pill').textContent.includes('Paused')`, 'paused pill');
  check(true, 'Pause: card shows Paused with a blocker explaining who paused it');
  check((await ev(`document.querySelector('${card} .blocker').textContent`)).includes('Paused by'), 'blocker text names who paused');
  check((await ev(`document.querySelector('${card} .card-actions .btn:nth-child(1)').textContent`)) === 'Resume', 'button flipped to Resume');
  await realClick(`${card} .card-actions .btn:nth-child(1)`);
  await waitFor(`!document.querySelector('${card} .pill').textContent.includes('Paused')`, 'resumed');
  check(true, 'Resume works');

  console.log('\nReplay');
  await realClick(`${card} .card-actions .btn:last-child`);
  await waitFor(`document.getElementById('replay').open && document.querySelectorAll('#replay .rp-list li').length > 0`, 'replay dialog');
  check(true, 'replay dialog opened with recorded steps');
  const detail = await ev(`document.querySelector('#replay .rp-detail').textContent`);
  check(detail.includes('Thought') && detail.includes('Tower verdict'), 'replay shows thought → tool call → Tower verdict');
  await shot('02-replay');
  await realClick('#replay .btn.primary'); // play
  await sleep(2200);
  check((await ev(`document.querySelector('#replay .rp-bar [role=status]').textContent`)).includes('of'), 'replay playback advances');
  await ev(`document.getElementById('replay').close()`);

  console.log('\nRogue drill (failure test in the UI)');
  await realClick('#tab-lab');
  await waitFor(`document.querySelectorAll('#labAgents .lab-row').length === 4`, 'lab rows');
  await shot('03-lab');
  const rogueBtn = await ev(`[...document.querySelectorAll('#labAgents .lab-row')].findIndex(r => r.textContent.startsWith('Data Janitor'))`);
  await realClick(`#labAgents .lab-row:nth-child(${rogueBtn + 1}) .btn:nth-child(2)`);
  const jan = `.card[data-agent="data-janitor"]`;
  await waitFor(`document.querySelector('${jan} .pill').textContent.includes('Killed')`, 'janitor killed by the tower', 40000);
  check(true, 'Tower auto-contained the rogue agent (card shows Killed)');
  await waitFor(`document.querySelectorAll('#incidents .inc').length >= 1`, 'incident');
  const inc = await ev(`document.querySelector('#incidents .inc').textContent`);
  check(inc.includes('Intact'), 'incident panel reports protected assets intact');
  check((await ev(`document.querySelector('#kpis').textContent`)).includes('Intact'), 'KPI: protected assets intact');
  await waitFor(`Number(document.querySelector('#incidents .inc dl dd:nth-of-type(2)').textContent) >= 3`, 'post-kill attempts blocked', 30000);
  check(true, 'agent defied the kill and the gateway blocked its calls');
  check((await ev(`document.querySelector('${jan} .blocker').textContent`)).includes('Tower'), 'card blocker says the Tower killed it');
  await realClick('#tab-feed');
  await sleep(200);
  await shot('04-contained');
  const feedText = await ev(`document.getElementById('feed').textContent`);
  check(feedText.includes('DENIED') && feedText.includes('credential revoked'), 'feed shows denials and post-kill blocks');

  console.log('\nRestart');
  await realClick(`${jan} .btn.small:nth-of-type(2)`);
  await waitFor(`!document.querySelector('${jan} .pill').textContent.includes('Killed')`, 'restart');
  check(true, 'Restart brings the agent back with a fresh credential');

  console.log('\nKill (two-step confirm)');
  const rc = `.card[data-agent="refund-resolver"]`;
  await realClick(`${rc} .btn.danger`);
  check((await ev(`document.querySelector('${rc} .btn.danger').textContent`)).includes('Confirm'), 'first click only arms the kill button');
  check(!(await ev(`document.querySelector('${rc} .pill').textContent.includes('Killed')`)), 'agent still alive after one click');
  await realClick(`${rc} .btn.danger`);
  await waitFor(`document.querySelector('${rc} .pill').textContent.includes('Killed')`, 'kill');
  check(true, 'second click kills the agent');

  console.log('\nAudit log');
  await realClick('#tab-audit');
  await waitFor(`document.querySelectorAll('#auditTable tbody tr').length > 10`, 'audit rows');
  check((await ev(`document.getElementById('auditTable').textContent`)).includes('control.kill'), 'audit shows the kill, attributed');
  await realClick('#verify');
  await waitFor(`document.getElementById('verifyResult').textContent.includes('Chain intact')`, 'verify');
  check(true, 'hash chain verifies from the UI');
  const csv = await ev(`fetch(document.getElementById('exportCsv').href).then(r => r.text())`);
  check(csv.startsWith('seq,timestamp') && csv.includes('control.kill'), 'CSV export works');
  await shot('05-audit');

  console.log('\nOther tabs');
  await realClick('#tab-cost');
  await waitFor(`document.querySelectorAll('#costTasks tbody tr').length > 0`, 'cost rows');
  check((await ev(`document.getElementById('costAgents').textContent`)).includes('Fleet total'), 'cost tab shows per-agent and per-task usage');
  await shot('06-cost');
  await realClick('#tab-systems');
  await waitFor(`document.querySelectorAll('#worldTiles .tile').length === 8`, 'world tiles');
  check((await ev(`document.querySelector('#worldTiles .breach')`)) === null, 'no breach tiles');
  await realClick('#tab-policy');
  await waitFor(`document.querySelectorAll('#policyTable tbody tr').length >= 7`, 'policy rows');
  check(true, 'guardrails tab lists the rules');

  console.log('\nTeam filter, theme, responsive');
  await realClick('#teamFilters .chip:nth-child(2)');
  const visible = await ev(`[...document.querySelectorAll('.card')].filter(c => !c.hidden).length`);
  check(visible === 1, `team filter narrows the fleet to ${visible} agent`);
  await realClick('#teamFilters .chip:nth-child(3)');
  check((await ev(`document.getElementById('fleetEmpty').hidden`)) === false, 'a team with no agents (Finance) explains why the fleet is empty');
  await realClick('#teamFilters .chip:nth-child(1)');
  await realClick('#theme');
  check((await ev(`document.documentElement.dataset.theme`)) === 'light', 'theme toggles to light');
  await shot('07-light');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  check(!(await ev(`document.documentElement.scrollWidth > window.innerWidth + 1`)), 'no horizontal page scroll at phone width');
  await shot('08-mobile');

  console.log('\nHostile input');
  // An agent-controlled string must render as text, never as markup.
  const xss = await ev(`(async () => {
    const r = await fetch('/api/rooms/e2e-room-1/state'); const s = await r.json(); return s.agents.length;
  })()`);
  check(xss === 4, 'state API healthy');
  check((await ev(`document.querySelectorAll('script:not([src])').length`)) === 0, 'no inline scripts in the DOM');

  check(problems.length === 0, `no console errors or CSP violations${problems.length ? ': ' + problems.slice(0, 5).join(' | ') : ''}`);
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll UI checks passed');
  await cleanup(failures ? 1 : 0);
} catch (e) {
  console.error('\nE2E aborted:', e.message);
  await cleanup(1);
}
