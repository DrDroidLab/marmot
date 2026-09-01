/**
 * Published API rates, USD per million tokens.
 *
 * On a subscription plan (Pro, Max, Team) none of this is an invoice line.
 * It is a shadow price: what these tokens would have cost on the API. That
 * makes it the right number for comparing your own sessions to each other,
 * and the wrong number to take to finance. Every surface that prints a dollar
 * figure says so.
 *
 * Prefix match, longest first, so `claude-opus-5` catches any future suffix.
 */
export const RATES = {
  "claude-fable-5": { in: 10, out: 50 },
  "claude-mythos-5": { in: 10, out: 50 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

/** Opus 5 fast mode is the same model at premium rates; `usage.speed` names it. */
export const FAST_RATES = {
  "claude-opus-5": { in: 10, out: 50 },
  "claude-opus-4-8": { in: 10, out: 50 },
};

/**
 * Cache multipliers against the input rate. A five-minute write costs 1.25x,
 * a one-hour write 2x. Claude Code writes 1h entries, so treating every write
 * as 1.25x understates a heavy session materially — which is why we read the
 * `cache_creation` breakdown rather than the flat `cache_creation_input_tokens`.
 */
export const CACHE_READ = 0.1;
export const CACHE_WRITE_5M = 1.25;
export const CACHE_WRITE_1H = 2.0;

export function rateFor(model, speed, overrides = {}) {
  if (!model) return null;
  const table = speed === "fast" ? { ...FAST_RATES } : { ...RATES, ...overrides };
  const key = Object.keys(table)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return key ? table[key] : null;
}

/** Cost of one assistant turn, or null when the model has no published rate. */
export function turnCost(usage, model, overrides) {
  const r = rateFor(model, usage?.speed, overrides);
  if (!r) return null;
  const c = usage.cache_creation ?? {};
  // Older transcripts carry only the flat total; assume 5m, the cheaper read.
  const w5 = c.ephemeral_5m_input_tokens ?? (c.ephemeral_1h_input_tokens === undefined ? (usage.cache_creation_input_tokens ?? 0) : 0);
  const w1 = c.ephemeral_1h_input_tokens ?? 0;
  return (
    ((usage.input_tokens ?? 0) * r.in +
      (usage.cache_read_input_tokens ?? 0) * r.in * CACHE_READ +
      w5 * r.in * CACHE_WRITE_5M +
      w1 * r.in * CACHE_WRITE_1H +
      (usage.output_tokens ?? 0) * r.out) /
    1_000_000
  );
}
