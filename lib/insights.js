// Pure calculations for the class insights page. No database or React in here,
// so the numbers can be tested on their own.

export const BANDS = [
  { id: 'b0', label: 'Below 40%', min: 0, max: 40, tone: 'low' },
  { id: 'b1', label: '40–49%', min: 40, max: 50, tone: 'low' },
  { id: 'b2', label: '50–59%', min: 50, max: 60, tone: 'mid' },
  { id: 'b3', label: '60–69%', min: 60, max: 70, tone: 'mid' },
  { id: 'b4', label: '70% and above', min: 70, max: 101, tone: 'high' },
];

export function toneFor(pct) {
  if (pct >= 70) return 'high';
  if (pct >= 50) return 'mid';
  return 'low';
}

// Score for one submission. Written assignments sum their rubric scores
// (teacher override wins over the AI score). Quizzes use the stored quiz result.
export function submissionScore(submission, assignment) {
  const scores = submission?.rubric_scores || [];
  if (scores.length > 0) {
    const score = scores.reduce(
      (sum, s) => sum + Number(s.teacher_override_points ?? s.ai_awarded_points ?? 0),
      0
    );
    return { score, max: Number(assignment.max_points) || 0 };
  }
  const raw = submission?.raw_content;
  if (raw && typeof raw.score === 'number') {
    return { score: raw.score, max: Number(raw.total) || Number(assignment.max_points) || 0 };
  }
  return null;
}

const PENDING = ['needs_teacher_approval', 'pending_ai_review', 'flagged', 'needs_revision'];

export function computeInsights({ students, assignments, submissions, criteria }) {
  const byKey = {};
  (submissions || []).forEach((s) => {
    byKey[`${s.student_id}:${s.assignment_id}`] = s;
  });
  const assignmentById = Object.fromEntries(assignments.map((a) => [a.id, a]));

  const graded = []; // one entry per published, scored submission
  let pendingCount = 0;
  (submissions || []).forEach((s) => {
    const a = assignmentById[s.assignment_id];
    if (!a) return;
    if (PENDING.includes(s.status)) pendingCount += 1;
    if (s.status !== 'published') return;
    const result = submissionScore(s, a);
    if (!result || result.max <= 0) return;
    graded.push({
      studentId: s.student_id,
      assignmentId: s.assignment_id,
      score: result.score,
      max: result.max,
      pct: (result.score / result.max) * 100,
      submission: s,
    });
  });

  const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);

  // Per assignment
  const perAssignment = assignments.map((a) => {
    const rows = graded.filter((g) => g.assignmentId === a.id);
    const submitted = (submissions || []).filter((s) => s.assignment_id === a.id).length;
    return {
      id: a.id,
      title: a.title,
      avgPct: mean(rows.map((r) => r.pct)),
      gradedCount: rows.length,
      submittedCount: submitted,
      missingCount: Math.max(students.length - submitted, 0),
    };
  });

  // Per student
  const perStudent = students.map((st) => {
    const rows = graded.filter((g) => g.studentId === st.id);
    return {
      id: st.id,
      name: st.name || st.email || 'Unnamed student',
      avgPct: mean(rows.map((r) => r.pct)),
      gradedCount: rows.length,
      missingCount: assignments.filter((a) => !byKey[`${st.id}:${a.id}`]).length,
    };
  });
  const scored = perStudent.filter((s) => s.avgPct !== null);

  // Distribution of student averages
  const distribution = BANDS.map((b) => ({
    ...b,
    count: scored.filter((s) => s.avgPct >= b.min && s.avgPct < b.max).length,
  }));

  // Needs attention: low average, or has not handed in at least half the work
  const needsAttention = perStudent
    .map((s) => {
      const reasons = [];
      if (s.avgPct !== null && s.avgPct < 50) reasons.push(`Average ${Math.round(s.avgPct)}%`);
      if (assignments.length >= 2 && s.missingCount * 2 >= assignments.length) {
        reasons.push(`${s.missingCount} of ${assignments.length} not handed in`);
      }
      return { ...s, reasons };
    })
    .filter((s) => s.reasons.length > 0)
    .sort((a, b) => (a.avgPct ?? 101) - (b.avgPct ?? 101));

  const topStudents = [...scored].sort((a, b) => b.avgPct - a.avgPct).slice(0, 3);

  // Weakest rubric criteria across the class (the "where did they lose marks" view)
  const criterionStats = {};
  (criteria || []).forEach((c) => {
    criterionStats[c.id] = { label: c.label, max: Number(c.max_points) || 0, assignmentId: c.assignment_id, points: 0, n: 0 };
  });
  graded.forEach((g) => {
    (g.submission.rubric_scores || []).forEach((rs) => {
      const stat = criterionStats[rs.criterion_id];
      if (!stat || stat.max <= 0) return;
      stat.points += Number(rs.teacher_override_points ?? rs.ai_awarded_points ?? 0);
      stat.n += 1;
    });
  });
  const weakestCriteria = Object.values(criterionStats)
    .filter((c) => c.n > 0)
    .map((c) => ({
      label: c.label,
      assignmentTitle: assignmentById[c.assignmentId]?.title || '',
      avgPct: (c.points / (c.max * c.n)) * 100,
      n: c.n,
    }))
    .sort((a, b) => a.avgPct - b.avgPct)
    .slice(0, 5);

  const expected = students.length * assignments.length;
  const handedIn = (submissions || []).filter((s) => assignmentById[s.assignment_id]).length;

  const assignmentsWithAvg = perAssignment.filter((a) => a.avgPct !== null);
  const sortedAssignments = [...assignmentsWithAvg].sort((a, b) => b.avgPct - a.avgPct);

  return {
    classAvg: mean(graded.map((g) => g.pct)),
    gradedCount: graded.length,
    pendingCount,
    completionPct: expected > 0 ? (handedIn / expected) * 100 : null,
    perAssignment,
    perStudent,
    distribution,
    needsAttention,
    topStudents,
    weakestCriteria,
    bestAssignment: sortedAssignments[0] || null,
    hardestAssignment: sortedAssignments.length > 1 ? sortedAssignments[sortedAssignments.length - 1] : null,
  };
}
