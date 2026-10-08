// Which AI model grades a script, and when to ask a stronger one.
// No network or database here, so it can be tested on its own.

export const DEFAULT_STANDARD_MODEL = 'gemini-3.6-flash';
export const DEFAULT_ECONOMY_MODEL = 'gemini-3.5-flash-lite';

export const GRADING_MODES = [
  {
    id: 'standard',
    label: 'Standard (best quality)',
    blurb: 'Every script is marked by the main model. The most reliable choice.',
  },
  {
    id: 'smart',
    label: 'Smart saver (recommended once tested)',
    blurb:
      'The cheaper model marks first. If it looks unsure, or reports a photo problem, the main model marks that script again. You pay for the second look only when it is needed.',
  },
  {
    id: 'economy',
    label: 'Economy (cheapest)',
    blurb: 'Only the cheaper model is used. Test it on real scripts before relying on it.',
  },
];

// env: an object like process.env. Optional overrides: GEMINI_MODEL and GEMINI_ECONOMY_MODEL.
export function resolveModels(mode, env = {}) {
  const standard = env.GEMINI_MODEL || DEFAULT_STANDARD_MODEL;
  const economy = env.GEMINI_ECONOMY_MODEL || DEFAULT_ECONOMY_MODEL;
  if (mode === 'economy') return { primary: economy, escalateTo: null };
  if (mode === 'smart') return { primary: economy, escalateTo: standard };
  return { primary: standard, escalateTo: null };
}

// Flash-Lite models think minimally by default, which is the cheapest setting,
// so we send no thinking setting for them. Other models keep the "low" setting used by the rest of the app.
export function thinkingConfigFor(model) {
  if (String(model).includes('flash-lite')) return null;
  return { thinkingLevel: 'low' };
}

export const ESCALATE_BELOW_MEAN = 0.8;
export const ESCALATE_BELOW_QUESTION = 0.6;

// `scored` comes from scoreAnswers(). True means "a stronger model should look at this script".
export function needsEscalation(scored) {
  if (scored.flagged) return true; // missing answers, photo problems or very low confidence
  if (scored.meanConfidence < ESCALATE_BELOW_MEAN) return true;
  return scored.rows.some((r) => r.confidence < ESCALATE_BELOW_QUESTION);
}
