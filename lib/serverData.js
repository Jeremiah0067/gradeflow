// Server-side data loading for report cards. Pass a service-role client.

// Reads a long list of ids a few at a time, and pages each read, because Supabase
// returns at most 1000 rows per request.
export async function fetchInPaged(db, table, select, column, ids, { size = 20, order = 'id', extra } = {}) {
  const rows = [];
  const PAGE = 1000;
  for (let i = 0; i < ids.length; i += size) {
    const chunk = ids.slice(i, i + size);
    for (let from = 0; ; from += PAGE) {
      let q = db.from(table).select(select).in(column, chunk).order(order);
      if (extra) q = extra(q);
      const { data, error } = await q.range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      rows.push(...data);
      if (data.length < PAGE) break;
    }
  }
  return rows;
}

// Everything buildMarkingReports needs, for the given exams. Only approved scripts are read.
export async function loadMarkingReportData(db, examIds) {
  const exams = await fetchInPaged(db, 'exams', 'id, title, subject, class_label, total_marks, paper_type', 'id', examIds);
  const students = await fetchInPaged(db, 'exam_students', 'id, exam_id, reg_no, full_name', 'exam_id', examIds);
  const questions = await fetchInPaged(db, 'exam_questions', 'id, exam_id, label, max_marks, position', 'exam_id', examIds);
  const papers = await fetchInPaged(
    db,
    'exam_papers',
    'id, exam_id, student_id, status, final_total, detected_name, detected_reg_no',
    'exam_id',
    examIds,
    { extra: (q) => q.eq('status', 'approved') }
  );
  const paperIds = papers.map((p) => p.id);
  const scores = await fetchInPaged(db, 'exam_scores', 'id, paper_id, question_id, final_marks', 'paper_id', paperIds, { size: 40 });
  const recommendations = await fetchInPaged(db, 'exam_paper_recommendations', 'paper_id, text', 'paper_id', paperIds, {
    size: 100,
    order: 'paper_id',
  });
  return { exams, students, questions, papers, scores, recommendations };
}
