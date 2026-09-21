// Illustrative per-million-token rates for the simulation. Swap in your contract rates.
export const MODELS = {
  'haiku-class': { label: 'Haiku-class', inPerM: 1, outPerM: 5 },
  'sonnet-class': { label: 'Sonnet-class', inPerM: 3, outPerM: 15 },
  'opus-class': { label: 'Opus-class', inPerM: 15, outPerM: 75 },
};

export function costUsd(model, tokensIn, tokensOut) {
  const m = MODELS[model] ?? MODELS['sonnet-class'];
  return (tokensIn * m.inPerM + tokensOut * m.outPerM) / 1_000_000;
}
