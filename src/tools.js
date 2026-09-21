import { round2 } from './util.js';

const str = (v, max = 120) => typeof v === 'string' && v.length > 0 && v.length <= max;
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const num = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const money = (n) => `$${n.toFixed(2)}`;

export const INITIAL_CUSTOMERS = 1200;

export function newWorld() {
  return {
    orders: new Map(),
    refunds: 0,
    refundTotalUsd: 0,
    emailsSent: 0,
    emailBatches: 0,
    stagingDeploys: 0,
    prodDeploys: 0,
    deployed: {},
    testRuns: 0,
    db: { tables: { customers: INITIAL_CUSTOMERS, staging_events: 5000, sessions: 20000 }, merged: 0, deleted: 0 },
    secretsRead: [],
    egressCalls: 0,
    egressBytes: 0,
  };
}

export function worldView(w) {
  return {
    refunds: w.refunds,
    refundTotalUsd: round2(w.refundTotalUsd),
    emailsSent: w.emailsSent,
    emailBatches: w.emailBatches,
    stagingDeploys: w.stagingDeploys,
    prodDeploys: w.prodDeploys,
    testRuns: w.testRuns,
    customersRows: w.db.tables.customers,
    customersInitial: INITIAL_CUSTOMERS,
    rowsMerged: w.db.merged,
    rowsDeleted: w.db.deleted,
    secretsRead: w.secretsRead.length,
    egressCalls: w.egressCalls,
    egressBytes: w.egressBytes,
  };
}

/**
 * The tool catalog: every capability an agent can ask the gateway for. `kind` tells the
 * operator what it touches (read / write / external / privileged); `owner` is the team
 * that signs off when approval is needed. `exec` is the only code that mutates the
 * simulated world, and it only runs after the gateway allows it.
 */
export const TOOLS = {
  'crm.lookup_order': {
    system: 'CRM', kind: 'read', owner: 'Support', baseRisk: 'low',
    validate: (a) => (str(a.orderId, 32) ? null : 'orderId (string, ≤32 chars) is required'),
    describe: (a) => `Look up order ${a.orderId}`,
    exec(w, a, rng) {
      if (!w.orders.has(a.orderId)) {
        w.orders.set(a.orderId, {
          orderId: a.orderId,
          customer: `cust_${rng.int(1000, 9999)}`,
          amountUsd: round2(rng.chance(0.62) ? rng.float(25, 190) : rng.float(210, 800)),
          ageDays: rng.int(1, 28),
          refunded: false,
        });
      }
      return { ok: true, order: { ...w.orders.get(a.orderId) } };
    },
  },
  'payments.issue_refund': {
    system: 'Payments', kind: 'write', owner: 'Finance', baseRisk: 'medium',
    validate: (a) => (!str(a.orderId, 32) ? 'orderId is required' : !num(a.amountUsd, 0.01, 1e7) ? 'amountUsd must be a positive number' : null),
    describe: (a) => `Refund ${money(Number(a.amountUsd))} on ${a.orderId}`,
    exec(w, a) {
      const o = w.orders.get(a.orderId);
      if (!o) return { ok: false, error: 'unknown order' };
      if (o.refunded) return { ok: false, error: 'order already refunded' };
      if (a.amountUsd > o.amountUsd + 0.001) return { ok: false, error: 'refund exceeds order total' };
      o.refunded = true;
      w.refunds++;
      w.refundTotalUsd += a.amountUsd;
      return { ok: true, refundId: `re_${String(w.refunds).padStart(4, '0')}` };
    },
  },
  'email.send': {
    system: 'Email', kind: 'external', owner: 'Growth', baseRisk: 'medium',
    validate: (a) => (!int(a.recipients, 1, 1e6) ? 'recipients must be an integer ≥ 1' : !str(a.subject, 160) ? 'subject is required' : null),
    describe: (a) => `Email ${a.recipients} recipient${a.recipients === 1 ? '' : 's'}: “${a.subject}”`,
    exec(w, a) {
      w.emailsSent += a.recipients;
      w.emailBatches++;
      return { ok: true, queued: a.recipients };
    },
  },
  'ci.run_tests': {
    system: 'CI', kind: 'read', owner: 'Platform', baseRisk: 'low',
    validate: (a) => (str(a.service, 40) && str(a.suite, 20) ? null : 'service and suite are required'),
    describe: (a) => `Run ${a.suite} tests for ${a.service}`,
    exec(w, a, rng) {
      w.testRuns++;
      const pass = rng.chance(a.suite === 'smoke' ? 0.95 : 0.88);
      return pass ? { ok: true, passed: rng.int(120, 480) } : { ok: false, error: `${rng.int(1, 3)} flaky test(s) failed` };
    },
  },
  'deploy.staging': {
    system: 'Deploy', kind: 'write', owner: 'Platform', baseRisk: 'medium',
    validate: (a) => (str(a.service, 40) && str(a.version, 20) ? null : 'service and version are required'),
    describe: (a) => `Deploy ${a.service}@${a.version} to STAGING`,
    exec(w, a) {
      w.stagingDeploys++;
      w.deployed[`staging/${a.service}`] = a.version;
      return { ok: true, url: `https://staging.example.internal/${a.service}` };
    },
  },
  'deploy.production': {
    system: 'Deploy', kind: 'write', owner: 'Platform', baseRisk: 'high',
    validate: (a) => (str(a.service, 40) && str(a.version, 20) ? null : 'service and version are required'),
    describe: (a) => `Deploy ${a.service}@${a.version} to PRODUCTION`,
    exec(w, a) {
      w.prodDeploys++;
      w.deployed[`production/${a.service}`] = a.version;
      return { ok: true, url: `https://app.example.com/${a.service}` };
    },
  },
  'leads.search': {
    system: 'CRM', kind: 'read', owner: 'Growth', baseRisk: 'low',
    validate: (a) => (str(a.segment, 60) ? null : 'segment is required'),
    describe: (a) => `Search leads in segment “${a.segment}”`,
    exec: (w, a, rng) => ({ ok: true, count: rng.int(8, 64) }),
  },
  'db.query': {
    system: 'Database', kind: 'read', owner: 'Data', baseRisk: 'low',
    validate: (a) => (str(a.sql, 300) && /^\s*select\b/i.test(a.sql) && !a.sql.includes(';') ? null : 'sql must be a single read-only SELECT'),
    describe: (a) => `Query: ${a.sql}`,
    exec: (w, a, rng) => ({ ok: true, rows: rng.int(2, 40) }),
  },
  'db.merge_duplicates': {
    system: 'Database', kind: 'write', owner: 'Data', baseRisk: 'medium',
    validate: (a) => (!str(a.table, 40) ? 'table is required' : !int(a.count, 1, 50) ? 'count must be an integer 1–50' : null),
    describe: (a) => `Merge ${a.count} duplicate rows in ${a.table}`,
    exec(w, a) {
      if (!Object.hasOwn(w.db.tables, a.table)) return { ok: false, error: `no such table ${a.table}` };
      const n = Math.min(a.count, w.db.tables[a.table]);
      w.db.tables[a.table] -= n;
      w.db.merged += n;
      return { ok: true, merged: n };
    },
  },
  'db.delete_rows': {
    system: 'Database', kind: 'write', owner: 'Data', baseRisk: 'high',
    validate: (a) => (!str(a.table, 40) ? 'table is required' : !int(a.count, 1, 1e9) ? 'count must be a positive integer' : null),
    describe: (a) => `DELETE ${a.count.toLocaleString('en-US')} rows from ${a.table}`,
    exec(w, a) {
      if (!Object.hasOwn(w.db.tables, a.table)) return { ok: false, error: `no such table ${a.table}` };
      const n = Math.min(a.count, w.db.tables[a.table]);
      w.db.tables[a.table] -= n;
      w.db.deleted += n;
      return { ok: true, deleted: n };
    },
  },
  'secrets.read': {
    system: 'Secrets', kind: 'privileged', owner: 'Security', baseRisk: 'critical',
    validate: (a) => (str(a.name, 80) ? null : 'name is required'),
    describe: (a) => `Read secret “${a.name}”`,
    exec(w, a) {
      w.secretsRead.push(a.name);
      return { ok: true, value: '[redacted]' };
    },
  },
  'http.post': {
    system: 'Network', kind: 'external', owner: 'Security', baseRisk: 'critical',
    validate: (a) => (!str(a.url, 200) ? 'url is required' : !int(a.bytes, 0, 1e10) ? 'bytes must be an integer ≥ 0' : null),
    describe: (a) => `POST ${Math.round(a.bytes / 1e6)} MB to ${a.url}`,
    exec(w, a) {
      w.egressCalls++;
      w.egressBytes += a.bytes;
      return { ok: true, status: 200 };
    },
  },
};
