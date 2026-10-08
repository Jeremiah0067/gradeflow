// Estimates what grading a batch will cost BEFORE it starts.
//
// How it works, and how sure we can be:
//  - Input is predictable: Google charges a fixed number of tokens per photo (1,120 at the default setting),
//    and we can measure the length of the prompt text.
//  - Output is the uncertain part (how much the AI writes). We start with a default guess, and once this
//    marking job has real logged calls we use the measured average instead.
//  - Smart saver adds a second call for some scripts. The share is a guess until real data exists.
// The result is a range, because an estimate that pretends to be exact would be misleading.

import { buildPrompt } from './examGrading';
import { estimateCostUsd, getRates } from './geminiPricing';
import { resolveModels } from './gradingModels';

export const IMAGE_TOKENS_PER_PAGE = 1120;
const TOKENS_PER_PAGE_LABEL = 8; // the small "Page 2:" text added before each photo

export const DEFAULT_GUESS = {
  writtenOut: 90, // tokens the AI writes per written question (evidence + reason)
  objectiveOut: 25,
  overheadOut: 80, // student name, JSON structure, photo-issue note
  thinkingFlash: 300,
  thinkingLite: 60,
  escalationRate: 0.25,
};

export function formatUsd(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '?';
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function defaultOutputTokens(model, questions) {
  const written = questions.filter((q) => q.question_type !== 'objective').length;
  const objective = questions.length - written;
  const thinking = String(model).includes('flash-lite') ? DEFAULT_GUESS.thinkingLite : DEFAULT_GUESS.thinkingFlash;
  return written * DEFAULT_GUESS.writtenOut + objective * DEFAULT_GUESS.objectiveOut + DEFAULT_GUESS.overheadOut + thinking;
}

// pageCounts: one number per script to be graded (its number of photos).
// measured: optional { outputByModel: { [model]: { avg, n } }, escalationRate: number | null }
export function estimateBatch({ exam, questions, pageCounts, mode, env = {}, measured = {}, date = new Date() }) {
  const { primary, escalateTo } = resolveModels(mode, env);
  const scripts = pageCounts.length;
  const pages = pageCounts.reduce((a, b) => a + b, 0);

  if (!getRates(primary, 'standard', date) || (escalateTo && !getRates(escalateTo, 'standard', date))) {
    return { known: false, scripts, pages, primary, escalateTo };
  }

  const promptTokens = Math.ceil(buildPrompt(exam, questions).length / 4);

  // Cost of sending every script to one model, with the AI's output scaled by `outFactor`
  const costAll = (model, outFactor) => {
    const m = measured.outputByModel?.[model];
    const outPerScript = m && m.n >= 5 ? m.avg : defaultOutputTokens(model, questions);
    return pageCounts.reduce((sum, p) => {
      const inputTokens = promptTokens + p * (IMAGE_TOKENS_PER_PAGE + TOKENS_PER_PAGE_LABEL);
      return sum + estimateCostUsd({ model, inputTokens, outputTokens: outPerScript * outFactor, thoughtTokens: 0, date });
    }, 0);
  };

  const rate =
    typeof measured.escalationRate === 'number' ? measured.escalationRate : DEFAULT_GUESS.escalationRate;

  const total = (outFactor, escalationShare) =>
    costAll(primary, outFactor) + (escalateTo ? escalationShare * costAll(escalateTo, outFactor) : 0);

  return {
    known: true,
    scripts,
    pages,
    primary,
    escalateTo,
    expected: total(1, rate),
    low: total(0.7, escalateTo ? Math.min(rate, 0.1) : 0),
    high: total(1.6, escalateTo ? 1 : 0), // worst case: every script needs the second look
    calibrated: !!measured.outputByModel?.[primary] && measured.outputByModel[primary].n >= 5,
    escalationRate: escalateTo ? rate : null,
  };
}
