import { h, svg, setText, setClass, setHidden, keyedList, clear, usd, num, clock, mmss, mb } from './dom.js';
import { openReplay } from './replay.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage may be blocked; the app works without it */ } },
};
const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

// ───────────────────────────── room, operator, api ─────────────────────────────

function pickRoom() {
  const p = new URLSearchParams(location.search).get('room');
  if (p && /^[a-z0-9-]{4,40}$/.test(p)) return p;
  const b = crypto.getRandomValues(new Uint8Array(6));
  const id = `r-${[...b].map((x) => x.toString(36).padStart(2, '0')).join('')}`;
  history.replaceState(null, '', `?room=${id}`);
  return id;
}
const room = pickRoom();
const opInput = $('operator');
opInput.value = store.get('operator') ?? '';
opInput.addEventListener('input', () => store.set('operator', opInput.value));
const operatorName = () => opInput.value.replace(/[^\w .@-]/g, '').trim() || 'Guest operator';

let toastCount = 0;
function toast(msg, sev = 'info') {
  if (toastCount >= 4) return;
  toastCount++;
  const el = h('div', { class: `toast ${sev}` }, msg);
  $('toasts').append(el);
  setTimeout(() => { el.remove(); toastCount--; }, sev === 'crit' ? 9000 : 5000);
}

async function call(path, body = {}) {
  try {
    const res = await fetch(`/api/rooms/${room}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Operator': operatorName() },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(data.error ?? `Request failed (${res.status})`, 'warn');
      return null;
    }
    return data;
  } catch {
    toast('Could not reach the Tower. Check your connection.', 'crit');
    return null;
  }
}

/** Two-click safety for irreversible-feeling actions: first click arms, second confirms. */
function armable(btn, { label, confirmLabel, run, bypass = () => false }) {
  let t = null;
  const disarm = () => {
    clearTimeout(t);
    delete btn.dataset.armed;
    btn.classList.remove('armed');
    setText(btn, btn.dataset.label ?? label);
  };
  btn.dataset.label = label;
  btn.addEventListener('click', () => {
    if (bypass()) {
      run(true);
      return;
    }
    if (btn.dataset.armed) {
      disarm();
      run(false);
      return;
    }
    btn.dataset.armed = '1';
    btn.classList.add('armed');
    setText(btn, confirmLabel);
    t = setTimeout(disarm, 4000);
  });
  return { setLabel(l) { btn.dataset.label = l; if (!btn.dataset.armed) setText(btn, l); }, disarm };
}

// ───────────────────────────── guided demo ─────────────────────────────

const GUIDE = [
  { id: 'decide', text: 'Approve or deny a request in the Approval queue.' },
  { id: 'pause', text: 'Pause an agent from its card, then resume it.' },
  { id: 'replay', text: 'Click “Replay reasoning” on any agent.' },
  { id: 'rogue', text: 'Make the Data Janitor go rogue and watch the Tower contain it.', drill: true },
  { id: 'kill', text: 'Kill an agent, or restart the contained one.' },
  { id: 'export', text: 'Export the audit log (Audit log tab).' },
];
const guideKey = `guide-${room}`;
let guideDone = new Set();
try { guideDone = new Set(JSON.parse(store.get(guideKey) ?? '[]')); } catch { /* ignore */ }
const guideRefs = {};
function markDone(id) {
  if (guideDone.has(id)) return;
  guideDone.add(id);
  store.set(guideKey, JSON.stringify([...guideDone]));
  paintGuide();
}
function paintGuide() {
  for (const g of GUIDE) {
    const li = guideRefs[g.id];
    li.classList.toggle('done', guideDone.has(g.id));
    setText(li.querySelector('.tick'), guideDone.has(g.id) ? '✓' : '');
  }
  setText($('guideProgress'), `${guideDone.size} of ${GUIDE.length} done`);
}
async function rogueDrill() {
  const janitor = state?.agents.find((a) => a.id === 'data-janitor');
  if (janitor?.status === 'killed') await call('agents/data-janitor/restart');
  if (await call('sim/inject', { agentId: 'data-janitor', fault: 'rogue' })) {
    markDone('rogue');
    toast('Rogue fault injected into the Data Janitor. Watch its card and the Incidents panel.', 'warn');
  }
}
for (const g of GUIDE) {
  const li = h('li', {}, h('span', { class: 'tick', 'aria-hidden': 'true' }), h('span', { class: 'txt' }, g.text),
    g.drill ? h('button', { class: 'btn small', type: 'button', onclick: rogueDrill }, 'Run drill') : null);
  guideRefs[g.id] = li;
  $('guideSteps').append(li);
}
paintGuide();
$('guideToggle').addEventListener('click', () => {
  const collapsed = $('guide').classList.toggle('collapsed');
  $('guideToggle').setAttribute('aria-expanded', String(!collapsed));
  setText($('guideToggle'), collapsed ? 'Show' : 'Hide');
});

// ───────────────────────────── state & stream ─────────────────────────────

let state = null;
let stateAt = 0;
let epoch = null;
let lastSeq = 0;
let team = 'all';
let renderQueued = false;

function connect() {
  const es = new EventSource(`/api/rooms/${room}/stream`);
  es.addEventListener('open', () => setConn('live', 'Live'));
  es.addEventListener('error', () => setConn('down', 'Reconnecting…'));
  es.addEventListener('state', (e) => {
    const s = JSON.parse(e.data);
    if (epoch !== null && s.epoch !== epoch) {
      lastSeq = 0; // the room was restarted server-side: its event numbering starts over
      clear($('feed'));
    }
    epoch = s.epoch;
    state = s;
    stateAt = Date.now();
    scheduleRender();
  });
  es.addEventListener('event', (e) => {
    const ev = JSON.parse(e.data);
    if (ev.seq <= lastSeq) return;
    lastSeq = ev.seq;
    addFeed(ev);
    react(ev);
  });
}
function setConn(cls, text) {
  setClass($('conn'), `conn ${cls}`);
  setText($('conn').lastElementChild, text);
}
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function react(ev) {
  if (ev.type === 'incident.opened') toast(ev.summary, ev.sev === 'crit' ? 'crit' : 'warn');
  else if (ev.type === 'agent.error') toast(ev.summary, 'warn');
}

// ───────────────────────────── feed ─────────────────────────────

const ICON = {
  'agent.thought': '…', 'action.executed': '✓', 'action.failed': '!', 'action.denied': '✕', 'action.blocked': '⊘',
  'approval.requested': '?', 'approval.resolved': '↳', 'task.started': '▸', 'task.finished': '■', 'drift.changed': '≈',
  'incident.opened': '▲', 'agent.error': '!',
};
const catOf = (t) => (t === 'agent.thought' ? 'thoughts' : t.startsWith('action.') || t.startsWith('approval.') ? 'decisions' : t.startsWith('control.') || t.startsWith('incident.') || t.startsWith('sim.') || t === 'drift.changed' ? 'control' : 'other');
const feedFilter = () => $('feedFilter').value;
const feedVisible = (li) => {
  const f = feedFilter();
  const okCat = f === 'all' || li.dataset.cat === f;
  const okTeam = team === 'all' || !li.dataset.team || li.dataset.team === team;
  return okCat && okTeam;
};
function addFeed(ev) {
  const li = h('li', { class: `${ev.sev}${ev.type === 'agent.thought' ? ' thought' : ''}`, dataset: { cat: catOf(ev.type), team: ev.team ?? '' } },
    h('span', { class: 'time' }, clock(ev.ts)),
    h('span', { class: 'who' }, ev.agentName ?? 'Tower'),
    h('span', { class: 'ic', 'aria-hidden': 'true' }, ICON[ev.type] ?? '•'),
    h('span', { class: 'msg' }, ev.summary));
  li.hidden = !feedVisible(li);
  const feed = $('feed');
  feed.prepend(li);
  while (feed.children.length > 300) feed.lastChild.remove();
}
function refilterFeed() {
  for (const li of $('feed').children) li.hidden = !feedVisible(li);
}
$('feedFilter').addEventListener('change', refilterFeed);

// ───────────────────────────── KPIs ─────────────────────────────

const kpiRefs = {};
for (const [key, label] of [['fleet', 'Fleet'], ['approvals', 'Waiting on a human'], ['spend', 'Spend'], ['denied', 'Calls blocked'], ['incidents', 'Open incidents'], ['assets', 'Protected assets']]) {
  const refs = { value: h('div', { class: 'value' }), sub: h('div', { class: 'sub' }) };
  refs.el = h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), refs.value, refs.sub);
  kpiRefs[key] = refs;
  $('kpis').append(refs.el);
}
function paintKpis(s) {
  const t = s.totals;
  const w = s.world;
  const set = (k, value, sub, cls = 'kpi') => {
    setText(kpiRefs[k].value, value);
    setText(kpiRefs[k].sub, sub);
    setClass(kpiRefs[k].el, cls);
  };
  set('fleet', `${t.agents - t.paused - t.killed} of ${t.agents} live`, `${t.running} running · ${t.blocked} blocked · ${t.paused} paused · ${t.killed} killed`);
  const oldest = s.approvals.pending[0];
  set('approvals', t.pendingApprovals, oldest ? `oldest ${mmss(nowSim() - oldest.createdAt)} old` : 'queue is clear', t.pendingApprovals ? 'kpi alert' : 'kpi');
  set('spend', usd(t.spendUsd), `${compact(t.tokens)} tokens`);
  set('denied', num(t.denied), `of ${num(t.actions)} agent calls`);
  set('incidents', t.openIncidents, t.openIncidents ? 'contained by the Tower' : 'all quiet', t.openIncidents ? 'kpi crit' : 'kpi');
  const breach = w.secretsRead > 0 || w.egressCalls > 0 || w.customersRows < w.customersInitial;
  set('assets', breach ? 'BREACH' : 'Intact', `customers ${num(w.customersRows)}/${num(w.customersInitial)} · secrets read ${w.secretsRead} · egress ${mb(w.egressBytes)}`, breach ? 'kpi crit' : 'kpi');
}
const nowSim = () => (state ? state.now + (Date.now() - stateAt) * state.speed : Date.now());

// ───────────────────────────── agent cards ─────────────────────────────

const STATUS = {
  running: ['▶', 'Running'],
  idle: ['◌', 'Idle'],
  blocked: ['◔', 'Needs approval'],
  paused: ['❚❚', 'Paused'],
  killed: ['■', 'Killed'],
};
const OUTCOME_ICON = (o) => (o === 'executed' ? '✓' : o === 'failed' ? '!' : o.startsWith('awaiting') ? '?' : o.startsWith('blocked') ? '⊘' : o === 'pending' ? '…' : '✕');

function sparkline() {
  const poly = svg('polyline', { points: '' });
  const el = svg('svg', { class: 'spark', width: 110, height: 26, viewBox: '0 0 110 26', role: 'img', 'aria-label': 'Token usage over the last 5 minutes' }, svg('title', {}, 'Tokens per 10 s, last 5 minutes'), svg('line', { x1: 0, y1: 25, x2: 110, y2: 25 }), poly);
  return { el, update(series) {
    const max = Math.max(1, ...series);
    const pts = series.map((v, i) => `${((i / (series.length - 1)) * 108 + 1).toFixed(1)},${(24 - (v / max) * 22).toFixed(1)}`).join(' ');
    if (poly.getAttribute('points') !== pts) poly.setAttribute('points', pts);
  } };
}
function metric(label, ...kids) {
  return h('div', { class: 'metric' }, h('div', { class: 'label' }, label), ...kids);
}
function bar() {
  const fill = h('i');
  return { el: h('div', { class: 'bar', 'aria-hidden': 'true' }, fill), set(pct, cls = '') {
    const w = `${Math.max(0, Math.min(100, pct)).toFixed(0)}%`;
    if (fill.style.width !== w) fill.style.width = w;
    setClass(this.el, `bar ${cls}`.trim());
  } };
}

function createCard(a) {
  const r = {};
  r.spark = sparkline();
  r.costBar = bar();
  r.driftBar = bar();
  r.pauseBtn = h('button', { class: 'btn small', type: 'button' });
  r.killBtn = h('button', { class: 'btn small danger', type: 'button' });
  r.budgetBtn = h('button', { class: 'btn small primary', type: 'button', hidden: true }, 'Raise budget +$0.50 & resume');
  r.replayBtn = h('button', { class: 'btn small', type: 'button' }, 'Replay reasoning');
  r.team = h('span', { class: 'team' });
  r.pill = h('span', { class: 'pill' });
  r.blocker = h('div', { class: 'blocker', hidden: true, role: 'status' });
  r.taskName = h('span', { class: 'name' });
  r.cost = h('div', { class: 'val' });
  r.costSub = h('div', { class: 'muted small' });
  r.tokens = h('div', { class: 'val' });
  r.tokensSub = h('div', { class: 'muted small' });
  r.drift = h('div', { class: 'val' });
  r.signals = h('ul', { class: 'drift-signals', hidden: true, 'aria-label': 'Why the drift score is what it is' });
  r.recent = h('ul', { class: 'recent-actions', 'aria-label': 'Recent actions' });
  r.role = h('p', { class: 'role' }, a.role);
  const el = h('article', { class: 'card', 'aria-label': a.name, dataset: { agent: a.id } },
    h('div', { class: 'card-head' }, h('div', {}, h('h3', {}, a.name, r.team), r.role), r.pill),
    r.blocker,
    h('div', { class: 'task' }, r.taskName, r.spark.el),
    h('div', { class: 'metrics' },
      metric('Task cost', r.cost, r.costBar.el, r.costSub),
      metric('Tokens', r.tokens, r.tokensSub),
      metric('Drift', r.drift, r.driftBar.el)),
    r.signals, r.recent,
    h('div', { class: 'card-actions' }, r.pauseBtn, r.killBtn, r.budgetBtn, r.replayBtn));

  let cur = a;
  r.pauseBtn.addEventListener('click', async () => {
    const paused = cur.status === 'paused';
    if (await call(`agents/${cur.id}/${paused ? 'resume' : 'pause'}`)) markDone('pause');
  });
  const killer = armable(r.killBtn, {
    label: 'Kill',
    confirmLabel: 'Confirm kill?',
    bypass: () => cur.status === 'killed', // restarting is not destructive: no confirmation
    run: async (restart) => { if (await call(`agents/${cur.id}/${restart ? 'restart' : 'kill'}`)) markDone('kill'); },
  });
  r.budgetBtn.addEventListener('click', () => call(`agents/${cur.id}/budget`, { addUsd: 0.5, resume: true }));
  r.replayBtn.addEventListener('click', () => { openReplay({ room, agentId: cur.id, dialog: $('replay') }); markDone('replay'); });

  let recentSig = '';
  return { el, update(a) {
    cur = a;
    el.dataset.status = a.status;
    setHidden(el, team !== 'all' && a.team !== team);
    const [icon, label] = STATUS[a.status];
    setClass(r.pill, `pill ${a.status}`);
    setText(r.pill, `${icon} ${label}`);
    setText(r.team, a.team);
    setText(r.role, `${a.role} · ${a.modelLabel}`);
    setText(r.blocker, a.blocker ?? '');
    setHidden(r.blocker, !a.blocker);
    setText(r.taskName, a.task ? `${a.task.name} · step ${a.task.steps}` : a.status === 'killed' ? 'Stopped' : 'Between tasks');
    r.spark.update(a.series);

    if (a.task) {
      const pct = (a.task.costUsd / a.task.budgetUsd) * 100;
      setText(r.cost, `${usd(a.task.costUsd)} / ${usd(a.task.budgetUsd)}`);
      r.costBar.set(pct, pct > 100 ? 'crit' : pct > 70 ? 'warn' : '');
    } else {
      setText(r.cost, 'no active task');
      r.costBar.set(0);
    }
    setText(r.costSub, `today ${usd(a.usage.costUsd)}`);
    setText(r.tokens, `${compact(a.usage.tokensIn)} in · ${compact(a.usage.tokensOut)} out`);
    setText(r.tokensSub, `${a.stats.tasksDone} tasks done`);
    setText(r.drift, `${a.drift.score} · ${a.drift.level}`);
    r.driftBar.set(a.drift.score, a.drift.score >= 60 ? 'crit' : a.drift.score >= 25 ? 'warn' : '');
    const sigs = a.drift.signals.map((s) => `${s.label} (+${s.points})`).join('|');
    if (r.signals.dataset.sig !== sigs) {
      r.signals.dataset.sig = sigs;
      clear(r.signals);
      for (const s of a.drift.signals) r.signals.append(h('li', {}, `${s.label} (+${s.points})`));
    }
    setHidden(r.signals, a.drift.signals.length === 0);

    const rs = a.recent.map((x) => `${x.ts}${x.outcome}`).join('|');
    if (rs !== recentSig) {
      recentSig = rs;
      clear(r.recent);
      for (const x of [...a.recent].reverse().slice(0, 4)) {
        r.recent.append(h('li', { title: `${x.summary} → ${x.outcome}` }, h('span', { class: 'ic', 'aria-hidden': 'true' }, OUTCOME_ICON(x.outcome)), h('span', { class: 't' }, `${x.summary} · ${x.outcome}`)));
      }
      if (!a.recent.length) r.recent.append(h('li', { class: 'muted' }, 'No actions yet'));
    }

    const killed = a.status === 'killed';
    setText(r.pauseBtn, a.status === 'paused' ? 'Resume' : 'Pause');
    r.pauseBtn.disabled = killed;
    killer.setLabel(killed ? 'Restart' : 'Kill');
    r.killBtn.classList.toggle('danger', !killed);
    setHidden(r.budgetBtn, !(a.status === 'paused' && a.halt?.kind === 'budget'));
  } };
}
const renderAgents = keyedList($('agents'), createCard);

// ───────────────────────────── approvals & incidents ─────────────────────────────

function createApproval(ap) {
  const timer = h('span', { class: 'timer' });
  const note = h('input', { type: 'text', maxlength: 120, placeholder: 'Optional note for the audit log', 'aria-label': `Note for ${ap.describe}` });
  const approve = h('button', { class: 'btn small good', type: 'button' }, 'Approve');
  const deny = h('button', { class: 'btn small danger', type: 'button' }, 'Deny');
  const decide = async (which) => {
    approve.disabled = deny.disabled = true;
    const res = await call(`approvals/${ap.id}/${which}`, { note: note.value });
    if (res) markDone('decide');
    else approve.disabled = deny.disabled = false;
  };
  approve.addEventListener('click', () => decide('approve'));
  deny.addEventListener('click', () => decide('deny'));
  const el = h('article', { class: `ap risk-${ap.risk}`, 'aria-label': `Approval request: ${ap.describe}` },
    h('div', { class: 'ap-top' }, h('span', {}, h('span', { class: `risk ${ap.risk}` }, ap.risk), ` ${ap.agentName} → ${ap.routedTo} team`), timer),
    h('h4', {}, ap.describe),
    h('p', { class: 'why' }, `${ap.reason} (rule ${ap.rule})`),
    ap.thought ? h('blockquote', {}, ap.thought) : null,
    h('div', { class: 'ap-actions' }, note, approve, deny));
  return { el, timer, update(ap) {
    setHidden(el, team !== 'all' && ap.routedTo !== team && ap.team !== team);
  } };
}
const renderApprovals = keyedList($('approvals'), createApproval);

function paintTimers() {
  if (!state) return;
  const nodes = renderApprovalsNodes;
  for (const ap of state.approvals.pending) {
    const rec = nodes?.get(ap.id);
    if (!rec) continue;
    const left = ((ap.expiresAt - state.now) / state.speed) - (Date.now() - stateAt);
    setText(rec.timer, `auto-denies in ${mmss(left)}`);
    rec.timer.classList.toggle('soon', left < 60_000);
  }
}
let renderApprovalsNodes = null;

function createIncident(inc) {
  const r = { title: h('strong'), meta: h('div', { class: 'meta' }), viol: h('dd'), after: h('dd'), assets: h('dd'), actions: h('div', { class: 'ap-actions' }) };
  const el = h('article', { class: 'inc' }, r.title, r.meta,
    h('dl', {}, h('dt', {}, 'Violations blocked'), r.viol, h('dt', {}, 'Calls blocked after halt'), r.after, h('dt', {}, 'Protected assets'), r.assets), r.actions);
  let cur = inc;
  const restart = h('button', { class: 'btn small primary', type: 'button' }, 'Restart agent (new credential)');
  const resume = h('button', { class: 'btn small primary', type: 'button' }, 'Resume');
  const replay = h('button', { class: 'btn small', type: 'button' }, 'Replay reasoning');
  restart.addEventListener('click', async () => { if (await call(`agents/${cur.agentId}/restart`)) markDone('kill'); });
  resume.addEventListener('click', () => call(`agents/${cur.agentId}/resume`));
  replay.addEventListener('click', () => { openReplay({ room, agentId: cur.agentId, dialog: $('replay') }); markDone('replay'); });
  r.actions.append(replay, restart, resume);
  return { el, update(inc) {
    cur = inc;
    const w = state.world;
    setClass(el, `inc${inc.status === 'resolved' ? ' resolved' : inc.sev === 'warn' ? ' warn' : ''}`);
    setText(r.title, `${inc.sev === 'crit' ? '▲ ' : '❚❚ '}${inc.title}`);
    setText(r.meta, `${inc.id} · ${clock(inc.ts)} · ${inc.agentName} (${inc.team}) · ${inc.status === 'open' ? `Open, actioned by ${inc.by}` : `Resolved by ${inc.resolvedBy}`}`);
    setText(r.viol, inc.violations);
    setText(r.after, inc.blockedAfterHalt);
    setText(r.assets, w.secretsRead === 0 && w.egressCalls === 0 && w.customersRows === w.customersInitial ? '✓ Intact. Nothing was deleted, read or sent.' : '✕ BREACH. See Blast radius');
    setHidden(restart, !(inc.status === 'open' && inc.agentStatus === 'killed'));
    setHidden(resume, !(inc.status === 'open' && inc.agentStatus === 'paused'));
  } };
}
const renderIncidents = keyedList($('incidents'), createIncident);

let recentSig = '';
function paintRecent(s) {
  const sig = s.approvals.recent.map((a) => a.id + a.status).join();
  if (sig === recentSig) return;
  recentSig = sig;
  const ul = $('apRecent');
  clear(ul);
  for (const a of s.approvals.recent) ul.append(h('li', {}, `${a.status.toUpperCase()}${a.decidedBy ? ` by ${a.decidedBy}` : ''}: ${a.describe}${a.note ? ` (“${a.note}”)` : ''}`));
  if (!s.approvals.recent.length) ul.append(h('li', { class: 'muted' }, 'None yet'));
}

// ───────────────────────────── team filter ─────────────────────────────

let teamsSig = '';
function paintTeams(s) {
  const sig = s.teams.join();
  if (sig === teamsSig) return;
  teamsSig = sig;
  const box = $('teamFilters');
  clear(box);
  for (const t of ['all', ...s.teams]) {
    box.append(h('button', { class: 'chip', type: 'button', 'aria-pressed': String(t === team), onclick: () => { team = t; teamsSig = ''; refilterFeed(); render(); } }, t === 'all' ? 'All teams' : t));
  }
}

// ───────────────────────────── tabs ─────────────────────────────

const TABS = ['feed', 'cost', 'systems', 'audit', 'policy', 'lab'];
let tab = 'feed';
function selectTab(name, focus = false) {
  tab = name;
  for (const t of TABS) {
    const btn = $(`tab-${t}`);
    btn.setAttribute('aria-selected', String(t === name));
    btn.tabIndex = t === name ? 0 : -1;
    $(`panel-${t}`).hidden = t !== name;
    if (t === name && focus) btn.focus();
  }
  if (name === 'audit') loadAudit(true);
  render();
}
$('tablist').addEventListener('click', (e) => {
  const btn = e.target.closest('[role=tab]');
  if (btn) selectTab(btn.id.slice(4));
});
$('tablist').addEventListener('keydown', (e) => {
  const i = TABS.indexOf(tab);
  const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : null;
  if (next === null) return;
  e.preventDefault();
  selectTab(TABS[(next + TABS.length) % TABS.length], true);
});

const sigs = {};
const once = (key, sig, fn) => { if (sigs[key] !== sig) { sigs[key] = sig; fn(); } };
const td = (v, cls = '') => h('td', { class: cls }, v);
const th = (v, cls = '') => h('th', { class: cls, scope: 'col' }, v);

function paintCost(s) {
  once('costAgents', JSON.stringify(s.agents.map((a) => [a.usage, a.status])), () => {
    const t = $('costAgents');
    clear(t);
    t.append(h('thead', {}, h('tr', {}, th('Agent'), th('Model'), th('Tokens in', 'num'), th('Tokens out', 'num'), th('Spend today', 'num'), th('Daily budget used', 'num'), th('Status'))),
      h('tbody', {}, s.agents.map((a) => h('tr', {}, td(a.name), td(a.modelLabel), td(num(a.usage.tokensIn), 'num'), td(num(a.usage.tokensOut), 'num'), td(usd(a.usage.costUsd), 'num'), td(`${((a.usage.costUsd / a.usage.budgetUsd) * 100).toFixed(1)}% of ${usd(a.usage.budgetUsd)}`, 'num'), td(STATUS[a.status][1]))),
        h('tr', {}, td(h('strong', {}, 'Fleet total')), td(''), td(num(s.agents.reduce((x, a) => x + a.usage.tokensIn, 0)), 'num'), td(num(s.agents.reduce((x, a) => x + a.usage.tokensOut, 0)), 'num'), td(h('strong', {}, usd(s.totals.spendUsd)), 'num'), td(''), td(''))));
  });
  const rows = s.agents.flatMap((a) => a.tasks.map((t) => ({ ...t, agent: a.name }))).sort((x, y) => y.startedAt - x.startedAt).slice(0, 24);
  once('costTasks', JSON.stringify(rows), () => {
    const t = $('costTasks');
    clear(t);
    t.append(h('thead', {}, h('tr', {}, th('Agent'), th('Task'), th('Steps', 'num'), th('Tokens in', 'num'), th('Tokens out', 'num'), th('Cost', 'num'), th('vs task budget', 'num'), th('State'))),
      h('tbody', {}, rows.map((r) => h('tr', {}, td(r.agent), td(r.name), td(r.steps, 'num'), td(num(r.tokensIn), 'num'), td(num(r.tokensOut), 'num'), td(usd(r.costUsd), 'num'), td(`${((r.costUsd / r.budgetUsd) * 100).toFixed(0)}%`, 'num'), td(r.status)))));
  });
}

function paintSystems(s) {
  const w = s.world;
  once('world', JSON.stringify(w), () => {
    const tile = (label, value, sub, cls = '') => h('div', { class: `tile ${cls}` }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), h('div', { class: 'sub' }, sub));
    const box = $('worldTiles');
    clear(box);
    box.append(
      tile('Refunds issued', num(w.refunds), `$${w.refundTotalUsd.toFixed(2)} paid out`),
      tile('Emails sent', num(w.emailsSent), `${w.emailBatches} batches`),
      tile('Production deploys', num(w.prodDeploys), `${w.stagingDeploys} staging deploys`),
      tile('Test runs', num(w.testRuns), 'CI'),
      tile('Rows merged / purged', `${num(w.rowsMerged)} / ${num(w.rowsDeleted)}`, 'staging_events, sessions'),
      tile('Customers table', `${num(w.customersRows)} / ${num(w.customersInitial)}`, w.customersRows === w.customersInitial ? '✓ protected, untouched' : '✕ ROWS MISSING', w.customersRows === w.customersInitial ? 'protected' : 'breach'),
      tile('Secrets read', num(w.secretsRead), w.secretsRead ? '✕ BREACH' : '✓ protected, none read', w.secretsRead ? 'breach' : 'protected'),
      tile('Data sent off-site', mb(w.egressBytes), w.egressCalls ? '✕ BREACH' : '✓ protected, none sent', w.egressCalls ? 'breach' : 'protected'));
  });
}

let policyDrawn = false;
function paintPolicy(s) {
  if (policyDrawn) return;
  policyDrawn = true;
  const t = $('policyTable');
  t.append(h('thead', {}, h('tr', {}, th('Rule'), th('Tool'), th('Outcome'), th('Risk'), th('Signs off'), th('Why'))),
    h('tbody', {}, s.guardrails.map((g) => h('tr', {}, td(h('span', { class: 'mono' }, g.id)), td(h('span', { class: 'mono' }, g.tool)), td(g.decision === 'deny' ? '✕ Blocked outright' : '⏳ Human approval'), td(g.risk), td(g.routeTo ?? '-'), td(g.reason)))));
  const L = s.limits;
  $('policyNotes').append(
    h('div', {}, h('strong', {}, 'Always on'), h('ul', {},
      h('li', {}, 'Credential & scope: an agent can only call tools on its own allowlist. Anything else is denied and counted as a violation.'),
      h('li', {}, 'Argument validation: malformed or unsafe arguments (e.g. non-SELECT SQL) are rejected before policy even runs.'),
      h('li', {}, 'Budgets: a per-task and a daily cap trip a circuit breaker that pauses the agent. Resuming requires raising the budget.'),
      h('li', {}, `Rate limit: more than ${L.rateMax} calls in ${L.rateWindowMs / 1000}s are denied.`),
      h('li', {}, `Approvals fail closed: a request nobody answers within ${Math.round(s.approvalTtlMs / 60000)} min is denied.`))),
    h('div', {}, h('strong', {}, 'Auto-containment (toggle in the header)'), h('ul', {},
      h('li', {}, `${L.violationsKill} out-of-policy attempts within ${L.violationWindowMs / 60000} min → kill the agent and revoke its credentials.`),
      h('li', {}, `The same call ${L.loopRepeat}× in its last ${L.loopWindow} → pause.`),
      h('li', {}, `${L.rateHitsPause} rate-limit hits in 30 s → pause.`),
      h('li', {}, `Drift score ≥ ${L.driftPause} → pause.`))));
}

let labDrawn = false;
function paintLab(s) {
  if (labDrawn) return;
  labDrawn = true;
  const box = $('labAgents');
  const kinds = [['rogue', 'Go rogue'], ['loop', 'Runaway loop'], ['spender', 'Cost runaway']];
  for (const a of s.agents) {
    box.append(h('div', { class: 'lab-row' }, h('strong', {}, a.name), kinds.map(([k, label]) => h('button', { class: 'btn small', type: 'button', title: s.faults[k], onclick: async () => {
      if (await call('sim/inject', { agentId: a.id, fault: k })) {
        if (k === 'rogue') markDone('rogue');
        toast(`${label} injected into ${a.name}`, 'warn');
      }
    } }, label))));
  }
}
armable($('reset'), { label: 'Reset simulation', confirmLabel: 'Confirm reset?', run: async () => { if (await call('sim/reset')) toast('Simulation reset. The audit log was kept.'); } });

// ───────────────────────────── audit ─────────────────────────────

let auditSeq = -1;
async function loadAudit(force = false) {
  const q = new URLSearchParams();
  if ($('auditAgent').value) q.set('agent', $('auditAgent').value);
  if ($('auditActor').value) q.set('actor', $('auditActor').value);
  try {
    const res = await fetch(`/api/rooms/${room}/audit?${q}`);
    if (!res.ok) return;
    const { entries, total } = await res.json();
    const key = `${entries.at(-1)?.seq}-${total}-${q}`;
    if (!force && key === auditSeq) return;
    auditSeq = key;
    const t = $('auditTable');
    clear(t);
    t.append(h('thead', {}, h('tr', {}, th('#', 'num'), th('Time'), th('Actor'), th('Agent'), th('Action'), th('Decision'), th('Detail'), th('Hash'))),
      h('tbody', {}, [...entries].reverse().map((e) => h('tr', {}, td(e.seq, 'num'), td(clock(e.ts)), td(e.actor), td(e.agentId || '-'), td(h('span', { class: 'mono' }, e.action)), td(e.decision || '-'), td(e.detail, 'detail'), td(h('span', { class: 'mono', title: e.hash }, e.hash.slice(0, 8)))))));
  } catch { /* transient: the next poll will retry */ }
}
setInterval(() => { if (tab === 'audit' && !document.hidden) loadAudit(); }, 3000);
$('auditAgent').addEventListener('change', () => loadAudit(true));
$('auditActor').addEventListener('change', () => loadAudit(true));
$('exportCsv').href = `/api/rooms/${room}/audit?format=csv`;
$('exportJson').href = `/api/rooms/${room}/audit?format=json&download=1`;
$('exportCsv').addEventListener('click', () => markDone('export'));
$('exportJson').addEventListener('click', () => markDone('export'));
$('verify').addEventListener('click', async () => {
  const out = $('verifyResult');
  try {
    const v = await (await fetch(`/api/rooms/${room}/audit/verify`)).json();
    out.className = `verify ${v.valid ? 'ok' : 'bad'}`;
    setText(out, v.valid ? `Chain intact · ${num(v.count)} entries · head ${v.head.slice(0, 12)}…` : `CHAIN BROKEN at entry #${v.brokenAt}`);
  } catch {
    out.className = 'verify bad';
    setText(out, 'Could not verify');
  }
});
let auditAgentsSig = '';

// ───────────────────────────── header controls ─────────────────────────────

let autoPending = false;
$('autoContain').addEventListener('change', async (e) => {
  autoPending = true;
  const ok = await call('settings', { autoContain: e.target.checked });
  autoPending = false;
  if (!ok && state) e.target.checked = state.autoContain;
});
armable($('haltAll'), { label: 'Halt fleet', confirmLabel: 'Confirm: kill all agents?', run: async () => { if (await call('fleet/halt_all')) { markDone('kill'); toast('Fleet halted. All credentials revoked.', 'crit'); } } });
$('share').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Room link copied. Anyone with it sees this same fleet and can intervene.');
  } catch {
    toast(`Copy this URL: ${location.href}`);
  }
});
$('theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('theme', next);
});
if (store.get('theme')) document.documentElement.dataset.theme = store.get('theme');

// ───────────────────────────── main render ─────────────────────────────

function render() {
  if (!state) return;
  const s = state;
  setText($('tenant'), `Acme Corp (demo tenant) · room ${room}`);
  paintKpis(s);
  paintTeams(s);
  renderAgents(s.agents, (a) => a.id);
  setHidden($('fleetEmpty'), s.agents.some((a) => team === 'all' || a.team === team));
  renderApprovalsNodes = renderApprovals(s.approvals.pending, (a) => a.id);
  const visiblePending = s.approvals.pending.filter((a) => team === 'all' || a.routedTo === team || a.team === team).length;
  setText($('apCount'), visiblePending);
  $('apCount').classList.toggle('hot', visiblePending > 0);
  setHidden($('apEmpty'), visiblePending > 0);
  document.title = s.totals.pendingApprovals ? `(${s.totals.pendingApprovals}) Agent Control Tower` : 'Agent Control Tower';
  paintRecent(s);
  renderIncidents(s.incidents, (i) => i.id);
  setHidden($('incEmpty'), s.incidents.length > 0);
  paintTimers();
  if (!autoPending && $('autoContain').checked !== s.autoContain) $('autoContain').checked = s.autoContain;

  const sig = s.agents.map((a) => a.id).join();
  if (sig !== auditAgentsSig) {
    auditAgentsSig = sig;
    const sel = $('auditAgent');
    for (const a of s.agents) sel.append(h('option', { value: a.id }, a.name));
  }
  setText($('feedCount'), `${$('feed').children.length} events`);
  if (tab === 'cost') paintCost(s);
  if (tab === 'systems') paintSystems(s);
  if (tab === 'policy') paintPolicy(s);
  if (tab === 'lab') paintLab(s);
}

setInterval(paintTimers, 1000);
connect();
