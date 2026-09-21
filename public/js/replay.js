import { h, clear, clock, num, usd } from './dom.js';

const VERDICT = {
  allow: ['✓', 'Allowed by policy'],
  approve: ['⏳', 'Needed human approval'],
  deny: ['✕', 'Denied'],
};
const OFF_MISSION = new Set(['out_of_scope', 'unknown_tool', 'credential_revoked']);

/**
 * Step-by-step replay of an agent's recent reasoning: what it thought, what it asked for,
 * what the Tower decided, and what happened. Play it like a recording or click any step.
 */
export async function openReplay({ room, agentId, dialog, onOpen }) {
  let n = 10;
  let steps = [];
  let idx = 0;
  let timer = null;
  let speed = 1;
  let meta = { agentName: '', mission: '' };

  const body = h('div', { class: 'rp-body' });
  const bar = h('div', { class: 'rp-bar' });
  const head = h('div', { class: 'rp-head' });
  const root = h('div', { class: 'rp' }, head, bar, body);
  clear(dialog);
  dialog.append(root);
  if (!dialog.open) dialog.showModal();
  onOpen?.();

  const stop = () => {
    clearInterval(timer);
    timer = null;
  };
  dialog.addEventListener('close', stop, { once: true });

  async function load() {
    stop();
    try {
      const res = await fetch(`/api/rooms/${room}/agents/${agentId}/steps?n=${n}`);
      if (!res.ok) throw new Error((await res.json()).error);
      const data = await res.json();
      steps = data.steps;
      meta = data;
    } catch (e) {
      clear(body);
      body.append(h('p', { class: 'muted pad' }, `Could not load replay: ${e.message}`));
      return;
    }
    idx = 0;
    render();
  }

  function detail(s) {
    const a = s.action;
    const off = a && (OFF_MISSION.has(a.rule) || a.risk === 'critical');
    const out = [];
    out.push(h('div', {}, h('h4', {}, `Step ${s.n} · ${clock(s.ts)}${s.taskName ? ` · ${s.taskName}` : ''}`)));
    if (off) out.push(h('div', { class: 'offmission' }, '⚠ Off-mission. This request has nothing to do with the agent’s job: ', meta.mission));
    out.push(h('div', {}, h('h4', {}, 'Thought'), h('blockquote', {}, s.thought || '(none)'), h('p', { class: 'muted small' }, s.tokensIn || s.tokensOut ? `${num(s.tokensIn)} tokens in · ${num(s.tokensOut)} out · ${usd(s.costUsd)}` : 'No model call for this step')));
    if (a) {
      const [icon, text] = VERDICT[a.decision] ?? ['•', a.decision];
      out.push(h('div', {}, h('h4', {}, 'Tool call'), h('pre', {}, `${a.tool}\n${JSON.stringify(a.args, null, 2)}`)));
      out.push(h('div', {}, h('h4', {}, 'Tower verdict'), h('span', { class: `verdict ${a.decision}` }, `${icon} ${text}`), h('p', { class: 'small mt' }, `Rule ${a.rule} · risk ${a.risk}. ${a.reason}`)));
    } else {
      out.push(h('p', { class: 'muted' }, 'This step was reasoning only. No tool call.'));
    }
    if (s.approval) {
      const ap = s.approval;
      out.push(h('div', {}, h('h4', {}, 'Human in the loop'), h('p', {}, ap.status === 'pending' ? 'Waiting for a human decision…' : `${ap.status[0].toUpperCase()}${ap.status.slice(1)} by ${ap.by}${ap.note ? `: “${ap.note}”` : ''}`)));
    }
    if (s.result) {
      out.push(h('div', {}, h('h4', {}, 'Outcome'), h('pre', {}, JSON.stringify(s.result, null, 2))));
    }
    return out;
  }

  function render() {
    clear(head);
    clear(bar);
    clear(body);
    head.append(
      h('div', {}, h('h2', { id: 'replayTitle' }, `Replay: ${meta.agentName}`), h('p', {}, `Mission: ${meta.mission}`)),
      h('button', { class: 'btn small', type: 'button', onclick: () => dialog.close() }, 'Close'),
    );

    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Number of steps' }, [5, 10, 20].map((k) => h('button', { type: 'button', 'aria-pressed': String(k === n), onclick: () => { n = k; load(); } }, `Last ${k}`)));
    const step = (d) => { stop(); idx = Math.max(0, Math.min(steps.length - 1, idx + d)); render(); };
    const playBtn = h('button', { class: 'btn small primary', type: 'button', onclick: toggle }, timer ? '❚❚ Pause' : '▶ Play');
    const speedSel = h('select', { 'aria-label': 'Playback speed', onchange: (e) => { speed = Number(e.target.value); if (timer) { stop(); play(); render(); } } },
      [[1, '1×'], [2, '2×'], [4, '4×']].map(([v, l]) => h('option', { value: v, selected: v === speed }, l)));
    bar.append(seg, h('button', { class: 'btn small', type: 'button', onclick: () => step(-1), disabled: idx === 0 }, '◀ Back'), playBtn, h('button', { class: 'btn small', type: 'button', onclick: () => step(1), disabled: idx >= steps.length - 1 }, 'Next ▶'), speedSel,
      h('span', { class: 'muted small', role: 'status' }, steps.length ? `Step ${idx + 1} of ${steps.length}` : 'No steps recorded yet'));

    if (!steps.length) {
      body.append(h('p', { class: 'muted pad span-all' }, 'This agent has not done anything yet. Give it a few seconds.'));
      return;
    }
    const list = h('ol', { class: 'rp-list' }, steps.map((s, i) => {
      const a = s.action;
      const icon = !a ? '💭' : a.decision === 'deny' ? '✕' : a.decision === 'approve' ? '⏳' : '✓';
      return h('li', { class: i > idx && timer ? 'future' : '' }, h('button', { type: 'button', 'aria-current': i === idx ? 'step' : null, onclick: () => { stop(); idx = i; render(); } },
        h('span', { 'aria-hidden': 'true' }, icon), h('span', {}, `${s.n}. ${a ? a.tool : 'reasoning'}`)));
    }));
    body.append(list, h('div', { class: 'rp-detail', 'aria-live': 'polite' }, detail(steps[idx])));
    list.children[idx]?.scrollIntoView({ block: 'nearest' });
  }

  function play() {
    timer = setInterval(() => {
      if (idx >= steps.length - 1) {
        stop();
        render();
        return;
      }
      idx++;
      render();
    }, 1600 / speed);
  }
  function toggle() {
    if (timer) {
      stop();
    } else {
      if (idx >= steps.length - 1) idx = 0;
      play();
    }
    render();
  }

  await load();
}
