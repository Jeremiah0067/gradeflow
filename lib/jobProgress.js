// Works out where a marking job is up to, and the ONE thing the teacher should do next.
// Pure logic (no screen, no database), so it can be tested on its own.

export const MAX_ATTEMPTS = 3; // keep in step with lib/gradeExamPaper.js
export const STALE_GRADING_MS = 10 * 60 * 1000;

const GRADED = ['needs_review', 'flagged', 'approved'];

// A script that can be sent to the AI now
export function isGradable(paper, now = Date.now()) {
  if (['uploaded', 'queued'].includes(paper.status)) return true;
  if (paper.status === 'failed') return (paper.grading_attempts || 0) < MAX_ATTEMPTS;
  if (paper.status === 'grading' && paper.grading_started_at) {
    return now - new Date(paper.grading_started_at).getTime() > STALE_GRADING_MS;
  }
  return false;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// papers: [{ status, grading_attempts, grading_started_at }]
export function computeProgress({ questionCount, rosterCount, papers, now = Date.now() }) {
  const uploaded = papers.length;
  const gradable = papers.filter((p) => isGradable(p, now)).length;
  const inProgress = papers.filter((p) => p.status === 'grading' && !isGradable(p, now)).length;
  const graded = papers.filter((p) => GRADED.includes(p.status)).length;
  const approved = papers.filter((p) => p.status === 'approved').length;
  const toReview = graded - approved;
  const stuck = papers.filter((p) => p.status === 'failed' && (p.grading_attempts || 0) >= MAX_ATTEMPTS).length;
  const missing = Math.max(0, rosterCount - uploaded);

  // ---- the one next thing to do ----
  let next;
  if (uploaded === 0) {
    next = {
      kind: 'add',
      title: 'Add the students\u2019 scripts',
      hint: `Photograph each script, or choose photos from your gallery. ${plural(rosterCount, 'student')} on the roster.`,
    };
  } else if (gradable > 0) {
    next = {
      kind: 'grade',
      title: `Grade ${plural(gradable, 'script')}`,
      hint: 'The AI marks them in one batch. You review every result before anything is final.',
    };
  } else if (inProgress > 0) {
    next = { kind: 'wait', title: 'Grading is in progress', hint: `${plural(inProgress, 'script')} being marked now.` };
  } else if (toReview > 0) {
    next = {
      kind: 'review',
      title: `Review ${plural(toReview, 'graded script')}`,
      hint: 'Check the marks, change anything you disagree with, then approve.',
    };
  } else if (approved > 0) {
    next = { kind: 'export', title: 'Export the results', hint: `${plural(approved, 'approved score')} ready for a spreadsheet.` };
  } else {
    next = {
      kind: 'retry',
      title: 'Some scripts could not be graded',
      hint: `${plural(stuck, 'script')} failed. Open the list below and use Retry, or check the photos.`,
    };
  }
  if (next.kind !== 'add' && missing > 0) {
    next = { ...next, hint: `${next.hint} ${plural(missing, 'student')} still ${missing === 1 ? 'has' : 'have'} no script.` };
  }

  // ---- the rail ----
  const currentIndex = { add: 1, grade: 2, wait: 2, retry: 2, review: 3, export: 4 }[next.kind];
  const labels = [
    { key: 'questions', label: 'Questions', count: plural(questionCount, 'question') },
    { key: 'scripts', label: 'Scripts', count: `${uploaded} of ${rosterCount}` },
    { key: 'grading', label: 'Grading', count: uploaded ? `${graded} of ${uploaded}` : 'not started' },
    { key: 'review', label: 'Review', count: graded ? `${approved} of ${graded}` : 'not started' },
    { key: 'export', label: 'Export', count: approved ? `${approved} ready` : 'not yet' },
  ];
  const steps = labels.map((s, i) => ({ ...s, state: i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'todo' }));

  return { steps, next, counts: { uploaded, gradable, inProgress, graded, approved, toReview, stuck, missing } };
}
