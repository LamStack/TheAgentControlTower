import { Tower } from '../src/tower.js';

export const OP = 'operator:Tester';

/** A tower with no running agents: drive requestAction() by hand for deterministic gateway tests. */
export function idleTower(opts = {}) {
  return new Tower({ id: 'test', ...opts });
}

/** A live tower at accelerated sim time. */
export function liveTower(opts = {}) {
  return new Tower({ id: 'live', speed: 40, seed: 7, ...opts }).start();
}

export async function waitFor(pred, { timeout = 20000, every = 5, label = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

export const pendingOf = (t) => t.snapshot().approvals.pending;
