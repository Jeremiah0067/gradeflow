import { buildPrompt, parseAiJson, scoreAnswers } from './examGrading';
import { matchStudent } from './matchStudent';
import { estimateCostUsd } from './geminiPricing';
import { resolveModels, thinkingConfigFor, needsEscalation } from './gradingModels';

const BUCKET = 'exam-papers';
const MAX_ATTEMPTS = 3; // a script that keeps failing stops costing money after this many tries
const STALE_GRADING_MS = 10 * 60 * 1000; // a script stuck in "grading" this long is treated as abandoned
const MAX_OUTPUT_TOKENS = 8000; // hard cap so one bad response can't run up a bill

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Calls Gemini. Retries only on "busy" errors (429/503), which are not billed.
async function callGemini(apiKey, model, parts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const delays = [2000, 6000];
  let thinkingConfig = thinkingConfigFor(model);

  for (let attempt = 0; ; attempt++) {
    const generationConfig = { responseMimeType: 'application/json', maxOutputTokens: MAX_OUTPUT_TOKENS };
    if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      // This model rejected the thinking setting: send the same request without it (a rejected request is not billed)
      if (res.status === 400 && thinkingConfig && /thinking/i.test(data?.error?.message || '')) {
        thinkingConfig = null;
        attempt -= 1;
        continue;
      }
      const busy = res.status === 429 || res.status === 503;
      if (busy && attempt < delays.length) {
        await sleep(delays[attempt]);
        continue;
      }
      throw new Error(data?.error?.message || `Gemini request failed (${res.status}).`);
    }

    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.find((p) => p.text)?.text;
    return { text, finishReason: candidate?.finishReason, usage: data.usageMetadata || {}, blockReason: data.promptFeedback?.blockReason };
  }
}

async function fetchAllStudents(supabase, examId) {
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('exam_students')
      .select('id, full_name, reg_no')
      .eq('exam_id', examId)
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all;
}

async function logUsage(supabase, { examId, paperId, model, usage, pageCount }) {
  const cost = estimateCostUsd({
    model,
    inputTokens: usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount,
    thoughtTokens: usage.thoughtsTokenCount,
  });
  const row = {
    exam_id: examId,
    paper_id: paperId,
    model,
    service_tier: 'standard',
    input_tokens: usage.promptTokenCount ?? null,
    output_tokens: usage.candidatesTokenCount ?? null,
    thought_tokens: usage.thoughtsTokenCount ?? null,
    est_cost_usd: cost,
    page_count: pageCount,
  };
  let { error } = await supabase.from('exam_ai_usage').insert(row);
  if (error) {
    // Most likely the Phase 7 SQL has not been run yet (no page_count column). Never lose the cost record.
    console.error('exam_ai_usage insert failed, retrying without page_count:', error.message);
    delete row.page_count;
    ({ error } = await supabase.from('exam_ai_usage').insert(row));
    if (error) console.error('exam_ai_usage insert failed again:', error.message);
  }
  return cost;
}

// Total estimated cost logged so far for one marking job
async function totalSpent(supabase, examId) {
  let total = 0;
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('exam_ai_usage')
      .select('est_cost_usd')
      .eq('exam_id', examId)
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    total += data.reduce((sum, r) => sum + (Number(r.est_cost_usd) || 0), 0);
    if (data.length < PAGE) break;
  }
  return total;
}

// Grades ONE script. `supabase` must be the service-role client.
// The caller (the API route) has already checked that the teacher owns this script.
export async function gradeExamPaper(supabase, apiKey, paperId, { force = false } = {}) {
  const { data: paper, error: paperErr } = await supabase
    .from('exam_papers')
    .select('*, exam_paper_pages(page_no, storage_path, mime_type)')
    .eq('id', paperId)
    .maybeSingle();
  if (paperErr || !paper) return { ok: false, error: 'Script not found.' };

  // ---- Decide whether this script may be graded right now ----
  const startedAt = paper.grading_started_at ? new Date(paper.grading_started_at).getTime() : 0;
  const staleGrading = paper.status === 'grading' && Date.now() - startedAt > STALE_GRADING_MS;
  const allowed =
    ['uploaded', 'queued', 'failed'].includes(paper.status) ||
    staleGrading ||
    (force && ['needs_review', 'flagged'].includes(paper.status));

  if (!allowed) return { ok: true, skipped: true, reason: `Status is "${paper.status}", so it was not graded.` };

  if (paper.status === 'failed' && (paper.grading_attempts || 0) >= MAX_ATTEMPTS && !force) {
    return { ok: true, skipped: true, reason: 'Too many failed attempts. Check the photos, then use Retry.' };
  }

  // ---- Spending limit: refuse before claiming, so the script simply stays queued ----
  const { data: examForBudget } = await supabase.from('exams').select('*').eq('id', paper.exam_id).maybeSingle();
  if (examForBudget && examForBudget.budget_usd !== null && examForBudget.budget_usd !== undefined) {
    const spent = await totalSpent(supabase, paper.exam_id);
    if (spent >= Number(examForBudget.budget_usd)) {
      return {
        ok: false,
        budgetReached: true,
        error: `Spending limit reached ($${spent.toFixed(4)} of $${Number(examForBudget.budget_usd).toFixed(2)}). Raise the limit to continue.`,
      };
    }
  }

  // ---- Claim it. If another worker got there first, this update matches no rows ----
  const { data: claimed } = await supabase
    .from('exam_papers')
    .update({
      status: 'grading',
      grading_attempts: (paper.grading_attempts || 0) + 1,
      grading_started_at: new Date().toISOString(),
      last_error: null,
    })
    .eq('id', paperId)
    .eq('status', paper.status)
    .eq('grading_attempts', paper.grading_attempts || 0)
    .select('id');
  if (!claimed || claimed.length === 0) {
    return { ok: true, skipped: true, reason: 'Another worker already picked this script up.' };
  }

  try {
    const pages = [...(paper.exam_paper_pages || [])].sort((a, b) => a.page_no - b.page_no);
    if (pages.length === 0) throw new Error('This script has no photos.');

    const exam = examForBudget;
    const { data: questions } = await supabase
      .from('exam_questions')
      .select('*')
      .eq('exam_id', paper.exam_id)
      .order('position');
    if (!exam || !questions || questions.length === 0) throw new Error('This marking job has no questions.');

    // ---- Build the request: instructions first, then every page photo ----
    const images = await Promise.all(
      pages.map(async (page) => {
        const { data: blob, error } = await supabase.storage.from(BUCKET).download(page.storage_path);
        if (error || !blob) throw new Error(`Could not download page ${page.page_no}: ${error?.message || 'unknown error'}`);
        const buffer = Buffer.from(await blob.arrayBuffer());
        return { page_no: page.page_no, mime_type: page.mime_type || 'image/jpeg', data: buffer.toString('base64') };
      })
    );

    const parts = [{ text: buildPrompt(exam, questions) }];
    images.forEach((img) => {
      parts.push({ text: `Page ${img.page_no}:` });
      parts.push({ inline_data: { mime_type: img.mime_type, data: img.data } });
    });

    // ---- Ask the AI. Each call is logged straight away (it is billed even if the reply is unusable) ----
    let spentOnThisScript = 0;
    const runModel = async (model) => {
      const result = await callGemini(apiKey, model, parts);
      spentOnThisScript += await logUsage(supabase, {
        examId: paper.exam_id,
        paperId,
        model,
        usage: result.usage,
        pageCount: pages.length,
      });

      if (result.blockReason) throw new Error(`The AI declined to read this script (${result.blockReason}).`);
      if (!result.text) throw new Error('The AI returned no text.');
      if (result.finishReason === 'MAX_TOKENS') throw new Error('The AI reply was cut off. Try again.');
      return scoreAnswers(questions, parseAiJson(result.text));
    };

    // Standard and Economy use one model. Smart saver tries the cheap one first and only
    // asks the stronger one when the result looks unsure, or the cheap model failed outright.
    const { primary, escalateTo } = resolveModels(exam.grading_mode || 'standard', process.env);
    let model = primary;
    let escalated = false;
    let scored = null;
    let needStronger = false;

    try {
      scored = await runModel(primary);
      needStronger = !!escalateTo && needsEscalation(scored);
    } catch (err) {
      if (!escalateTo) throw err;
      needStronger = true;
    }
    if (needStronger) {
      scored = await runModel(escalateTo);
      model = escalateTo;
      escalated = true;
    }
    const cost = spentOnThisScript;

    // ---- Work out which student this is (only if the teacher did not already choose) ----
    let studentId = paper.student_id;
    let matchConfidence = paper.match_confidence ?? null;
    let matchNote = null;

    if (!studentId) {
      const [students, { data: takenRows }] = await Promise.all([
        fetchAllStudents(supabase, paper.exam_id),
        supabase.from('exam_papers').select('student_id').eq('exam_id', paper.exam_id).not('student_id', 'is', null).neq('id', paperId),
      ]);
      const taken = new Set((takenRows || []).map((r) => r.student_id));
      const match = matchStudent(scored.student, students, taken);
      if (match.student) {
        studentId = match.student.id;
        matchConfidence = match.score;
      } else {
        matchNote = match.note || null;
      }
    }

    // ---- Save the scores (upsert, so a regrade replaces the old ones) ----
    const { error: scoreErr } = await supabase.from('exam_scores').upsert(
      scored.rows.map((r) => ({
        paper_id: paperId,
        question_id: r.question_id,
        ai_marks: r.ai_marks,
        final_marks: r.ai_marks,
        student_answer: r.student_answer,
        evidence: r.evidence,
        reasoning: r.reasoning,
        confidence: r.confidence,
        overridden: false,
      })),
      { onConflict: 'paper_id,question_id' }
    );
    if (scoreErr) throw new Error(scoreErr.message);

    const paperUpdate = {
      status: scored.flagged ? 'flagged' : 'needs_review',
      ai_total: scored.aiTotal,
      final_total: scored.aiTotal,
      ai_confidence: scored.meanConfidence,
      detected_name: scored.student.name,
      detected_reg_no: scored.student.reg_no,
      page_issues: scored.pageIssues,
      ai_model: model,
      escalated,
      graded_at: new Date().toISOString(),
      last_error: null,
      student_id: studentId,
      match_confidence: matchConfidence,
      match_note: matchNote,
    };

    let { error: updErr } = await supabase.from('exam_papers').update(paperUpdate).eq('id', paperId);

    // Two scripts matched the same student at the same moment: keep this one unassigned for the teacher to sort out
    if (updErr && updErr.code === '23505') {
      ({ error: updErr } = await supabase
        .from('exam_papers')
        .update({ ...paperUpdate, student_id: null, match_confidence: null, match_note: 'Looks like a student who already has a script. Please check.' })
        .eq('id', paperId));
    }
    if (updErr) throw new Error(updErr.message);

    return {
      ok: true,
      status: paperUpdate.status,
      aiTotal: scored.aiTotal,
      matched: !!studentId,
      escalated,
      model,
      costUsd: cost,
    };
  } catch (err) {
    await supabase
      .from('exam_papers')
      .update({ status: 'failed', last_error: String(err.message || err).slice(0, 500) })
      .eq('id', paperId);
    return { ok: false, error: err.message || String(err) };
  }
}
