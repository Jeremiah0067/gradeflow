'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '../../../lib/supabaseClient';
import { parseCsv, guessRosterColumns } from '../../../lib/csv';

let questionCounter = 0;
function newQuestion(position) {
  questionCounter += 1;
  return {
    key: `q-${questionCounter}`,
    label: String(position),
    question_text: '',
    max_marks: '',
    question_type: 'written',
    marking_guide: '',
    answer_key: '',
  };
}

const smallBtn = { width: 'auto', margin: 0, padding: '6px 14px', fontSize: 13 };

export default function NewMarkingJobPage() {
  const router = useRouter();
  const [userId, setUserId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [classLabel, setClassLabel] = useState('');
  const [paperType, setPaperType] = useState('exam');
  const [extraInstructions, setExtraInstructions] = useState('');
  const [questions, setQuestions] = useState(() => [newQuestion(1)]);

  const [csvRows, setCsvRows] = useState([]);
  const [csvFileName, setCsvFileName] = useState('');
  const [regCol, setRegCol] = useState(-1);
  const [nameCol, setNameCol] = useState(-1);

  useEffect(() => {
    (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const session = sessionData?.session;
      if (!session) {
        router.push('/login');
        return;
      }
      const { data: profile } = await supabase.from('users').select('role').eq('id', session.user.id).maybeSingle();
      if (!profile) {
        router.push('/select-role');
        return;
      }
      if (profile.role !== 'teacher') {
        router.push('/dashboard');
        return;
      }
      setUserId(session.user.id);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalMarks = useMemo(
    () => questions.reduce((sum, q) => sum + (Number(q.max_marks) > 0 ? Number(q.max_marks) : 0), 0),
    [questions]
  );

  // The roster the teacher will actually get, after skipping blanks and duplicate reg numbers
  const roster = useMemo(() => {
    if (csvRows.length < 2 || regCol < 0 || nameCol < 0 || regCol === nameCol) {
      return { students: [], skipped: 0 };
    }
    const seen = new Set();
    const students = [];
    let skipped = 0;
    csvRows.slice(1).forEach((row) => {
      const reg = (row[regCol] || '').trim();
      const name = (row[nameCol] || '').trim();
      const dedupeKey = reg.toLowerCase();
      if (!reg || !name || seen.has(dedupeKey)) {
        skipped += 1;
        return;
      }
      seen.add(dedupeKey);
      students.push({ reg_no: reg, full_name: name });
    });
    return { students, skipped };
  }, [csvRows, regCol, nameCol]);

  function updateQuestion(key, field, value) {
    setQuestions((prev) => prev.map((q) => (q.key === key ? { ...q, [field]: value } : q)));
  }

  function addQuestion() {
    setQuestions((prev) => [...prev, newQuestion(prev.length + 1)]);
  }

  function removeQuestion(key) {
    setQuestions((prev) => (prev.length === 1 ? prev : prev.filter((q) => q.key !== key)));
  }

  async function handleCsvFile(e) {
    const file = e.target.files?.[0];
    setError('');
    if (!file) return;

    const text = await file.text();
    const rows = parseCsv(text);

    if (rows.length < 2) {
      setError('That CSV looks empty. It needs a header row and at least one student.');
      setCsvRows([]);
      setCsvFileName('');
      return;
    }

    const guess = guessRosterColumns(rows[0]);
    setCsvRows(rows);
    setCsvFileName(file.name);
    setRegCol(guess.reg);
    setNameCol(guess.name);
  }

  function validate() {
    if (!title.trim()) return 'Give this marking job a title.';

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

    const labels = questions.map((q) => q.label.trim().toLowerCase());
    if (new Set(labels).size !== labels.length) return 'Two questions have the same label. Labels must be different.';

    if (csvRows.length === 0) return 'Upload the CSV of students who wrote this paper.';
    if (regCol < 0 || nameCol < 0) return 'Choose which CSV columns hold the reg number and the student name.';
    if (regCol === nameCol) return 'The reg number and name must come from different columns.';
    if (roster.students.length === 0) return 'No valid students were found in that CSV with these columns.';

    return '';
  }

  async function handleSave(e) {
    e.preventDefault();
    setError('');

    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }

    setSaving(true);
    let examId = null;

    try {
      const { data: exam, error: examErr } = await supabase
        .from('exams')
        .insert({
          teacher_id: userId,
          title: title.trim(),
          subject: subject.trim() || null,
          class_label: classLabel.trim() || null,
          paper_type: paperType,
          extra_instructions: extraInstructions.trim() || null,
          total_marks: totalMarks,
        })
        .select()
        .single();
      if (examErr) throw new Error(examErr.message);
      examId = exam.id;

      const { error: qErr } = await supabase.from('exam_questions').insert(
        questions.map((q, i) => ({
          exam_id: examId,
          position: i + 1,
          label: q.label.trim(),
          question_text: q.question_text.trim(),
          max_marks: Number(q.max_marks),
          question_type: q.question_type,
          marking_guide: q.marking_guide.trim() || null,
          answer_key: q.question_type === 'objective' ? q.answer_key.trim() : null,
        }))
      );
      if (qErr) throw new Error(qErr.message);

      // Insert the roster in chunks so a big class doesn't hit a request size limit
      const CHUNK = 500;
      for (let i = 0; i < roster.students.length; i += CHUNK) {
        const chunk = roster.students.slice(i, i + CHUNK).map((s) => ({ ...s, exam_id: examId }));
        const { error: sErr } = await supabase.from('exam_students').insert(chunk);
        if (sErr) throw new Error(sErr.message);
      }

      router.push('/marking');
    } catch (err) {
      // Don't leave a half-created exam behind (child rows are removed automatically)
      if (examId) await supabase.from('exams').delete().eq('id', examId);
      setError(`Could not save: ${err.message}`);
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="page-wide">
        <p>Loading...</p>
      </div>
    );
  }

  const headers = csvRows[0] || [];

  return (
    <div className="page-wide" style={{ maxWidth: 820 }}>
      <div className="breadcrumb">
        <Link href="/dashboard">Dashboard</Link> / <Link href="/marking">Marking</Link> / New
      </div>
      <h1>New marking job</h1>
      <p className="subtitle">Set up the questions and the students. In the next step you will photograph the papers.</p>

      <form onSubmit={handleSave}>
        <div className="surface">
          <p className="section-heading">1. Details</p>

          <label>Title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Biomechanics mid-semester test" />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <div>
              <label>Subject</label>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Optional" />
            </div>
            <div>
              <label>Class / level</label>
              <input value={classLabel} onChange={(e) => setClassLabel(e.target.value)} placeholder="Optional" />
            </div>
            <div>
              <label>Type</label>
              <select value={paperType} onChange={(e) => setPaperType(e.target.value)}>
                <option value="test">Test</option>
                <option value="assignment">Assignment</option>
                <option value="exam">Exam</option>
              </select>
            </div>
          </div>

          <label>Extra marking instructions (optional)</label>
          <textarea
            rows={3}
            value={extraInstructions}
            onChange={(e) => setExtraInstructions(e.target.value)}
            placeholder="e.g. Award method marks even if the final answer is wrong. Ignore spelling mistakes."
          />
        </div>

        <div className="surface">
          <p className="section-heading">2. Questions and marking scheme</p>

          {questions.map((q, i) => (
            <div
              key={q.key}
              style={{ border: '1px solid var(--gf-border)', borderRadius: 8, padding: 14, marginBottom: 12 }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: '90px 110px 1fr auto', gap: 12, alignItems: 'end' }}>
                <div>
                  <label style={{ marginTop: 0 }}>Label</label>
                  <input value={q.label} onChange={(e) => updateQuestion(q.key, 'label', e.target.value)} />
                </div>
                <div>
                  <label style={{ marginTop: 0 }}>Marks</label>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value={q.max_marks}
                    onChange={(e) => updateQuestion(q.key, 'max_marks', e.target.value)}
                  />
                </div>
                <div>
                  <label style={{ marginTop: 0 }}>Type</label>
                  <select value={q.question_type} onChange={(e) => updateQuestion(q.key, 'question_type', e.target.value)}>
                    <option value="written">Written (AI marks it)</option>
                    <option value="objective">Objective (fixed answer)</option>
                  </select>
                </div>
                <button
                  type="button"
                  className="btn-danger"
                  style={smallBtn}
                  disabled={questions.length === 1}
                  onClick={() => removeQuestion(q.key)}
                >
                  Remove
                </button>
              </div>

              <label>Question {i + 1} text</label>
              <textarea
                rows={2}
                value={q.question_text}
                onChange={(e) => updateQuestion(q.key, 'question_text', e.target.value)}
                placeholder="Type the question as it appears on the paper"
              />

              {q.question_type === 'objective' ? (
                <>
                  <label>Correct answer</label>
                  <input
                    value={q.answer_key}
                    onChange={(e) => updateQuestion(q.key, 'answer_key', e.target.value)}
                    placeholder="e.g. B, or 42"
                  />
                </>
              ) : (
                <>
                  <label>What a full-marks answer should contain (optional but recommended)</label>
                  <textarea
                    rows={2}
                    value={q.marking_guide}
                    onChange={(e) => updateQuestion(q.key, 'marking_guide', e.target.value)}
                    placeholder="Key points, steps, or the expected answer. e.g. 1 mark for the formula, 2 marks for the working, 1 mark for the final answer."
                  />
                </>
              )}
            </div>
          ))}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <button type="button" className="btn-secondary" style={smallBtn} onClick={addQuestion}>
              + Add question
            </button>
            <p className="assignment-row-meta" style={{ margin: 0 }}>
              Total: <strong>{totalMarks}</strong> marks
            </p>
          </div>
        </div>

        <div className="surface">
          <p className="section-heading">3. Students who wrote this paper</p>
          <p className="subtitle" style={{ marginBottom: 8 }}>
            Upload a CSV with a header row. It needs one column for the reg number and one for the full name.
          </p>

          <input type="file" accept=".csv,text/csv" onChange={handleCsvFile} />

          {csvRows.length > 0 && (
            <>
              <p className="assignment-row-meta" style={{ marginTop: 10 }}>
                {csvFileName}: {csvRows.length - 1} rows found
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label>Reg number column</label>
                  <select value={regCol} onChange={(e) => setRegCol(Number(e.target.value))}>
                    <option value={-1}>Choose a column...</option>
                    {headers.map((h, i) => (
                      <option key={i} value={i}>
                        {h || `Column ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label>Student name column</label>
                  <select value={nameCol} onChange={(e) => setNameCol(Number(e.target.value))}>
                    <option value={-1}>Choose a column...</option>
                    {headers.map((h, i) => (
                      <option key={i} value={i}>
                        {h || `Column ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {roster.students.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <p className="assignment-row-meta">
                    <strong>{roster.students.length}</strong> students ready
                    {roster.skipped > 0 && ` · ${roster.skipped} rows skipped (blank or duplicate reg number)`}
                  </p>
                  <div style={{ border: '1px solid var(--gf-border)', borderRadius: 8, marginTop: 8 }}>
                    {roster.students.slice(0, 5).map((s) => (
                      <div
                        key={s.reg_no}
                        style={{ display: 'flex', gap: 16, padding: '8px 12px', fontSize: 13, borderBottom: '1px solid var(--gf-border)' }}
                      >
                        <span style={{ width: 150, color: 'var(--gf-text-secondary)' }}>{s.reg_no}</span>
                        <span>{s.full_name}</span>
                      </div>
                    ))}
                    {roster.students.length > 5 && (
                      <div style={{ padding: '8px 12px', fontSize: 13, color: 'var(--gf-text-secondary)' }}>
                        ...and {roster.students.length - 5} more
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {error && <p className="error-text">{error}</p>}

        <div style={{ display: 'flex', gap: 12 }}>
          <button type="button" className="btn-secondary" style={{ width: 'auto' }} onClick={() => router.push('/marking')}>
            Cancel
          </button>
          <button type="submit" style={{ width: 'auto' }} disabled={saving}>
            {saving ? 'Saving...' : 'Create marking job'}
          </button>
        </div>
      </form>
    </div>
  );
}
