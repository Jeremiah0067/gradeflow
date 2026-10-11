// Builds report card data for each student from published grades only.
// Pure functions, no database or React, so they can be tested on their own.

import { submissionScore } from './insights';

export function buildReportCards({ students, assignments, submissions, criteria }) {
  const criterionById = Object.fromEntries((criteria || []).map((c) => [c.id, c]));
  const byKey = {};
  (submissions || []).forEach((s) => {
    byKey[`${s.student_id}:${s.assignment_id}`] = s;
  });

  const cards = students.map((st) => {
    const rows = [];
    assignments.forEach((a) => {
      const sub = byKey[`${st.id}:${a.id}`];
      if (!sub || sub.status !== 'published') return;
      const result = submissionScore(sub, a);
      if (!result || result.max <= 0) return;

      const feedback = (sub.rubric_scores || [])
        .map((rs) => {
          const c = criterionById[rs.criterion_id];
          return {
            label: c?.label || 'Feedback',
            order: c?.sort_order ?? 999,
            points: Number(rs.teacher_override_points ?? rs.ai_awarded_points ?? 0),
            max: c ? Number(c.max_points) : null,
            comment: rs.ai_reasoning || '',
          };
        })
        .sort((x, y) => x.order - y.order);

      rows.push({
        title: a.title,
        score: result.score,
        max: result.max,
        pct: (result.score / result.max) * 100,
        feedback,
      });
    });

    const totalScore = rows.reduce((sum, r) => sum + r.score, 0);
    const totalMax = rows.reduce((sum, r) => sum + r.max, 0);
    return {
      id: st.id,
      name: st.name || st.email || 'Unnamed student',
      rows,
      totalScore,
      totalMax,
      // Overall percentage is points earned over points possible, so bigger assignments count for more.
      overallPct: totalMax > 0 ? (totalScore / totalMax) * 100 : null,
    };
  });

  return cards.sort((a, b) => a.name.localeCompare(b.name));
}
