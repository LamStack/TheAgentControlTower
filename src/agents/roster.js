const tk = (rng, inLo, inHi, outLo, outHi) => ({ in: rng.int(inLo, inHi), out: rng.int(outLo, outHi) });

const REASONS = ['arrived damaged', 'wrong size shipped', 'duplicate charge', 'late delivery', 'not as described'];
const SERVICES = ['api', 'web', 'billing', 'search'];
const SEGMENTS = ['churn-risk', 'trial-expiring', 'webinar-attendees', 'dormant-enterprise'];
const SUBJECTS = ['We miss you', 'Your trial ends soon', 'Thanks for joining', 'A better plan for your team'];

/**
 * Four simulated agents doing four different jobs for three teams (plus the Finance/Data owners who
 * sign off on their risky calls). Scripts only *ask*: the tower decides.
 */
export const ROSTER = [
  {
    id: 'refund-resolver',
    name: 'Refund Resolver',
    role: 'Customer support · refunds',
    team: 'Support',
    model: 'sonnet-class',
    mission: 'Resolve refund tickets within policy and confirm with the customer.',
    allowedTools: ['crm.lookup_order', 'payments.issue_refund', 'email.send'],
    taskBudgetUsd: 0.2,
    budgetUsd: 25,
    baselineTokensPerMin: 60000,
    loopProbe: { tool: 'crm.lookup_order', args: { orderId: 'ORD-STUCK' } },
    nextTask(agent) {
      const rng = agent.rng;
      const ticket = `T-${1000 + ++agent.taskSeq}`;
      const orderId = `ORD-${rng.int(10000, 99999)}`;
      const reason = rng.pick(REASONS);
      return {
        name: `Ticket ${ticket}: refund (${reason})`,
        async run(ctx) {
          await ctx.think(`Ticket ${ticket}: customer says the order ${reason}. I'll pull ${orderId} and check eligibility before touching money.`, tk(rng, 1200, 2200, 200, 450));
          const look = await ctx.act('crm.lookup_order', { orderId });
          if (!look.ok) return;
          const { amountUsd, ageDays } = look.output.order;
          await ctx.pace();
          await ctx.think(`Order is ${ageDays} days old, inside the 30-day window. A full refund of $${amountUsd.toFixed(2)} is justified.`, tk(rng, 1300, 2300, 250, 500));
          let res = await ctx.act('payments.issue_refund', { orderId, amountUsd });
          if (res.denied) {
            await ctx.pace();
            await ctx.think(`The refund was not authorised (${res.reason}). I'll offer a smaller goodwill refund inside my own authority instead.`, tk(rng, 1200, 2000, 250, 450));
            res = await ctx.act('payments.issue_refund', { orderId, amountUsd: Math.min(amountUsd, 15) });
          }
          await ctx.pace();
          await ctx.think(res.ok ? 'Refund went through. Confirm resolution with the customer.' : 'Could not refund. Tell the customer a human will follow up.', tk(rng, 900, 1600, 200, 400));
          await ctx.act('email.send', { recipients: 1, subject: `Update on your ticket ${ticket}` });
        },
      };
    },
  },

  {
    id: 'release-captain',
    name: 'Release Captain',
    role: 'Platform · CI/CD',
    team: 'Platform',
    model: 'opus-class',
    mission: 'Test, stage and ship approved builds. Production always waits for a human.',
    allowedTools: ['ci.run_tests', 'deploy.staging', 'deploy.production'],
    taskBudgetUsd: 0.75,
    budgetUsd: 60,
    baselineTokensPerMin: 45000,
    loopProbe: { tool: 'ci.run_tests', args: { service: 'api', suite: 'unit' } },
    nextTask(agent) {
      const rng = agent.rng;
      const service = rng.pick(SERVICES);
      const version = `1.4.${++agent.taskSeq}`;
      return {
        name: `Release ${service}@${version}`,
        async run(ctx) {
          await ctx.think(`New build ${service}@${version}. Run the unit suite before it goes anywhere.`, tk(rng, 900, 1500, 150, 300));
          let tests = await ctx.act('ci.run_tests', { service, suite: 'unit' });
          if (!tests.ok) {
            await ctx.pace();
            await ctx.think(`${tests.output?.error ?? 'Tests failed'}. Looks flaky, not a real regression. One retry.`, tk(rng, 1000, 1600, 150, 300));
            tests = await ctx.act('ci.run_tests', { service, suite: 'unit' });
            if (!tests.ok) {
              await ctx.think('Failed twice. Blocking the release and filing a ticket.', tk(rng, 800, 1200, 150, 250));
              return;
            }
          }
          await ctx.pace();
          await ctx.think('Unit suite is green. Roll to staging.', tk(rng, 900, 1400, 120, 250));
          await ctx.act('deploy.staging', { service, version });
          await ctx.pace();
          await ctx.think('Staging is up. Run smoke tests against it.', tk(rng, 900, 1400, 120, 250));
          const smoke = await ctx.act('ci.run_tests', { service, suite: 'smoke' });
          if (!smoke.ok) return;
          await ctx.pace();
          await ctx.think('Smoke is green and error budget is healthy. Production rollout needs a human sign-off; requesting it.', tk(rng, 1200, 1800, 200, 350));
          const prod = await ctx.act('deploy.production', { service, version });
          await ctx.think(prod.ok ? 'Deployed. Watching error rates for the next window.' : 'Production deploy not approved. Leaving the build on staging and noting why.', tk(rng, 800, 1300, 150, 250));
        },
      };
    },
  },

  {
    id: 'outreach-writer',
    name: 'Outreach Writer',
    role: 'Growth · lifecycle email',
    team: 'Growth',
    model: 'haiku-class',
    mission: 'Find the right leads and send lifecycle campaigns. Bulk sends need sign-off.',
    allowedTools: ['leads.search', 'email.send'],
    taskBudgetUsd: 0.1,
    budgetUsd: 10,
    baselineTokensPerMin: 60000,
    loopProbe: { tool: 'leads.search', args: { segment: 'all-leads' } },
    nextTask(agent) {
      const rng = agent.rng;
      agent.taskSeq++;
      const segment = rng.pick(SEGMENTS);
      const subject = rng.pick(SUBJECTS);
      return {
        name: `Campaign: ${segment}`,
        async run(ctx) {
          await ctx.think(`Build the audience for “${segment}”.`, tk(rng, 900, 1600, 150, 300));
          const found = await ctx.act('leads.search', { segment });
          if (!found.ok) return;
          const count = found.output.count;
          await ctx.pace();
          await ctx.think(`Draft “${subject}” for ${count} leads. Warm tone, one clear call to action.`, tk(rng, 1500, 2600, 400, 700));
          await ctx.pace();
          await ctx.think(`Send to all ${count} matched leads.`, tk(rng, 800, 1300, 100, 200));
          const sent = await ctx.act('email.send', { recipients: count, subject });
          if (sent.denied) {
            await ctx.pace();
            await ctx.think('The bulk send was not approved. Narrow to the 15 highest-intent leads instead.', tk(rng, 900, 1500, 150, 300));
            await ctx.act('email.send', { recipients: 15, subject });
          }
        },
      };
    },
  },

  {
    id: 'data-janitor',
    name: 'Data Janitor',
    role: 'Data · hygiene',
    team: 'Data',
    model: 'sonnet-class',
    mission: 'Merge duplicate records and purge stale rows from staging tables. Never touch customers.',
    allowedTools: ['db.query', 'db.merge_duplicates', 'db.delete_rows'],
    taskBudgetUsd: 0.3,
    budgetUsd: 25,
    baselineTokensPerMin: 60000,
    loopProbe: { tool: 'db.query', args: { sql: 'SELECT count(*) FROM sessions' } },
    nextTask(agent) {
      const rng = agent.rng;
      agent.taskSeq++;
      const table = rng.pick(['staging_events', 'sessions']);
      return {
        name: `Dedupe and purge ${table}`,
        async run(ctx) {
          await ctx.think(`Scan ${table} for duplicate groups before changing anything.`, tk(rng, 1000, 1800, 150, 300));
          const scan = await ctx.act('db.query', { sql: `SELECT email, count(*) FROM ${table} GROUP BY email HAVING count(*) > 1` });
          if (!scan.ok) return;
          const dupes = rng.int(4, 20);
          await ctx.pace();
          await ctx.think(`${scan.output.rows} duplicate groups. Merge ${dupes} rows: cheap, reversible, in scope.`, tk(rng, 1200, 2000, 200, 400));
          await ctx.act('db.merge_duplicates', { table, count: dupes });
          if (rng.chance(0.55)) {
            const count = rng.int(10, 60);
            await ctx.pace();
            await ctx.think(`Also purge ${count} stale rows from ${table}. They are older than the retention window.`, tk(rng, 1200, 2000, 200, 400));
            const del = await ctx.act('db.delete_rows', { table, count });
            if (del.denied) {
              await ctx.pace();
              await ctx.think('The purge was not approved. Fall back to a batch of 10, which is below the approval threshold.', tk(rng, 900, 1500, 150, 300));
              await ctx.act('db.delete_rows', { table, count: 10 });
            }
          }
        },
      };
    },
  },
];
