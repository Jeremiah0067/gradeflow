// A record of corrections: who changed which student or mark, from what, to what, and when.
// Writing the record never blocks a save. If the table is not there yet, saving still works.

export async function logEvent(supabase, { examId, paperId, userId, kind, detail = {} }) {
  try {
    const { error } = await supabase.from('exam_paper_events').insert({ exam_id: examId, paper_id: paperId, user_id: userId, kind, detail });
    return !error;
  } catch {
    return false;
  }
}

// The questions whose marks differ from what is saved. before = what is saved now, after = what the teacher typed.
export function marksChanges(questions, scoreByQuestion, draftMarks) {
  return questions
    .map((q) => {
      const s = scoreByQuestion[q.id];
      const from = Number(s?.final_marks ?? s?.ai_marks ?? 0);
      const typed = String(draftMarks[q.id] ?? '').trim();
      const to = typed === '' ? NaN : Number(typed); // an empty box is not a mark of 0
      return Number.isFinite(to) && to !== from ? { question_id: q.id, label: q.label, from, to } : null;
    })
    .filter(Boolean);
}

export function describeEvent(ev, studentById = {}) {
  const d = ev.detail || {};
  const name = (id) => studentById[id]?.full_name || 'nobody';
  const prefix = d.undo ? 'Undone: ' : '';
  switch (ev.kind) {
    case 'student_changed':
      return `${prefix}Student changed from ${name(d.from)} to ${name(d.to)}`;
    case 'marks_changed': {
      const list = (d.changes || []).map((c) => `Q${c.label} ${c.from} to ${c.to}`).join(', ');
      return `${prefix}Marks changed: ${list || 'no detail'}`;
    }
    case 'students_swapped':
      return 'Student swapped with another script';
    case 'approved':
      return 'Approved';
    case 'unapproved':
      return 'Unapproved';
    case 'regraded':
      return 'Marked again by the AI';
    case 'bulk_approved':
      return 'Approved together with other confident scripts';
    default:
      return ev.kind;
  }
}

// Only student and mark changes can be undone, only the most recent of each kind that has not been undone already,
// and an undo itself is not undone (just make the change again). Events are newest first.
export function undoableIds(events) {
  const undone = new Set(events.filter((e) => e.detail?.undo && e.detail?.of).map((e) => e.detail.of));
  const seen = new Set();
  const ids = new Set();
  events.forEach((ev) => {
    if (ev.detail?.undo || undone.has(ev.id)) return;
    if ((ev.kind === 'student_changed' || ev.kind === 'marks_changed') && !seen.has(ev.kind)) {
      seen.add(ev.kind);
      ids.add(ev.id);
    }
  });
  return ids;
}

// Records the same kind of event for many scripts at once (for example a bulk approval).
export async function logManyEvents(supabase, { examId, userId, paperIds, kind, detail = {} }) {
  try {
    for (let i = 0; i < paperIds.length; i += 100) {
      const rows = paperIds.slice(i, i + 100).map((paper_id) => ({ exam_id: examId, paper_id, user_id: userId, kind, detail }));
      const { error } = await supabase.from('exam_paper_events').insert(rows);
      if (error) return false;
    }
    return true;
  } catch {
    return false;
  }
}
