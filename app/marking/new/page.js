'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '../../../lib/supabaseClient';
import { parseCsv, guessRosterColumns } from '../../../lib/csv';
import QuestionsEditor from '../../../components/marking/QuestionsEditor';
import { Dropzone, FileList as FileListView } from '../../../components/ui/FilePicker';
import { Icon } from '../../../components/icons';
import { blankQuestion, validateQuestions, totalMarks, questionToColumns } from '../../../lib/questionForm';


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
  const [questions, setQuestions] = useState(() => [blankQuestion(1)]);

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

  const total = totalMarks(questions);

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

  async function handleCsvFile(files) {
    const file = files?.[0];
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

    const questionProblem = validateQuestions(questions);
    if (questionProblem) return questionProblem;

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
          total_marks: total,
        })
        .select()
        .single();
      if (examErr) throw new Error(examErr.message);
      examId = exam.id;

      const { error: qErr } = await supabase
        .from('exam_questions')
        .insert(questions.map((q, i) => ({ ...questionToColumns(q), exam_id: examId, position: i + 1 })));
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
    <div className="page-narrow">
      <div className="breadcrumb">
        <Link href="/marking">Marking</Link> / New marking job
      </div>
      <div className="page-head">
        <div>
          <h1>New marking job</h1>
          <p className="subtitle">Set up the questions and the students. Next, you will photograph the scripts.</p>
        </div>
      </div>

      <form onSubmit={handleSave}>
        <div className="surface">
          <h2>Details</h2>

          <label htmlFor="job-title">Title</label>
          <input id="job-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Biomechanics mid-semester test" />

          <div className="form-grid-3">
            <div>
              <label htmlFor="job-subject">Subject</label>
              <input id="job-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Optional" />
            </div>
            <div>
              <label htmlFor="job-class">Class or level</label>
              <input id="job-class" value={classLabel} onChange={(e) => setClassLabel(e.target.value)} placeholder="Optional" />
            </div>
            <div>
              <label htmlFor="job-type">Type</label>
              <select id="job-type" value={paperType} onChange={(e) => setPaperType(e.target.value)}>
                <option value="test">Test</option>
                <option value="assignment">Assignment</option>
                <option value="exam">Exam</option>
              </select>
            </div>
          </div>

          <label htmlFor="job-extra">
            Extra marking instructions <span className="hint" style={{ display: 'inline' }}>(optional)</span>
          </label>
          <textarea
            id="job-extra"
            rows={3}
            value={extraInstructions}
            onChange={(e) => setExtraInstructions(e.target.value)}
            placeholder="e.g. Award method marks even if the final answer is wrong. Ignore spelling mistakes."
          />
        </div>

        <QuestionsEditor
          questions={questions}
          setQuestions={setQuestions}
          onMeta={({ title: t, subject: sub }) => {
            if (t && !title.trim()) setTitle(t);
            if (sub && !subject.trim()) setSubject(sub);
          }}
        />

        <div className="surface">
          <h2>Students who wrote this paper</h2>
          <p className="section-note">
            Upload a spreadsheet saved as CSV, with a header row. It needs one column for the reg number and one for the full name.
          </p>

          <Dropzone
            title={csvFileName ? 'Choose a different CSV' : 'Choose the student list (CSV)'}
            hint="From Excel or Google Sheets: File, Download, CSV"
            accept=".csv,text/csv"
            multiple={false}
            icon="file"
            onFiles={handleCsvFile}
          />
          {csvFileName && (
            <FileListView files={[{ name: csvFileName, size: 0 }]} onRemove={() => { setCsvRows([]); setCsvFileName(''); setRegCol(-1); setNameCol(-1); }} />
          )}

          {csvRows.length > 0 && (
            <>
              <p className="section-note num" style={{ marginTop: 'var(--s-3)' }}>{csvRows.length - 1} rows found. Check the two columns below.</p>

              <div className="form-grid-2">
                <div>
                  <label htmlFor="col-reg" style={{ marginTop: 0 }}>Reg number column</label>
                  <select id="col-reg" value={regCol} onChange={(e) => setRegCol(Number(e.target.value))}>
                    <option value={-1}>Choose a column...</option>
                    {headers.map((h, i) => (
                      <option key={i} value={i}>{h || `Column ${i + 1}`}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="col-name" style={{ marginTop: 0 }}>Student name column</label>
                  <select id="col-name" value={nameCol} onChange={(e) => setNameCol(Number(e.target.value))}>
                    <option value={-1}>Choose a column...</option>
                    {headers.map((h, i) => (
                      <option key={i} value={i}>{h || `Column ${i + 1}`}</option>
                    ))}
                  </select>
                </div>
              </div>

              {roster.students.length > 0 && (
                <div style={{ marginTop: 'var(--s-4)' }}>
                  <p className="alert alert-ok" role="status" style={{ marginBottom: 'var(--s-3)' }}>
                    <span>
                      <strong className="num">{roster.students.length}</strong> students ready
                      {roster.skipped > 0 && `. ${roster.skipped} rows were skipped because they were blank or repeated a reg number.`}
                    </span>
                  </p>
                  <div className="rows">
                    {roster.students.slice(0, 5).map((st) => (
                      <div key={st.reg_no} className="row" style={{ padding: 'var(--s-2) var(--s-4)' }}>
                        <span className="num" style={{ width: 150, color: 'var(--ink-2)' }}>{st.reg_no}</span>
                        <span>{st.full_name}</span>
                      </div>
                    ))}
                    {roster.students.length > 5 && (
                      <div className="row" style={{ padding: 'var(--s-2) var(--s-4)', color: 'var(--ink-2)' }}>
                        and {roster.students.length - 5} more
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {error && <p className="alert alert-error" role="alert">{error}</p>}

        <div style={{ display: 'flex', gap: 'var(--s-3)', flexWrap: 'wrap' }}>
          <button type="submit" className="btn-lg" style={{ marginTop: 0 }} disabled={saving}>
            {saving ? 'Saving...' : 'Create marking job'}
          </button>
          <button type="button" className="btn-secondary btn-lg" onClick={() => router.push('/marking')}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
