/**
 * lib/geminiPricing.js
 * Cost management, budget enforcement, and pricing rules for Gemini models.
 */

export const GEMINI_MODEL_RATES = {
  'gemini-1.5-flash': {
    inputPerM: 0.075,
    outputPerM: 0.30,
    maxBudgetPerPaper: 0.05,
  },
  'gemini-1.5-flash-8b': {
    inputPerM: 0.0375,
    outputPerM: 0.15,
    maxBudgetPerPaper: 0.02,
  },
  'gemini-1.5-pro': {
    inputPerM: 1.25,
    outputPerM: 5.00,
    maxBudgetPerPaper: 0.25,
  },
  'gemini-2.0-flash-exp': {
    inputPerM: 0.00,
    outputPerM: 0.00,
    maxBudgetPerPaper: 0.00,
  },
  default: {
    inputPerM: 0.075,
    outputPerM: 0.30,
    maxBudgetPerPaper: 0.05,
  },
};

export function getGeminiModelRates(modelName) {
  if (!modelName) return GEMINI_MODEL_RATES.default;
  const key = String(modelName).trim().toLowerCase();
  return GEMINI_MODEL_RATES[key] || GEMINI_MODEL_RATES.default;
}

export function calculateGeminiCost(modelName, promptTokens = 0, candidateTokens = 0) {
  const rates = getGeminiModelRates(modelName);

  const pTokens = Math.max(0, Number(promptTokens) || 0);
  const cTokens = Math.max(0, Number(candidateTokens) || 0);

  const inputCost = (pTokens / 1_000_000) * rates.inputPerM;
  const outputCost = (cTokens / 1_000_000) * rates.outputPerM;

  const totalCost = inputCost + outputCost;
  return Number(totalCost.toFixed(6));
}

export function validateCostWithinBudget(modelName, estimatedPromptTokens = 0, maxAllowedUsd = 0.10) {
  const rates = getGeminiModelRates(modelName);
  const estimatedInputCost = (estimatedPromptTokens / 1_000_000) * rates.inputPerM;
  const estimatedOutputCost = (2048 / 1_000_000) * rates.outputPerM;
  const maxEstimated = estimatedInputCost + estimatedOutputCost;

  if (maxEstimated > maxAllowedUsd) {
    return {
      allowed: false,
      reason: `Estimated cost ($${maxEstimated.toFixed(4)}) exceeds per-paper budget limit ($${maxAllowedUsd.toFixed(4)}).`,
      estimatedCost: maxEstimated,
    };
  }

  return {
    allowed: true,
    estimatedCost: maxEstimated,
  };
}
