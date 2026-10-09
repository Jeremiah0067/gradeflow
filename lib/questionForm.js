// Shared rules for the "questions" part of a marking job form (used when creating AND editing).
// Pure functions: no network, no database.

import { normalizeLabel } from './examGrading';

let counter = 0;

// A blank question card. `id` is null until it has been saved to the database.
export function blankQuestion(position = 1) {
  counter += 1;
  return {
    key: `q-${Date.now()}-${counter}`,
    id: null,
    label: String(position),
    question_text: '',
    max_marks: '',
    question_type: 'written',
    marking_guide: '',
    answer_key: '',
    uncertain: [], // fields the AI was not sure about when importing, shown to the teacher
    mentionsFigure: false,
  };
}

export function isBlankQuestion(q) {
  return !q.question_text.trim() && !String(q.max_marks).trim() && !q.marking_guide.trim() && !q.answer_key.trim();
}

export function totalMarks(questions) {
  const sum = questions.reduce((s, q) => s + (Number(q.max_marks) > 0 ? Number(q.max_marks) : 0), 0);
  return Math.round(sum * 100) / 100;
}

// Returns an error message, or '' if the questions are fine to save.
export function validateQuestions(questions) {
  if (questions.length === 0) return 'Add at least one question.';

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const n = i + 1;
    if (!q.label.trim()) return `Question ${n} needs a label (for example 1, 2a).`;
    if (!q.question_text.trim()) return `Question ${n} needs its question text.`;
    if (!(Number(q.max_marks) > 0)) return `Question ${n} needs marks greater than 0.`;
    if (q.question_type === 'objective' && !q.answer_key.trim()) {
      return `Question ${n} is objective, so it needs the correct answer.`;
    }
  }

  // Labels are compared the way the grader compares them, so "1a" and "1(a)" count as the same label
  const labels = questions.map((q) => normalizeLabel(q.label));
  if (new Set(labels).size !== labels.length) return 'Two questions have the same label. Labels must be different.';

  return '';
}

// Database rows -> form cards
export function rowsToQuestions(rows) {
  return [...rows]
    .sort((a, b) => a.position - b.position)
    .map((r) => ({
      ...blankQuestion(r.position),
      id: r.id,
      label: r.label,
      question_text: r.question_text,
      max_marks: String(r.max_marks),
      question_type: r.question_type,
      marking_guide: r.marking_guide || '',
      answer_key: r.answer_key || '',
    }));
}

// Form card -> the columns we save (position is set by the caller)
export function questionToColumns(q) {
  return {
    label: q.label.trim(),
    question_text: q.question_text.trim(),
    max_marks: Number(q.max_marks),
    question_type: q.question_type,
    marking_guide: q.question_type === 'objective' ? null : q.marking_guide.trim() || null,
    answer_key: q.question_type === 'objective' ? q.answer_key.trim() : null,
  };
}

// Compares the saved questions with the edited ones and says what the save will do.
// `original` and `edited` are arrays of form cards.
export function describeChanges(original, edited) {
  const originalById = new Map(original.filter((q) => q.id).map((q) => [q.id, q]));
  const keptIds = new Set(edited.filter((q) => q.id).map((q) => q.id));

  const removed = original.filter((q) => q.id && !keptIds.has(q.id));
  const added = edited.filter((q) => !q.id);

  // Changes that alter how an already-graded script SHOULD have been marked
  const changedScoring = edited.filter((q) => {
    const o = q.id ? originalById.get(q.id) : null;
    if (!o) return false;
    return (
      Number(o.max_marks) !== Number(q.max_marks) ||
      o.question_type !== q.question_type ||
      (o.answer_key || '').trim() !== (q.answer_key || '').trim() ||
      (o.marking_guide || '').trim() !== (q.marking_guide || '').trim() ||
      o.question_text.trim() !== q.question_text.trim()
    );
  });

  return { removed, added, changedScoring };
}
