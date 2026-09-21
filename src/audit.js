import { sha256 } from './util.js';

const GENESIS = '0'.repeat(64);
const MAX_ENTRIES = 5000;
const CSV_COLUMNS = ['seq', 'timestamp', 'actor_type', 'actor', 'team', 'agent_id', 'action', 'tool', 'decision', 'rule', 'detail', 'prev_hash', 'hash'];

const canonical = (e, prevHash) =>
  JSON.stringify([e.seq, e.ts, e.actorType, e.actor, e.team, e.agentId, e.action, e.tool, e.decision, e.rule, e.detail, prevHash]);

/** Append-only, hash-chained log: editing or deleting any past entry breaks every hash after it. */
export class AuditLog {
  constructor() {
    this.entries = [];
    this.anchor = GENESIS; // hash of the last entry trimmed off the front (chain start)
    this.seq = 0;
  }

  get head() {
    return this.entries.length ? this.entries[this.entries.length - 1].hash : this.anchor;
  }

  append(fields) {
    const e = {
      seq: ++this.seq,
      ts: fields.ts,
      actorType: fields.actorType,
      actor: fields.actor,
      team: fields.team ?? '',
      agentId: fields.agentId ?? '',
      action: fields.action,
      tool: fields.tool ?? '',
      decision: fields.decision ?? '',
      rule: fields.rule ?? '',
      detail: String(fields.detail ?? '').slice(0, 400),
    };
    e.prevHash = this.head;
    e.hash = sha256(canonical(e, e.prevHash));
    this.entries.push(e);
    if (this.entries.length > MAX_ENTRIES) this.anchor = this.entries.shift().hash;
    return e;
  }

  verify() {
    let prev = this.anchor;
    for (const e of this.entries) {
      if (e.prevHash !== prev || e.hash !== sha256(canonical(e, prev))) {
        return { valid: false, count: this.entries.length, brokenAt: e.seq, head: null };
      }
      prev = e.hash;
    }
    return { valid: true, count: this.entries.length, brokenAt: null, head: prev };
  }

  query({ agentId, actorType, limit = 200 } = {}) {
    let rows = this.entries;
    if (agentId) rows = rows.filter((e) => e.agentId === agentId);
    if (actorType) rows = rows.filter((e) => e.actorType === actorType);
    return rows.slice(-limit);
  }

  toJSON(room) {
    return {
      room,
      exportedAt: new Date().toISOString(),
      chainAnchor: this.anchor,
      chainHead: this.head,
      verification: this.verify(),
      entries: this.entries.map((e) => ({ ...e, timestamp: new Date(e.ts).toISOString() })),
    };
  }

  toCSV() {
    const lines = [CSV_COLUMNS.join(',')];
    for (const e of this.entries) {
      lines.push(
        [e.seq, new Date(e.ts).toISOString(), e.actorType, e.actor, e.team, e.agentId, e.action, e.tool, e.decision, e.rule, e.detail, e.prevHash, e.hash]
          .map(csvCell)
          .join(','),
      );
    }
    return lines.join('\r\n') + '\r\n';
  }
}

/** RFC 4180 quoting plus spreadsheet formula-injection defence (agents control some of these strings). */
export function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
