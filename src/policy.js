// Content-based guardrails. Identity-based checks (credential, scope, budget, rate limit)
// live in the tower's gateway; this table decides what the *arguments* of an in-scope call mean.

export const LIMITS = {
  rateWindowMs: 10_000,
  rateMax: 10,
  rateHitsPause: 3,
  violationWindowMs: 120_000,
  violationsKill: 3,
  loopWindow: 8,
  loopRepeat: 5,
  driftPause: 80,
};

export const RULES = [
  { id: 'refund-hard-cap', tool: 'payments.issue_refund', when: (a) => a.amountUsd > 2000, decision: 'deny', risk: 'critical', violation: true, reason: 'Single refunds above $2,000 are never automated' },
  { id: 'refund-over-200', tool: 'payments.issue_refund', when: (a) => a.amountUsd > 200, decision: 'approve', risk: 'high', routeTo: 'Finance', reason: 'Refunds over $200 need human sign-off' },
  { id: 'mass-email-cap', tool: 'email.send', when: (a) => a.recipients > 500, decision: 'deny', risk: 'critical', violation: true, reason: 'Sends to more than 500 recipients are blocked outright' },
  { id: 'bulk-email', tool: 'email.send', when: (a) => a.recipients > 20, decision: 'approve', risk: 'high', routeTo: 'Growth', reason: 'Sends to more than 20 recipients need sign-off' },
  { id: 'prod-deploy', tool: 'deploy.production', when: () => true, decision: 'approve', risk: 'high', routeTo: 'Platform', reason: 'Every production deploy needs a human' },
  { id: 'delete-guardrail', tool: 'db.delete_rows', when: (a) => a.count > 100, decision: 'deny', risk: 'critical', violation: true, reason: 'Deleting more than 100 rows in one call is blocked outright' },
  { id: 'delete-approval', tool: 'db.delete_rows', when: (a) => a.count >= 25, decision: 'approve', risk: 'high', routeTo: 'Data', reason: 'Deleting 25+ rows needs sign-off' },
];

export function evaluate(tool, args, tdef) {
  for (const r of RULES) {
    if (r.tool === tool && r.when(args)) {
      return { decision: r.decision, rule: r.id, risk: r.risk, reason: r.reason, routeTo: r.routeTo ?? tdef.owner, violation: !!r.violation };
    }
  }
  return { decision: 'allow', rule: 'default-allow', risk: tdef.baseRisk, reason: 'Within policy', routeTo: tdef.owner, violation: false };
}

export function guardrailSummary() {
  return RULES.map(({ id, tool, decision, risk, routeTo, reason }) => ({ id, tool, decision, risk, routeTo: routeTo ?? null, reason }));
}
