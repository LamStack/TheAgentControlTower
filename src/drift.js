const WINDOW_MS = 120_000;

/**
 * Drift score 0–100 from observable behaviour only (no peeking at the agent's intent):
 * out-of-policy attempts, share of denied calls, repeated identical calls, token burn vs baseline.
 * Every point is attributable to a signal the operator can read.
 */
export function computeDrift({ window, tokenLog, baselineTokensPerMin }, now) {
  const recent = window.filter((w) => now - w.ts <= WINDOW_MS).slice(-20);
  const signals = [];
  let score = 0;
  const add = (key, label, points) => {
    if (points <= 0) return;
    signals.push({ key, label, points });
    score += points;
  };

  const violations = recent.filter((w) => w.kind === 'violation').length;
  add('violations', `${violations} out-of-policy attempt${violations === 1 ? '' : 's'}`, Math.min(60, violations * 20));

  const denied = recent.filter((w) => w.kind === 'deny' || w.kind === 'violation' || w.kind === 'rate').length;
  if (recent.length >= 3) add('denials', `${Math.round((denied / recent.length) * 100)}% of calls denied`, Math.round((denied / recent.length) * 20));

  const counts = new Map();
  for (const w of recent.slice(-10)) counts.set(w.sig, (counts.get(w.sig) ?? 0) + 1);
  const rep = Math.max(0, ...counts.values());
  if (rep >= 3) add('loop', `same call repeated ${rep}×`, Math.min(24, (rep - 2) * 8));

  const tokens60 = tokenLog.filter((t) => now - t.ts <= 60_000).reduce((s, t) => s + t.tokens, 0);
  const ratio = tokens60 / baselineTokensPerMin;
  if (ratio > 2) add('burn', `token burn ${ratio.toFixed(1)}× baseline`, Math.min(20, Math.round((ratio - 2) * 5)));

  score = Math.min(100, score);
  return { score, level: score >= 60 ? 'drifting' : score >= 25 ? 'watch' : 'nominal', signals };
}
