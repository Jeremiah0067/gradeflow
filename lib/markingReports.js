// Report data for the bulk-marking side. Pure functions: no database and no React,
// so the numbers can be tested on their own.
// Only APPROVED scripts count. A student is recognised across subjects by reg number
// (or by name when a script has no reg number).

export const WEAK_BELOW = 0.6;
export const STRONG_FROM = 0.8;

export function normalizeReg(reg) {
  return String(reg || '').replace(/\s+/g, '').toUpperCase();
}

function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function studentKey(regNo, name) {
  const reg = normalizeReg(regNo);
  if (reg) return `reg:${reg}`;
  const n = normalizeName(name);
  return n ? `name:${n}` : null;
}

function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}

// Standard competition ranking: equal scores share a position (1st, 2nd, 2nd, 4th).
export function rankPositions(items, getValue) {
  const sorted = [...items].sort((a, b) => getValue(b) - getValue(a));
  const position = new Map();
  sorted.forEach((item, i) => {
    const prev = sorted[i - 1];
    position.set(item, prev && getValue(prev) === getValue(item) ? position.get(prev) : i + 1);
  });
  return position;
}

// exams: [{id, title, subject, class_label, total_marks}]
// students: [{id, exam_id, reg_no, full_name}]  (exam_students rows)
// papers: [{id, exam_id, student_id, status, final_total, detected_name, detected_reg_no}]
// questions: [{id, exam_id, label, max_marks, position}]
// scores: [{paper_id, question_id, final_marks}]
// recommendations: [{paper_id, text}]
export function buildMarkingReports({ exams, students, papers, questions, scores, recommendations }) {
  const examById = Object.fromEntries(exams.map((e) => [e.id, e]));
  const studentById = Object.fromEntries(students.map((s) => [s.id, s]));
  const recByPaper = Object.fromEntries((recommendations || []).map((r) => [r.paper_id, r.text]));

  const questionsByExam = {};
  questions.forEach((q) => (questionsByExam[q.exam_id] ||= []).push(q));
  Object.values(questionsByExam).forEach((list) => list.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)));

  const scoresByPaper = {};
  scores.forEach((s) => (scoresByPaper[s.paper_id] ||= {})[s.question_id] = Number(s.final_marks) || 0);

  const people = new Map();
  let unmatched = 0;

  papers
    .filter((p) => p.status === 'approved' && examById[p.exam_id])
    .forEach((p) => {
      const exam = examById[p.exam_id];
      const st = p.student_id ? studentById[p.student_id] : null;
      const regNo = st?.reg_no || p.detected_reg_no || '';
      const name = st?.full_name || p.detected_name || '';
      const key = studentKey(regNo, name);
      if (!key) return; // cannot tell who this script belongs to
      if (!st) unmatched += 1;

      const qs = questionsByExam[exam.id] || [];
      const paperScores = scoresByPaper[p.id] || {};
      const questionTotal = qs.reduce((sum, q) => sum + (Number(q.max_marks) || 0), 0);
      const total = questionTotal > 0 ? questionTotal : Number(exam.total_marks) || 0;
      if (total <= 0) return;

      const score = Number(p.final_total) || 0;
      const perQuestion = qs
        .map((q) => {
          const max = Number(q.max_marks) || 0;
          const marks = paperScores[q.id];
          return marks === undefined || max <= 0 ? null : { label: q.label, marks, max, ratio: marks / max };
        })
        .filter(Boolean);

      const person = people.get(key) || { key, regNo, name, classLabel: exam.class_label || '', rows: [] };
      if (!person.name && name) person.name = name;
      if (!person.regNo && regNo) person.regNo = regNo;
      person.rows.push({
        paperId: p.id,
        examId: exam.id,
        subject: exam.subject || exam.title,
        title: exam.title,
        score,
        total,
        pct: (score / total) * 100,
        weak: perQuestion.filter((q) => q.ratio < WEAK_BELOW).sort((a, b) => a.ratio - b.ratio).slice(0, 4),
        strong: perQuestion.filter((q) => q.ratio >= STRONG_FROM).sort((a, b) => b.ratio - a.ratio).slice(0, 4),
        recommendation: recByPaper[p.id] || '',
      });
      people.set(key, person);
    });

  const list = [...people.values()].map((person) => {
    person.rows.sort((a, b) => a.subject.localeCompare(b.subject) || a.title.localeCompare(b.title));
    const totalScore = person.rows.reduce((sum, r) => sum + r.score, 0);
    const totalMax = person.rows.reduce((sum, r) => sum + r.total, 0);
    return { ...person, totalScore, totalMax, overallPct: totalMax > 0 ? (totalScore / totalMax) * 100 : null };
  });

  // Class average for each exam, and each student's overall position
  const examAvg = {};
  list.forEach((p) =>
    p.rows.forEach((r) => {
      (examAvg[r.examId] ||= []).push(r.pct);
    })
  );
  const avgOf = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const positions = rankPositions(list, (p) => p.overallPct ?? -1);

  list.forEach((p) => {
    p.position = positions.get(p);
    p.positionText = `${ordinal(p.position)} of ${list.length}`;
    p.rows.forEach((r) => {
      r.classAvgPct = examAvg[r.examId] ? avgOf(examAvg[r.examId]) : null;
    });
  });

  list.sort((a, b) => a.name.localeCompare(b.name));
  return { students: list, unmatched, classSize: list.length };
}

// Spreadsheet programs run text that starts with = + - @ as a formula. Defuse it.
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// One row per student per subject. The leading byte-order mark lets Excel read it correctly.
export function toCsv(students, { includeClassStats = true } = {}) {
  const head = ['Reg No', 'Name', 'Class', 'Subject', 'Exam', 'Score', 'Total', 'Percent'];
  if (includeClassStats) head.push('Class average (%)', 'Overall position');
  const lines = [head];
  students.forEach((s) =>
    s.rows.forEach((r) => {
      const line = [s.regNo, s.name, s.classLabel, r.subject, r.title, r.score, r.total, r.pct.toFixed(1)];
      if (includeClassStats) line.push(r.classAvgPct === null ? '' : r.classAvgPct.toFixed(1), s.positionText);
      lines.push(line);
    })
  );
  return '\uFEFF' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n');
}

export function pctText(value) {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${Math.round(value)}%`;
}
