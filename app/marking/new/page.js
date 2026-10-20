'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '../../../lib/supabaseClient';
import { parseCsv, guessRosterColumns, looksLikeHeader } from '../../../lib/csv';
import { buildRoster, distinctValues, parseNamesText } from '../../../lib/roster';
import { displayReg } from '../../../lib/studentIds';
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
  const [surnameCol, setSurnameCol] = useState(-1);
  const [classCol, setClassCol] = useState(-1);
  const [classFilter, setClassFilter] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [rosterNote, setRosterNote] = useState('');
  const [rawRows, setRawRows] = useState([]);
  const [firstRowHeader, setFirstRowHeader] = useState(true);

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

  // The students the teacher will actually get. Only the name is needed: a reg or admission number
  // and a class are optional. Students without a reg number are matched by name.
  const classes = useMemo(() => distinctValues(csvRows, classCol), [csvRows, classCol]);
  const roster = useMemo(() => {
    const cols = [nameCol, surnameCol, regCol, classCol].filter((c) => c >= 0);
    if (nameCol < 0 || new Set(cols).size !== cols.length) {
      return { students: [], skipped: 0, duplicates: [], blank: 0, filteredOut: 0, withoutReg: 0 };
    }
    return buildRoster(csvRows, { nameCol, surnameCol, regCol, classCol, classFilter });
  }, [csvRows, nameCol, surnameCol, regCol, classCol, classFilter]);

  function resetRoster() {
    setCsvRows([]);
    setCsvFileName('');
    setRegCol(-1);
    setNameCol(-1);
    setSurnameCol(-1);
    setClassCol(-1);
    setClassFilter('');
    setRosterNote('');
    setRawRows([]);
    setFirstRowHeader(true);
  }

  // Start with the class this job is for, if the list has that class
  function defaultClassFilter(rows, col) {
    const match = distinctValues(rows, col).find((c) => c.toLowerCase() === classLabel.trim().toLowerCase());
    return match || '';
  }

  function usePastedNames() {
    setError('');
    const parsed = parseNamesText(pasteText);
    if (parsed.rows.length < 2) {
      setError('Type at least one student name first.');
      return;
    }
    setRawRows(parsed.rows);
    setFirstRowHeader(true);
    setCsvRows(parsed.rows);
    setCsvFileName('Typed list');
    setNameCol(parsed.nameCol);
    setRegCol(parsed.regCol);
    setSurnameCol(-1);
    setClassCol(-1);
    setClassFilter('');
    setRosterNote('');
  }

  // Builds the table from the file's rows. When the first row is a student (no column titles), a title row is added.
  function loadRows(raw, isHeader) {
    let rows = raw;
    let note = '';
    if (!isHeader) {
      const width = Math.max(1, ...raw.map((r) => r.length));
      rows = [['Name', ...Array.from({ length: width - 1 }, (_, i) => `Column ${i + 2}`)], ...raw];
      note = 'The first row is counted as a student.';
    }
    if (rows.length < 2) {
      setError('That file has column titles but no students under them.');
      return false;
    }
    const guess = guessRosterColumns(rows[0]);
    setCsvRows(rows);
    setRegCol(guess.reg);
    setNameCol(guess.name);
    setSurnameCol(guess.surname);
    setClassCol(guess.cls);
    setClassFilter(guess.cls >= 0 ? defaultClassFilter(rows, guess.cls) : '');
    setRosterNote(note);
    return true;
  }

  async function handleCsvFile(files) {
    const file = files?.[0];
    setError('');
    if (!file) return;

    const rows = parseCsv(await file.text());
    if (rows.length === 0) {
      setError('That file looks empty. It needs at least one student name.');
      resetRoster();
      return;
    }

    // A list with no title row (just names) is fine. We guess, and the teacher can correct the guess.
    const isHeader = looksLikeHeader(rows[0]);
    setRawRows(rows);
    setFirstRowHeader(isHeader);
    if (loadRows(rows, isHeader)) setCsvFileName(file.name);
    else resetRoster();
  }

  function validate() {
    if (!title.trim()) return 'Give this marking job a title.';

    const questionProblem = validateQuestions(questions);
    if (questionProblem) return questionProblem;

    if (csvRows.length === 0) return 'Add the students who wrote this paper: upload a list, or type their names.';
    if (nameCol < 0) return 'Choose which column holds the student name.';
    const chosen = [nameCol, surnameCol, regCol, classCol].filter((c) => c >= 0);
    if (new Set(chosen).size !== chosen.length) return 'Each column can only be used once. Check the column choices.';
    if (roster.students.length === 0) return 'No students were found with these columns. Check the column choices and the class.';

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
            Upload a list as a CSV file, or type the names below. A name is all that is needed. A class, or a reg or admission number if the students have one, is optional.
          </p>

          <Dropzone
            title={csvFileName ? 'Choose a different CSV' : 'Choose the student list (CSV)'}
            hint="From Excel or Google Sheets: File, Download, CSV. A header row is optional."
            accept=".csv,text/csv"
            multiple={false}
            icon="file"
            onFiles={handleCsvFile}
          />
          {csvFileName && (
            <FileListView files={[{ name: csvFileName, size: 0 }]} onRemove={resetRoster} />
          )}

          {!csvFileName && (
            <details style={{ marginTop: 'var(--s-4)' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>No spreadsheet? Type or paste the names instead</summary>
              <p className="section-note" style={{ margin: 'var(--s-2) 0' }}>
                One student per line. If a student has a reg or admission number, add it after a comma, like <span className="num">Ada Obi, JSS/2024/001</span>.
              </p>
              <textarea
                rows={6}
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder={'Ada Obi\nBayo Lawal\nChinedu Okafor'}
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
              <button type="button" className="btn-secondary" style={{ width: 'auto' }} disabled={!pasteText.trim()} onClick={usePastedNames}>
                Use these names
              </button>
            </details>
          )}

          {csvRows.length > 0 && (
            <>
              <p className="section-note num" style={{ marginTop: 'var(--s-3)' }}>
                {csvRows.length - 1} rows found. Check the columns below. Only the name is required.
              </p>
              {rosterNote && <p className="section-note">{rosterNote}</p>}
              {csvFileName !== 'Typed list' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 'var(--s-2) 0', fontWeight: 400 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={firstRowHeader}
                    onChange={(e) => {
                      setFirstRowHeader(e.target.checked);
                      loadRows(rawRows, e.target.checked);
                    }}
                  />
                  The first row is column titles, not a student
                </label>
              )}

              <div className="form-grid-2">
                <div>
                  <label htmlFor="col-name" style={{ marginTop: 0 }}>Student name column (or first name)</label>
                  <select id="col-name" value={nameCol} onChange={(e) => setNameCol(Number(e.target.value))}>
                    <option value={-1}>Choose a column...</option>
                    {headers.map((h, i) => (
                      <option key={i} value={i}>{h || `Column ${i + 1}`}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="col-surname" style={{ marginTop: 0 }}>Surname column (only if separate)</label>
                  <select id="col-surname" value={surnameCol} onChange={(e) => setSurnameCol(Number(e.target.value))}>
                    <option value={-1}>None</option>
                    {headers.map((h, i) => (
                      <option key={i} value={i}>{h || `Column ${i + 1}`}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="col-reg" style={{ marginTop: 0 }}>Reg or admission number column</label>
                  <select id="col-reg" value={regCol} onChange={(e) => setRegCol(Number(e.target.value))}>
                    <option value={-1}>None (match scripts by name)</option>
                    {headers.map((h, i) => (
                      <option key={i} value={i}>{h || `Column ${i + 1}`}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="col-class" style={{ marginTop: 0 }}>Class column</label>
                  <select
                    id="col-class"
                    value={classCol}
                    onChange={(e) => {
                      const col = Number(e.target.value);
                      setClassCol(col);
                      setClassFilter(col >= 0 ? defaultClassFilter(csvRows, col) : '');
                    }}
                  >
                    <option value={-1}>None</option>
                    {headers.map((h, i) => (
                      <option key={i} value={i}>{h || `Column ${i + 1}`}</option>
                    ))}
                  </select>
                </div>
              </div>

              {classCol >= 0 && classes.length > 1 && (
                <div style={{ marginTop: 'var(--s-3)', maxWidth: 360 }}>
                  <label htmlFor="class-filter">Only include students in this class</label>
                  <select id="class-filter" value={classFilter} onChange={(e) => setClassFilter(e.target.value)}>
                    <option value="">All classes in the list</option>
                    {classes.map((c) => (
                      <option key={c} value={c}>
                        {c} ({csvRows.slice(1).filter((r) => String(r[classCol] || '').trim().toLowerCase() === c.toLowerCase()).length})
                      </option>
                    ))}
                  </select>
                  <p className="hint">This list has more than one class. Choose the class that wrote this paper.</p>
                </div>
              )}

              {roster.students.length > 0 && (
                <div style={{ marginTop: 'var(--s-4)' }}>
                  <p className="alert alert-ok" role="status" style={{ marginBottom: 'var(--s-3)' }}>
                    <span>
                      <strong className="num">{roster.students.length}</strong> {roster.students.length === 1 ? 'student' : 'students'} ready
                      {roster.skipped > 0 && `. ${roster.skipped} ${roster.skipped === 1 ? 'row was' : 'rows were'} skipped because ${roster.skipped === 1 ? 'it was' : 'they were'} blank or the same student twice.`}
                      {roster.filteredOut > 0 && ` ${roster.filteredOut} in other classes ${roster.filteredOut === 1 ? 'was' : 'were'} left out.`}
                    </span>
                  </p>
                  {roster.duplicates.length > 0 && (
                    <p className="section-note">
                      Repeated: {roster.duplicates.slice(0, 5).join(', ')}{roster.duplicates.length > 5 ? ` and ${roster.duplicates.length - 5} more` : ''}.
                      If two different students share a name, add their admission numbers to tell them apart.
                    </p>
                  )}
                  {roster.withoutReg > 0 && (
                    <p className="section-note">
                      {roster.withoutReg === roster.students.length
                        ? 'None of these students has a reg or admission number.'
                        : `${roster.withoutReg} ${roster.withoutReg === 1 ? 'student has' : 'students have'} no reg or admission number.`}{' '}
                      That is fine: each script is matched to a student by the name written on it, so ask students to write their full name clearly at the top of the first page.
                    </p>
                  )}
                  <div className="rows">
                    {roster.students.slice(0, 5).map((st) => (
                      <div key={st.reg_no} className="row" style={{ padding: 'var(--s-2) var(--s-4)' }}>
                        <span className="num" style={{ width: 150, color: 'var(--ink-2)' }}>{displayReg(st.reg_no) || '—'}</span>
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
