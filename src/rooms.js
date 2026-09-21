import { HttpError } from './util.js';
import { Tower } from './tower.js';

/**
 * A room is a tenant: its own fleet, simulated systems, approval queue and audit log.
 * The unguessable room id is the access capability (this demo has no accounts).
 * Idle rooms are garbage-collected so a public deployment can't leak timers.
 */
export class Rooms {
  constructor({ maxRooms = 40, idleMs = 15 * 60_000, speed = 1, approvalTtlMs, seed } = {}) {
    this.rooms = new Map();
    this.maxRooms = maxRooms;
    this.idleMs = idleMs;
    this.opts = { speed, approvalTtlMs, seed };
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref?.();
  }

  get(id) {
    let t = this.rooms.get(id);
    if (!t) {
      if (this.rooms.size >= this.maxRooms) this.evictOne();
      t = new Tower({ id, ...Object.fromEntries(Object.entries(this.opts).filter(([, v]) => v !== undefined)) }).start();
      this.rooms.set(id, t);
    }
    t.touch();
    return t;
  }

  evictOne() {
    const idle = [...this.rooms.values()].filter((t) => t.subs.size === 0).sort((a, b) => a.lastTouched - b.lastTouched)[0];
    if (!idle) throw new HttpError(503, 'The demo is at capacity. Try again in a minute');
    this.drop(idle);
  }

  drop(t) {
    t.dispose();
    this.rooms.delete(t.id);
  }

  sweep() {
    const now = Date.now();
    for (const t of [...this.rooms.values()]) {
      if (t.subs.size === 0 && now - t.lastTouched > this.idleMs) this.drop(t);
    }
  }

  close() {
    clearInterval(this.sweeper);
    for (const t of [...this.rooms.values()]) this.drop(t);
  }
}
