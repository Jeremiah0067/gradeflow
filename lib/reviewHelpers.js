// Pure helpers for the review screen (no network), so they can be tested on their own.

export const BULK_MIN_MEAN = 0.85; // overall confidence needed for "approve all confident"
export const BULK_MIN_QUESTION = 0.6; // and no single question may be below this
export const LOW_CONFIDENCE = 0.6; // below this a question is highlighted for the teacher

const RANK = { flagged: 0, needs_review: 1, approved: 2 };

// Scripts needing the most attention come first: flagged, then least confident, approved last.
export function sortForReview(papers, nameOf) {
  return [...papers].sort((a, b) => {
    const ra = RANK[a.status] ?? 3;
    const rb = RANK[b.status] ?? 3;
    if (ra !== rb) return ra - rb;
    const ca = Number(a.ai_confidence ?? 0);
    const cb = Number(b.ai_confidence ?? 0);
    if (ca !== cb) return ca - cb;
    return nameOf(a).localeCompare(nameOf(b));
  });
}

export function minConfidence(scores) {
  if (!scores || scores.length === 0) return 0;
  return Math.min(...scores.map((s) => Number(s.confidence ?? 0)));
}

// A script may be approved in bulk only if it is clearly safe: not flagged, assigned to a student,
// confident overall, and with no shaky question.
export function isBulkEligible(paper, scores) {
  return (
    paper.status === 'needs_review' &&
    !!paper.student_id &&
    Number(paper.ai_confidence ?? 0) >= BULK_MIN_MEAN &&
    minConfidence(scores) >= BULK_MIN_QUESTION
  );
}

// Checks the marks the teacher typed. Returns { error } or { rows, total }.
export function checkMarks(questions, draft) {
  const rows = [];
  for (const q of questions) {
    const raw = String(draft[q.id] ?? '').trim();
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n)) return { error: `Question ${q.label}: enter the marks as a number.` };
    if (n < 0 || n > Number(q.max_marks)) {
      return { error: `Question ${q.label}: marks must be between 0 and ${q.max_marks}.` };
    }
    rows.push({ question_id: q.id, marks: Math.round(n * 100) / 100 });
  }
  const total = Math.round(rows.reduce((sum, r) => sum + r.marks, 0) * 100) / 100;
  return { rows, total };
}
