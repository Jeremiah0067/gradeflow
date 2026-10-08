/**
 * lib/examGrading.js
 * High-rigor AI evaluation engine for GradeFlow marking system.
 * Enforces strict prompt boundaries, structured JSON validation, score clamping,
 * and detailed error handling against AI hallucinations.
 */

/**
 * Builds a strict, constrained prompt for Gemini evaluation.
 */
export function buildGradingPrompt(exam, questions, studentScriptText = '') {
  const formattedQuestions = questions.map((q, idx) => {
    const qId = q.id || `q_${idx + 1}`;
    const maxPts = Number(q.max_score || q.points || q.max_points || 10);
    const text = q.question_text || q.prompt || q.text || `Question ${idx + 1}`;
    const rubric = q.rubric || q.marking_scheme || q.scheme || 'Grade based on accuracy, completeness, and clarity.';

    return `
---
QUESTION ID: ${qId}
INDEX: ${idx + 1}
MAX SCORE: ${maxPts}
QUESTION TEXT:
${text}

MARKING SCHEME / RUBRIC:
${rubric}
---`;
  }).join('\n');

  return `
SYSTEM DIRECTIVE: YOU ARE A RIGOROUS ACADEMIC EXAMINER AND GRADING AUDITOR.
YOUR TASK IS TO GRADE HANDWRITTEN EXAM PAPERS STRICTLY AGAINST THE PROVIDED RUBRIC.

### EXAM METADATA
- Title: ${exam.title || 'Examination'}
- Course Code: ${exam.course_code || 'N/A'}
- Total Questions: ${questions.length}

### QUESTIONS & MARKING SCHEMES
${formattedQuestions}

### TRANSCRIPTION / OCR CONTENT
${studentScriptText ? studentScriptText : '[No text transcript provided; evaluate visual attachments directly]'}

### STRICT EVALUATION RULES
1. DO NOT award points above the max_score for any question under any circumstance.
2. If an answer is blank, illegible, or incorrect, assign 0.
3. Base marks EXCLUSIVELY on the rubric criteria. Do not infer unstated knowledge.
4. Output MUST be valid JSON matching the exact schema below. Do not wrap in conversational text.

### REQUIRED JSON SCHEMA
{
  "questions": [
    {
      "question_id": "string",
      "score": number,
      "max_score": number,
      "feedback": "string",
      "confidence": number
    }
  ],
  "overall_feedback": "string",
  "confidence_score": number
}
`;
}

/**
 * Sanitizes and strictly validates Gemini AI grading outputs to guard against hallucination,
 * out-of-bounds scores, or schema mismatches.
 */
export function validateAndSanitizeGrading(rawOutput, questions = []) {
  if (!rawOutput || typeof rawOutput !== 'object') {
    throw new Error('Invalid AI response payload: Expected JSON object');
  }

  const rawQuestions = Array.isArray(rawOutput.questions) ? rawOutput.questions : [];
  let calculatedTotalScore = 0;
  let calculatedMaxPossible = 0;

  const sanitizedQuestions = questions.map((q, idx) => {
    const qId = String(q.id || `q_${idx + 1}`);
    const maxScore = Number(q.max_score || q.points || 10);
    calculatedMaxPossible += maxScore;

    const matched = rawQuestions.find(
      (rq) => String(rq.question_id) === qId || Number(rq.index) === idx + 1
    );

    let assignedScore = matched && typeof matched.score === 'number' ? matched.score : 0;

    // Strict score clamping (0 <= assignedScore <= maxScore)
    if (isNaN(assignedScore) || assignedScore < 0) {
      assignedScore = 0;
    } else if (assignedScore > maxScore) {
      assignedScore = maxScore;
    }

    calculatedTotalScore += assignedScore;

    return {
      question_id: qId,
      score: assignedScore,
      max_score: maxScore,
      feedback: matched?.feedback ? String(matched.feedback).trim() : 'No individual question feedback provided by evaluator.',
      confidence: matched && typeof matched.confidence === 'number'
        ? Math.min(Math.max(matched.confidence, 0), 1)
        : 0.8,
    };
  });

  const rawOverallConf = typeof rawOutput.confidence_score === 'number'
    ? rawOutput.confidence_score
    : 0.85;

  const confidenceScore = Math.min(Math.max(rawOverallConf, 0), 1);

  return {
    questions: sanitizedQuestions,
    total_score: calculatedTotalScore,
    max_possible_score: calculatedMaxPossible,
    percentage: calculatedMaxPossible > 0 ? (calculatedTotalScore / calculatedMaxPossible) * 100 : 0,
    overall_feedback: rawOutput.overall_feedback
      ? String(rawOutput.overall_feedback).trim()
      : 'Grading completed.',
    confidence_score: confidenceScore,
    needs_human_review: confidenceScore < 0.65 || sanitizedQuestions.some((q) => q.confidence < 0.5),
  };
}

/**
 * Executes a high-rigor Gemini grading call with tight timeout and response enforcement.
 */
export async function runGeminiGrading({
  apiKey,
  modelName,
  prompt,
  imageParts = [],
  questions = [],
  timeoutMs = 45000,
}) {
  if (!apiKey) {
    throw new Error('API Key Missing: GEMINI_API_KEY is required for exam grading.');
  }

  const model = modelName || process.env.GEMINI_MODEL || 'gemini-1.5-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const contents = [
    {
      parts: [
        ...imageParts.map((img) => ({
          inlineData: {
            mimeType: img.mimeType || 'image/jpeg',
            data: img.data,
          },
        })),
        { text: prompt },
      ],
    },
  ];

  const body = {
    contents,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.0, // Zero temperature for maximum determinism & strict rubric adherence
      maxOutputTokens: 2048,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini Service Error (${res.status}): ${errText}`);
    }

    const json = await res.json();
    const candidate = json.candidates?.[0];

    if (!candidate || candidate.finishReason === 'SAFETY' || candidate.finishReason === 'RECITATION') {
      throw new Error(`Gemini evaluation blocked due to finishReason: ${candidate?.finishReason || 'NO_CANDIDATE'}`);
    }

    let textResponse = candidate?.content?.parts?.[0]?.text;
    if (!textResponse) {
      throw new Error('Gemini returned empty response content.');
    }

    textResponse = textResponse.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

    let parsedResult;
    try {
      parsedResult = JSON.parse(textResponse);
    } catch (parseErr) {
      throw new Error(`Failed to parse AI JSON output: ${parseErr.message}`);
    }

    const sanitizedResult = validateAndSanitizeGrading(parsedResult, questions);
    const usageMetadata = json.usageMetadata || {};

    return {
      result: sanitizedResult,
      usage: {
        model,
        promptTokens: usageMetadata.promptTokenCount || 0,
        candidateTokens: usageMetadata.candidatesTokenCount || 0,
        totalTokens: usageMetadata.totalTokenCount || 0,
      },
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`Gemini evaluation timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}
