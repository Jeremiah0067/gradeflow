// Estimated cost of a Gemini call, in US dollars.
// Source: Google's official pricing page (ai.google.dev/gemini-api/docs/pricing), checked 2026-10-07.
// Prices change, so treat the result as an estimate and compare it with your Google billing page.
//
// Note: "thinking" tokens are billed as output tokens.
// The 3.6 / 3.7 / 3.8 Flash models double in price on 1 January 2027 (handled below by date).

const INCREASE_DATE = new Date('2027-01-01T00:00:00Z');
const FLASH_3X = ['gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash'];

// Returns { in, out } in dollars per million tokens, or null if we don't know this model.
export function getRates(model, tier = 'standard', date = new Date()) {
  let rates = null;

  if (FLASH_3X.includes(model)) {
    rates = date >= INCREASE_DATE ? { in: 1.5, out: 7.5 } : { in: 0.75, out: 3.75 };
  } else if (model === 'gemini-3.5-flash') {
    rates = { in: 1.5, out: 9.0 };
  } else if (model === 'gemini-3.5-flash-lite') {
    rates = { in: 0.3, out: 2.5 };
  } else if (model === 'gemini-3.1-flash-lite') {
    rates = { in: 0.25, out: 1.5 };
  }

  if (!rates) return null;
  const multiplier = tier === 'flex' || tier === 'batch' ? 0.5 : 1;
  return { in: rates.in * multiplier, out: rates.out * multiplier };
}

export function estimateCostUsd({ model, inputTokens, outputTokens, thoughtTokens, tier = 'standard', date = new Date() }) {
  const rates = getRates(model, tier, date);
  if (!rates || typeof inputTokens !== 'number') return null;
  const out = (outputTokens || 0) + (thoughtTokens || 0);
  return (inputTokens * rates.in + out * rates.out) / 1_000_000;
}
