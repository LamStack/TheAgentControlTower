import { createHash } from 'node:crypto';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const round2 = (n) => Math.round(n * 100) / 100;
export const trunc = (s, n = 120) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Thrown inside an agent's script when the tower halts it (kill, revoke, restart, shutdown). */
export class HaltSignal extends Error {
  constructor(reason = 'halted') {
    super(`agent halted: ${reason}`);
    this.name = 'HaltSignal';
    this.reason = reason;
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed) {
    this.next = mulberry32(seed);
  }
  float(a, b) { return a + this.next() * (b - a); }
  int(a, b) { return Math.floor(a + this.next() * (b - a + 1)); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  chance(p) { return this.next() < p; }
}

/**
 * Simulation clock. speed > 1 compresses time (tests); every window, timeout and
 * timestamp in the control plane goes through it so behaviour is identical at any speed.
 */
export class Clock {
  constructor(speed = 1) {
    this.speed = speed;
    this.t0 = Date.now();
    this.sleepers = new Set();
    this.timers = new Set();
    this.closed = false;
  }

  now() {
    return Math.round(this.t0 + (Date.now() - this.t0) * this.speed);
  }

  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new HaltSignal('disposed'));
      if (signal?.aborted) return reject(new HaltSignal('aborted'));
      const s = {};
      const cleanup = () => {
        clearTimeout(s.h);
        this.sleepers.delete(s);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => { cleanup(); reject(new HaltSignal('aborted')); };
      s.reject = (e) => { cleanup(); reject(e); };
      s.h = setTimeout(() => { cleanup(); resolve(); }, ms / this.speed);
      this.sleepers.add(s);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Schedule fn after ms of sim time; returns a cancel function. */
  after(ms, fn) {
    if (this.closed) return () => {};
    const h = setTimeout(() => { this.timers.delete(h); fn(); }, ms / this.speed);
    this.timers.add(h);
    return () => { clearTimeout(h); this.timers.delete(h); };
  }

  dispose() {
    this.closed = true;
    for (const h of this.timers) clearTimeout(h);
    this.timers.clear();
    for (const s of [...this.sleepers]) s.reject(new HaltSignal('disposed'));
  }
}
