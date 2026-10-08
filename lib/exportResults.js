// Builds the results CSV for a marking job. The table-building part is pure (no network),
// so it can be tested on its own.

const STATUS_TEXT = {
  needs_review: 'Awaiting review',
  flagged: 'Awaiting review',
  uploaded: 'Not graded yet',
  queued: 'Not graded yet',
  grading: 'Not graded yet',
  failed: 'Grading failed',
};

function round2(n) {
  return Math.round(n * 100) / 100;
}

// papers: [{ id, student_id, status, final_total, teacher_comment }]
// scores: [{ paper_id, question_id, final_marks }]
// options: { perQuestion, comments, includeMissing }
export function buildExportTable({ exam, questions, students, papers, scores, options }) {
  const opts = { perQuestion: true, comments: true, includeMissing: true, ...options };

  const paperByStudent = new Map();
  let unassignedScripts = 0;
  papers.forEach((p) => {
    if (p.student_id) paperByStudent.set(p.student_id, p);
    else unassignedScripts += 1;
  });

  const marksByPaper = new Map();
  scores.forEach((s) => {
    if (!marksByPaper.has(s.paper_id)) marksByPaper.set(s.paper_id, new Map());
    marksByPaper.get(s.paper_id).set(s.question_id, s.final_marks);
  });

  const totalMarks = Number(exam.total_marks) || 0;
  const header = [
    'Reg No',
    'Name',
    ...(opts.perQuestion ? questions.map((q) => `Q${q.label} (/${q.max_marks})`) : []),
    `Total (/${totalMarks})`,
    'Percent',
    ...(opts.comments ? ['Comment'] : []),
    'Status',
  ];

  const summary = {
    rosterSize: students.length,
    approved: 0,
    awaiting: 0,
    notGraded: 0,
    failed: 0,
    noScript: 0,
    unassignedScripts,
  };

  const rows = [];
  students.forEach((student) => {
    const paper = paperByStudent.get(student.id);
    const approved = paper?.status === 'approved';

    if (approved) summary.approved += 1;
    else if (!paper) summary.noScript += 1;
    else if (STATUS_TEXT[paper.status] === 'Awaiting review') summary.awaiting += 1;
    else if (STATUS_TEXT[paper.status] === 'Grading failed') summary.failed += 1;
    else summary.notGraded += 1;

    if (!approved && !opts.includeMissing) return;

    const qMarks = marksByPaper.get(paper?.id) || new Map();
    const total = approved ? round2(Number(paper.final_total) || 0) : '';
    const percent = approved && totalMarks > 0 ? Math.round((total / totalMarks) * 1000) / 10 : '';

    rows.push([
      student.reg_no,
      student.full_name,
      ...(opts.perQuestion
        ? questions.map((q) => (approved && qMarks.has(q.id) ? round2(Number(qMarks.get(q.id))) : ''))
        : []),
      total,
      percent,
      ...(opts.comments ? [approved ? paper.teacher_comment || '' : ''] : []),
      approved ? 'Approved' : paper ? STATUS_TEXT[paper.status] || paper.status : 'No script',
    ]);
  });

  return { header, rows, summary };
}

export function exportFileName(title, date = new Date()) {
  const slug =
    String(title || 'results')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'marking';
  return `${slug}-results-${date.toISOString().slice(0, 10)}.csv`;
}

// Starts a download in the browser.
// The leading BOM makes Excel read names with accents (for example Yoruba or Igbo letters) correctly.
export function downloadCsv(filename, csvText) {
  const blob = new Blob(['\uFEFF' + csvText], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
