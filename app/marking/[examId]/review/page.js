'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '../../../../lib/supabaseClient';
import {
  sortForReview,
  isBulkEligible,
  checkMarks,
  LOW_CONFIDENCE,
  BULK_MIN_MEAN,
} from '../../../../lib/reviewHelpers';
import { toCsv } from '../../../../lib/csv';
import { buildExportTable, downloadCsv, exportFileName } from '../../../../lib/exportResults';

const BUCKET = 'exam-papers';
const GRADED = ['needs_review', 'flagged', 'approved'];
const smallBtn = { width: 'auto', margin: 0, padding: '6px 14px', fontSize: 13 };

const STATUS_LABEL = { needs_review: 'To review', flagged: 'Check carefully', approved: 'Approved' };

const CSS = `
.rv-layout { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 16px; align-items: start; }
.rv-list { max-height: 78vh; overflow-y: auto; }
.rv-detail { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); gap: 16px; align-items: start; }
.rv-pages { position: sticky; top: 12px; max-height: 88vh; overflow-y: auto; }
.rv-pages img { width: 100%; display: block; border: 1px solid var(--gf-border); border-radius: 6px; margin-bottom: 8px; cursor: zoom-in; }
.rv-item { padding: 10px 12px; border-bottom: 1px solid var(--gf-border); cursor: pointer; border-left: 3px solid transparent; }
.rv-item:hover { background: var(--gf-bg); }
.rv-item.selected { background: #e8f0fe; border-left-color: var(--gf-blue); }
@media (max-width: 960px) {
  .rv-layout, .rv-detail { grid-template-columns: minmax(0, 1fr); }
  .rv-list { max-height: 260px; }
  .rv-pages { position: static; max-height: none; }
}
`;

async function fetchPaged(makeQuery) {
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await makeQuery().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all;
}

async function callGradeApi(paperId, force) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  const res = await fetch('/api/marking/grade-paper', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ paperId, force }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

function ConfidenceBadge({ value }) {
  const pct = Math.round(Number(value ?? 0) * 100);
  const low = Number(value ?? 0) < LOW_CONFIDENCE;
  return (
    <span
      style={{
        fontSize: 12,
        padding: '2px 8px',
        borderRadius: 10,
        background: low ? 'var(--gf-warning-bg)' : 'var(--gf-success-bg)',
        color: low ? 'var(--gf-warning-text)' : 'var(--gf-success-text)',
        whiteSpace: 'nowrap',
      }}
    >
      {pct}% sure
    </span>
  );
}

export default function ReviewPage() {
  const router = useRouter();
  const { examId } = useParams();

  const [exam, setExam] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [students, setStudents] = useState([]);
  const [papers, setPapers] = useState([]);
  const [scoresByPaper, setScoresByPaper] = useState({});

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const [tab, setTab] = useState('todo'); // todo | approved | all
  const [selectedId, setSelectedId] = useState(null);
  const [pageUrls, setPageUrls] = useState([]);

  // What the teacher is editing right now
  const [draftMarks, setDraftMarks] = useState({});
  const [draftComment, setDraftComment] = useState('');
  const [draftStudentId, setDraftStudentId] = useState('');

  // Export panel
  const [exportOpen, setExportOpen] = useState(false);
  const [exportData, setExportData] = useState(null); // { papers, scores } fetched fresh when opened
  const [exportBusy, setExportBusy] = useState(false);
  const [exportOpts, setExportOpts] = useState({ perQuestion: true, comments: true, includeMissing: true });

  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId]);

  async function load(showSpinner) {
    if (showSpinner) setLoading(true);

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

    try {
      const { data: examRow, error: examErr } = await supabase.from('exams').select('*').eq('id', examId).maybeSingle();
      if (examErr) throw new Error(examErr.message);
      if (!examRow) {
        setError('This marking job was not found.');
        setLoading(false);
        return;
      }
      setExam(examRow);

      const { data: questionRows } = await supabase.from('exam_questions').select('*').eq('exam_id', examId).order('position');
      setQuestions(questionRows || []);

      setStudents(
        await fetchPaged(() => supabase.from('exam_students').select('*').eq('exam_id', examId).order('full_name').order('id'))
      );

      const paperRows = await fetchPaged(() =>
        supabase
          .from('exam_papers')
          .select('*, exam_paper_pages(id, page_no, storage_path)')
          .eq('exam_id', examId)
          .in('status', GRADED)
          .order('created_at')
          .order('id')
      );
      setPapers(
        paperRows.map((p) => ({
          ...p,
          exam_paper_pages: [...(p.exam_paper_pages || [])].sort((a, b) => a.page_no - b.page_no),
        }))
      );

      // All scores for the exam, so switching between scripts is instant
      const grouped = {};
      const ids = paperRows.map((p) => p.id);
      for (let i = 0; i < ids.length; i += 20) {
        const chunk = ids.slice(i, i + 20);
        const rows = await fetchPaged(() => supabase.from('exam_scores').select('*').in('paper_id', chunk).order('id'));
        rows.forEach((r) => {
          (grouped[r.paper_id] ||= []).push(r);
        });
      }
      setScoresByPaper(grouped);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }

  const studentById = useMemo(() => Object.fromEntries(students.map((s) => [s.id, s])), [students]);
  const nameOf = (p) => studentById[p.student_id]?.full_name || p.detected_name || 'Unknown student';

  const sortedPapers = useMemo(
    () => sortForReview(papers, (p) => studentById[p.student_id]?.full_name || p.detected_name || 'Unknown student'),
    [papers, studentById]
  );
  const counts = useMemo(() => {
    const approved = papers.filter((p) => p.status === 'approved').length;
    return { approved, todo: papers.length - approved, all: papers.length };
  }, [papers]);
  const visiblePapers = useMemo(() => {
    if (tab === 'approved') return sortedPapers.filter((p) => p.status === 'approved');
    if (tab === 'todo') return sortedPapers.filter((p) => p.status !== 'approved');
    return sortedPapers;
  }, [sortedPapers, tab]);
  const bulkEligible = useMemo(
    () => papers.filter((p) => isBulkEligible(p, scoresByPaper[p.id])),
    [papers, scoresByPaper]
  );

  // Keep a script selected whenever there is one
  useEffect(() => {
    if (visiblePapers.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !papers.some((p) => p.id === selectedId)) setSelectedId(visiblePapers[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visiblePapers.length, papers]);

  const selected = papers.find((p) => p.id === selectedId) || null;
  const selectedScores = selected ? scoresByPaper[selected.id] || [] : [];
  const scoreByQuestion = useMemo(
    () => Object.fromEntries(selectedScores.map((s) => [s.question_id, s])),
    [selectedScores]
  );

  // Load the editing fields and photos whenever a different script (or fresh data) is shown
  useEffect(() => {
    if (!selected) {
      setPageUrls([]);
      return;
    }
    const marks = {};
    questions.forEach((q) => {
      const s = scoreByQuestion[q.id];
      marks[q.id] = s ? String(s.final_marks ?? s.ai_marks ?? 0) : '0';
    });
    setDraftMarks(marks);
    setDraftComment(selected.teacher_comment || '');
    setDraftStudentId(selected.student_id || '');

    let cancelled = false;
    (async () => {
      const paths = selected.exam_paper_pages.map((p) => p.storage_path);
      if (paths.length === 0) {
        setPageUrls([]);
        return;
      }
      const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600);
      if (!cancelled) setPageUrls((signed || []).map((s) => s.signedUrl).filter(Boolean));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, papers, scoresByPaper, questions]);

  const checked = checkMarks(questions, draftMarks);
  const liveTotal = checked.error ? null : checked.total;

  const dirty = (() => {
    if (!selected) return false;
    if ((draftComment.trim() || '') !== (selected.teacher_comment || '')) return true;
    if ((draftStudentId || '') !== (selected.student_id || '')) return true;
    return questions.some((q) => {
      const s = scoreByQuestion[q.id];
      return Number(draftMarks[q.id]) !== Number(s?.final_marks ?? s?.ai_marks ?? 0);
    });
  })();

  function selectPaper(id) {
    if (id === selectedId) return;
    if (dirty && !confirm('You have unsaved changes on this script. Leave without saving?')) return;
    setError('');
    setNotice('');
    setSelectedId(id);
  }

  function setMarks(questionId, value) {
    setDraftMarks((prev) => ({ ...prev, [questionId]: value }));
  }

  // Students who can still be chosen for this script
  const pickableStudents = useMemo(() => {
    const taken = new Set(papers.filter((p) => p.id !== selectedId && p.student_id).map((p) => p.student_id));
    return students.filter((s) => !taken.has(s.id));
  }, [students, papers, selectedId]);

  async function saveCurrent(approve) {
    if (!selected) return;
    setError('');
    setNotice('');

    if (checked.error) {
      setError(checked.error);
      return;
    }
    if (approve && !draftStudentId) {
      setError('Choose which student this script belongs to before approving.');
      return;
    }

    // Work out which script to show next, before the list changes
    const idx = visiblePapers.findIndex((p) => p.id === selected.id);
    const nextId =
      visiblePapers.slice(idx + 1).find((p) => p.status !== 'approved')?.id ||
      visiblePapers.find((p) => p.id !== selected.id && p.status !== 'approved')?.id ||
      null;

    setBusy(true);
    try {
      await Promise.all(
        checked.rows.map(async (row) => {
          const ai = scoreByQuestion[row.question_id];
          const { error: scoreErr } = await supabase
            .from('exam_scores')
            .update({ final_marks: row.marks, overridden: ai ? Number(ai.ai_marks) !== row.marks : true })
            .eq('paper_id', selected.id)
            .eq('question_id', row.question_id);
          if (scoreErr) throw new Error(scoreErr.message);
        })
      );

      const update = {
        final_total: checked.total,
        teacher_comment: draftComment.trim() || null,
        student_id: draftStudentId || null,
      };
      if (approve) {
        update.status = 'approved';
        update.approved_at = new Date().toISOString();
      }
      const { error: paperErr } = await supabase.from('exam_papers').update(update).eq('id', selected.id);
      if (paperErr) throw new Error(paperErr.code === '23505' ? 'That student already has another script.' : paperErr.message);

      await load(false);
      setNotice(approve ? `Approved ${studentById[draftStudentId]?.full_name || 'script'}.` : 'Changes saved.');
      if (approve && nextId) setSelectedId(nextId);
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  async function handleUnapprove() {
    if (!selected) return;
    setBusy(true);
    setError('');
    const { error: err } = await supabase
      .from('exam_papers')
      .update({ status: 'needs_review', approved_at: null })
      .eq('id', selected.id);
    if (err) setError(err.message);
    await load(false);
    setBusy(false);
  }

  async function handleRegrade() {
    if (!selected) return;
    if (!confirm('Grade this script with the AI again? Your changes to its marks will be replaced, and it uses another AI call.')) {
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await callGradeApi(selected.id, true);
      if (result.ok === false) setError(result.error);
      else setNotice('Graded again.');
    } catch (err) {
      setError(err.message);
    }
    await load(false);
    setBusy(false);
  }

  async function handleBulkApprove() {
    if (bulkEligible.length === 0) return;
    const ok = confirm(
      `Approve ${bulkEligible.length} script${bulkEligible.length === 1 ? '' : 's'} where the AI was confident?\\n\\nOnly scripts that are assigned to a student, not flagged, at least ${Math.round(
        BULK_MIN_MEAN * 100
      )}% sure overall, with no shaky question. You can still unapprove any of them.`
    );
    if (!ok) return;

    setBusy(true);
    setError('');
    setNotice('');
    try {
      const ids = bulkEligible.map((p) => p.id);
      for (let i = 0; i < ids.length; i += 50) {
        const { error: err } = await supabase
          .from('exam_papers')
          .update({ status: 'approved', approved_at: new Date().toISOString() })
          .in('id', ids.slice(i, i + 50))
          .eq('status', 'needs_review');
        if (err) throw new Error(err.message);
      }
      await load(false);
      setNotice(`Approved ${ids.length} script${ids.length === 1 ? '' : 's'}.`);
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  // ---------- export ----------
  // Always read fresh from the database so the file matches what is approved right now
  async function fetchExportData() {
    const allPapers = await fetchPaged(() =>
      supabase
        .from('exam_papers')
        .select('id, student_id, status, final_total, teacher_comment')
        .eq('exam_id', examId)
        .order('id')
    );
    const approvedIds = allPapers.filter((p) => p.status === 'approved').map((p) => p.id);
    const allScores = [];
    for (let i = 0; i < approvedIds.length; i += 20) {
      const chunk = approvedIds.slice(i, i + 20);
      const rows = await fetchPaged(() =>
        supabase.from('exam_scores').select('paper_id, question_id, final_marks').in('paper_id', chunk).order('id')
      );
      allScores.push(...rows);
    }
    return { papers: allPapers, scores: allScores };
  }

  async function openExport() {
    setExportOpen(true);
    setError('');
    setNotice('');
    setExportBusy(true);
    try {
      setExportData(await fetchExportData());
    } catch (err) {
      setError(err.message);
    }
    setExportBusy(false);
  }

  async function handleDownload() {
    setExportBusy(true);
    setError('');
    setNotice('');
    try {
      const data = await fetchExportData();
      setExportData(data);
      const table = buildExportTable({ exam, questions, students, papers: data.papers, scores: data.scores, options: exportOpts });
      downloadCsv(exportFileName(exam.title), toCsv([table.header, ...table.rows]));
      setNotice(`Downloaded ${table.rows.length} row${table.rows.length === 1 ? '' : 's'}.`);
    } catch (err) {
      setError(err.message);
    }
    setExportBusy(false);
  }

  const exportTable = useMemo(() => {
    if (!exportData || !exam) return null;
    return buildExportTable({ exam, questions, students, papers: exportData.papers, scores: exportData.scores, options: exportOpts });
  }, [exportData, exportOpts, exam, questions, students]);

  if (loading) {
    return (
      <div className="page-wide">
        <p>Loading...</p>
      </div>
    );
  }

  if (!exam) {
    return (
      <div className="page-wide">
        <div className="breadcrumb">
          <Link href="/marking">Marking</Link>
        </div>
        <p className="error-text">{error || 'This marking job was not found.'}</p>
      </div>
    );
  }

  const isApproved = selected?.status === 'approved';
  const tabButton = (key, label, count) => (
    <button
      type="button"
      className={tab === key ? undefined : 'btn-secondary'}
      style={{ ...smallBtn, marginRight: 6 }}
      onClick={() => setTab(key)}
    >
      {label} ({count})
    </button>
  );

  return (
    <div className="page-wide" style={{ maxWidth: 1280 }}>
      <style>{CSS}</style>

      <div className="breadcrumb">
        <Link href="/dashboard">Dashboard</Link> / <Link href="/marking">Marking</Link> /{' '}
        <Link href={`/marking/${examId}`}>{exam.title}</Link> / Review
      </div>

      <div className="main-header" style={{ marginBottom: 12 }}>
        <div>
          <h1>Review: {exam.title}</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            {counts.approved} of {counts.all} graded scripts approved · out of {exam.total_marks} marks
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="btn-secondary"
          style={{ width: 'auto', marginTop: 0 }}
          disabled={busy || exportBusy}
          onClick={exportOpen ? () => setExportOpen(false) : openExport}
        >
          {exportOpen ? 'Close export' : 'Export CSV'}
        </button>
        <button
          type="button"
          style={{ width: 'auto', marginTop: 0 }}
          disabled={bulkEligible.length === 0 || busy}
          onClick={handleBulkApprove}
          title="Approves only scripts the AI was clearly confident about"
        >
          {bulkEligible.length === 0 ? 'No confident scripts to bulk approve' : `Approve ${bulkEligible.length} confident script${bulkEligible.length === 1 ? '' : 's'}`}
        </button>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}
      {notice && <p style={{ color: 'var(--gf-success-text)', fontSize: 13 }}>{notice}</p>}

      {exportOpen && (
        <div className="surface" style={{ marginBottom: 16 }}>
          <p className="section-heading">Export results</p>

          {!exportTable ? (
            <p className="assignment-row-meta">Loading the latest results...</p>
          ) : (
            <>
              <p className="assignment-row-title" style={{ marginBottom: 6 }}>
                {exportTable.summary.approved} of {exportTable.summary.rosterSize} students have an approved score
              </p>
              {exportTable.summary.awaiting > 0 && (
                <p style={{ color: 'var(--gf-warning-text)', fontSize: 13, margin: '2px 0' }}>
                  {exportTable.summary.awaiting} script{exportTable.summary.awaiting === 1 ? ' is' : 's are'} graded but not
                  approved yet.
                </p>
              )}
              {exportTable.summary.notGraded + exportTable.summary.failed > 0 && (
                <p style={{ color: 'var(--gf-warning-text)', fontSize: 13, margin: '2px 0' }}>
                  {exportTable.summary.notGraded + exportTable.summary.failed} uploaded script
                  {exportTable.summary.notGraded + exportTable.summary.failed === 1 ? ' has' : 's have'} not been graded.
                </p>
              )}
              {exportTable.summary.noScript > 0 && (
                <p style={{ color: 'var(--gf-warning-text)', fontSize: 13, margin: '2px 0' }}>
                  {exportTable.summary.noScript} student{exportTable.summary.noScript === 1 ? ' has' : 's have'} no script uploaded.
                </p>
              )}
              {exportTable.summary.unassignedScripts > 0 && (
                <p style={{ color: 'var(--gf-warning-text)', fontSize: 13, margin: '2px 0' }}>
                  {exportTable.summary.unassignedScripts} uploaded script{exportTable.summary.unassignedScripts === 1 ? ' is' : 's are'} not
                  assigned to a student, so cannot be exported.
                </p>
              )}

              <div style={{ margin: '12px 0' }}>
                {[
                  ['includeMissing', 'Include students without an approved score (listed with a status, so nobody goes missing)'],
                  ['perQuestion', 'Show the marks for each question'],
                  ['comments', 'Include my comments'],
                ].map(([key, label]) => (
                  <label key={key} style={{ display: 'flex', alignItems: 'center', margin: '6px 0', fontWeight: 400 }}>
                    <input
                      type="checkbox"
                      checked={exportOpts[key]}
                      onChange={(e) => setExportOpts((prev) => ({ ...prev, [key]: e.target.checked }))}
                      style={{ width: 'auto', margin: '0 8px 0 0' }}
                    />
                    {label}
                  </label>
                ))}
              </div>

              <button
                type="button"
                style={{ width: 'auto', margin: 0 }}
                disabled={exportBusy || exportTable.rows.length === 0}
                onClick={handleDownload}
              >
                {exportBusy
                  ? 'Preparing...'
                  : exportTable.rows.length === 0
                    ? 'Nothing to export yet'
                    : `Download CSV (${exportTable.rows.length} row${exportTable.rows.length === 1 ? '' : 's'})`}
              </button>
            </>
          )}
        </div>
      )}

      {papers.length === 0 ? (
        <div className="surface" style={{ textAlign: 'center', padding: 40 }}>
          <p className="assignment-row-title">Nothing to review yet</p>
          <p className="subtitle">Grade some scripts first, then they will appear here.</p>
          <button type="button" style={{ width: 'auto' }} onClick={() => router.push(`/marking/${examId}`)}>
            Back to scripts
          </button>
        </div>
      ) : (
        <div className="rv-layout">
          {/* ---------- left: list of scripts ---------- */}
          <div className="surface" style={{ padding: 0 }}>
            <div style={{ padding: 12, borderBottom: '1px solid var(--gf-border)' }}>
              {tabButton('todo', 'To review', counts.todo)}
              {tabButton('approved', 'Approved', counts.approved)}
              {tabButton('all', 'All', counts.all)}
            </div>
            <div className="rv-list">
              {visiblePapers.length === 0 ? (
                <p style={{ padding: 12, margin: 0, fontSize: 13, color: 'var(--gf-text-secondary)' }}>
                  {tab === 'todo' ? 'Everything is approved. 🎉' : 'Nothing here.'}
                </p>
              ) : (
                visiblePapers.map((p) => (
                  <div
                    key={p.id}
                    className={`rv-item${p.id === selectedId ? ' selected' : ''}`}
                    onClick={() => selectPaper(p.id)}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <strong style={{ fontSize: 14 }}>{nameOf(p)}</strong>
                      <span style={{ fontSize: 13 }}>
                        {p.final_total ?? p.ai_total ?? 0}/{exam.total_marks}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
                      <span className="tag">{STATUS_LABEL[p.status]}</span>
                      <ConfidenceBadge value={p.ai_confidence} />
                      {!p.student_id && <span style={{ fontSize: 12, color: 'var(--gf-warning-text)' }}>No student</span>}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* ---------- right: the selected script ---------- */}
          {selected ? (
            <div>
              <div className="surface" style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <label style={{ marginTop: 0 }}>Student</label>
                    <select
                      value={draftStudentId}
                      onChange={(e) => setDraftStudentId(e.target.value)}
                      disabled={busy}
                      style={!draftStudentId ? { borderColor: 'var(--gf-warning-text)' } : undefined}
                    >
                      <option value="">Not assigned. Choose a student</option>
                      {pickableStudents.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.full_name} ({s.reg_no})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <p className="assignment-row-meta" style={{ margin: 0 }}>
                      AI gave {selected.ai_total ?? 0} · you have given
                    </p>
                    <p style={{ margin: 0, fontSize: 26, fontWeight: 600 }}>
                      {liveTotal === null ? '?' : liveTotal}
                      <span style={{ fontSize: 15, fontWeight: 400, color: 'var(--gf-text-secondary)' }}> / {exam.total_marks}</span>
                    </p>
                  </div>
                </div>

                {!draftStudentId && (
                  <p style={{ color: 'var(--gf-warning-text)', fontSize: 13, margin: '10px 0 0 0' }}>
                    Who is this?{' '}
                    {selected.detected_name || selected.detected_reg_no
                      ? `The AI read: ${[selected.detected_name, selected.detected_reg_no].filter(Boolean).join(' / ')}. `
                      : ''}
                    {selected.match_note || ''}
                  </p>
                )}
                {selected.page_issues && (
                  <p style={{ color: 'var(--gf-warning-text)', fontSize: 13, margin: '10px 0 0 0' }}>
                    Photo problem reported by the AI: {selected.page_issues}
                  </p>
                )}
              </div>

              <div className="rv-detail">
                {/* photos */}
                <div className="rv-pages">
                  {pageUrls.length === 0 ? (
                    <p className="assignment-row-meta">Loading photos...</p>
                  ) : (
                    pageUrls.map((url, i) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={url} src={url} alt={`Page ${i + 1}`} onClick={() => window.open(url, '_blank')} />
                    ))
                  )}
                  <p className="assignment-row-meta">Click a page to open it full size.</p>
                </div>

                {/* marks */}
                <div>
                  {questions.map((q) => {
                    const s = scoreByQuestion[q.id];
                    const changed = s && Number(draftMarks[q.id]) !== Number(s.ai_marks);
                    return (
                      <div key={q.id} className="surface" style={{ marginBottom: 12, padding: 16 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                          <strong>Question {q.label}</strong>
                          {s && <ConfidenceBadge value={s.confidence} />}
                        </div>
                        <p className="assignment-row-meta" style={{ margin: '4px 0 8px 0' }}>{q.question_text}</p>

                        {q.question_type === 'objective' ? (
                          <p style={{ fontSize: 13, margin: '0 0 8px 0' }}>
                            Student answered: <strong>{s?.student_answer || 'nothing'}</strong> · Correct answer:{' '}
                            <strong>{q.answer_key}</strong>
                          </p>
                        ) : (
                          <>
                            {s?.evidence && (
                              <p style={{ fontSize: 13, margin: '0 0 4px 0' }}>
                                <span style={{ color: 'var(--gf-text-secondary)' }}>The student wrote: </span>
                                {s.evidence}
                              </p>
                            )}
                            {s?.reasoning && (
                              <p style={{ fontSize: 13, margin: '0 0 8px 0' }}>
                                <span style={{ color: 'var(--gf-text-secondary)' }}>Why this mark: </span>
                                {s.reasoning}
                              </p>
                            )}
                          </>
                        )}

                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <input
                            type="number"
                            min="0"
                            max={q.max_marks}
                            step="0.5"
                            value={draftMarks[q.id] ?? ''}
                            disabled={busy}
                            onChange={(e) => setMarks(q.id, e.target.value)}
                            style={{ width: 90, margin: 0 }}
                            aria-label={`Marks for question ${q.label}`}
                          />
                          <span style={{ fontSize: 13 }}>/ {q.max_marks}</span>
                          <button type="button" className="btn-secondary" style={smallBtn} disabled={busy} onClick={() => setMarks(q.id, '0')}>
                            0
                          </button>
                          <button
                            type="button"
                            className="btn-secondary"
                            style={smallBtn}
                            disabled={busy}
                            onClick={() => setMarks(q.id, String(q.max_marks))}
                          >
                            Full
                          </button>
                          {changed && (
                            <span style={{ fontSize: 12, color: 'var(--gf-warning-text)' }}>AI gave {s.ai_marks}</span>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  <div className="surface" style={{ padding: 16 }}>
                    <label style={{ marginTop: 0 }}>Comment for the student (optional)</label>
                    <textarea
                      rows={2}
                      value={draftComment}
                      disabled={busy}
                      onChange={(e) => setDraftComment(e.target.value)}
                      placeholder="e.g. Good method, but check your units."
                    />

                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
                      {isApproved ? (
                        <>
                          <button type="button" style={{ width: 'auto', margin: 0 }} disabled={busy || !dirty} onClick={() => saveCurrent(false)}>
                            Save changes
                          </button>
                          <button type="button" className="btn-secondary" style={{ width: 'auto', margin: 0 }} disabled={busy} onClick={handleUnapprove}>
                            Unapprove
                          </button>
                        </>
                      ) : (
                        <>
                          <button type="button" style={{ width: 'auto', margin: 0 }} disabled={busy} onClick={() => saveCurrent(true)}>
                            {busy ? 'Saving...' : 'Approve and next'}
                          </button>
                          <button type="button" className="btn-secondary" style={{ width: 'auto', margin: 0 }} disabled={busy || !dirty} onClick={() => saveCurrent(false)}>
                            Save without approving
                          </button>
                          <button type="button" className="btn-secondary" style={{ width: 'auto', margin: 0 }} disabled={busy} onClick={handleRegrade}>
                            Grade again with AI
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="surface">
              <p className="subtitle" style={{ margin: 0 }}>Choose a script on the left.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
