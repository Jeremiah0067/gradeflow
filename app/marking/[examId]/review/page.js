'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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
import { Icon } from '../../../../components/icons';
import PenScore from '../../../../components/ui/PenScore';
import { buildExportTable, downloadCsv, exportFileName } from '../../../../lib/exportResults';

const BUCKET = 'exam-papers';
const GRADED = ['needs_review', 'flagged', 'approved'];
const STATUS_CHIP = {
  needs_review: { label: 'To review', cls: 'chip-blue' },
  flagged: { label: 'Check carefully', cls: 'chip-amber' },
  approved: { label: 'Approved', cls: 'chip-green' },
};

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
  return <span className={`chip ${low ? 'chip-amber' : 'chip-green'} num`}>{pct}% sure</span>;
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

  const openedFromLink = useRef(false);
  useEffect(() => {
    if (loading || !exam || openedFromLink.current) return;
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('export') === '1') {
      openedFromLink.current = true;
      openExport();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, exam]);

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
  const idx = selected ? visiblePapers.findIndex((p) => p.id === selected.id) : -1;
  const prevId = idx > 0 ? visiblePapers[idx - 1].id : null;
  const nextId = idx >= 0 && idx < visiblePapers.length - 1 ? visiblePapers[idx + 1].id : null;
  const tabButton = (key, label, count) => (
    <button type="button" aria-pressed={tab === key} onClick={() => setTab(key)}>
      {label} <span className="num">{count}</span>
    </button>
  );
  const sum = exportTable?.summary;

  return (
    <div className="page-wide" style={{ maxWidth: 1360 }}>
      <div className="breadcrumb">
        <Link href="/marking">Marking</Link> / <Link href={`/marking/${examId}`}>{exam.title}</Link> / Review
      </div>

      <div className="page-head">
        <div>
          <h1>Review</h1>
          <p className="subtitle num">
            {counts.approved} of {counts.all} graded scripts approved, out of {exam.total_marks} marks
          </p>
        </div>
        <div className="page-head-actions">
          <button type="button" className="btn-secondary" disabled={busy || exportBusy} onClick={exportOpen ? () => setExportOpen(false) : openExport}>
            <Icon name="download" size={18} />
            {exportOpen ? 'Close export' : 'Export CSV'}
          </button>
          <button type="button" disabled={bulkEligible.length === 0 || busy} onClick={handleBulkApprove} title="Approves only scripts the AI was clearly confident about">
            <Icon name="check" size={18} />
            {bulkEligible.length === 0 ? 'No confident scripts to approve' : `Approve ${bulkEligible.length} confident`}
          </button>
        </div>
      </div>

      {error && <p className="alert alert-error" role="alert">{error}</p>}
      {notice && <p className="alert alert-ok" role="status">{notice}</p>}

      {exportOpen && (
        <div className="surface">
          <h2>Export results</h2>
          {!exportTable ? (
            <p className="section-note">Loading the latest results...</p>
          ) : (
            <>
              <p className="row-title num" style={{ marginBottom: 'var(--s-3)' }}>
                {sum.approved} of {sum.rosterSize} students have an approved score
              </p>
              {sum.awaiting > 0 && <p className="alert alert-warn">{sum.awaiting} {sum.awaiting === 1 ? 'script is' : 'scripts are'} graded but not approved yet.</p>}
              {sum.notGraded + sum.failed > 0 && <p className="alert alert-warn">{sum.notGraded + sum.failed} uploaded {sum.notGraded + sum.failed === 1 ? 'script has' : 'scripts have'} not been graded.</p>}
              {sum.noScript > 0 && <p className="alert alert-warn">{sum.noScript} {sum.noScript === 1 ? 'student has' : 'students have'} no script uploaded.</p>}
              {sum.unassignedScripts > 0 && <p className="alert alert-warn">{sum.unassignedScripts} uploaded {sum.unassignedScripts === 1 ? 'script is' : 'scripts are'} not assigned to a student, so cannot be exported.</p>}

              <div style={{ margin: 'var(--s-3) 0 var(--s-4)' }}>
                {[
                  ['includeMissing', 'Include students without an approved score (listed with a status, so nobody goes missing)'],
                  ['perQuestion', 'Show the marks for each question'],
                  ['comments', 'Include my comments'],
                ].map(([key, label]) => (
                  <label key={key} className="checkline">
                    <input type="checkbox" checked={exportOpts[key]} onChange={(e) => setExportOpts((prev) => ({ ...prev, [key]: e.target.checked }))} />
                    {label}
                  </label>
                ))}
              </div>

              <button type="button" disabled={exportBusy || exportTable.rows.length === 0} onClick={handleDownload}>
                <Icon name="download" size={18} />
                {exportBusy ? 'Preparing...' : exportTable.rows.length === 0 ? 'Nothing to export yet' : `Download CSV (${exportTable.rows.length} ${exportTable.rows.length === 1 ? 'row' : 'rows'})`}
              </button>
            </>
          )}
        </div>
      )}

      {papers.length === 0 ? (
        <div className="surface">
          <div className="empty">
            <span className="empty-icon"><Icon name="check" size={26} /></span>
            <h2>Nothing to review yet</h2>
            <p>Grade some scripts first, then they will appear here for you to check.</p>
            <button type="button" onClick={() => router.push(`/marking/${examId}`)}>Back to scripts</button>
          </div>
        </div>
      ) : (
        <div className="rv-layout">
          {/* ---------- the list of scripts ---------- */}
          <aside>
            <div className="seg" style={{ width: '100%', marginBottom: 'var(--s-3)' }}>
              {tabButton('todo', 'To review', counts.todo)}
              {tabButton('approved', 'Approved', counts.approved)}
              {tabButton('all', 'All', counts.all)}
            </div>
            <div className="rows rv-list">
              {visiblePapers.length === 0 ? (
                <p className="section-note" style={{ padding: 'var(--s-4)', margin: 0 }}>
                  {tab === 'todo' ? 'Everything is approved.' : 'Nothing here.'}
                </p>
              ) : (
                visiblePapers.map((p) => {
                  const chip = STATUS_CHIP[p.status];
                  return (
                    <button key={p.id} type="button" className={`rv-item${p.id === selectedId ? ' selected' : ''}`} onClick={() => selectPaper(p.id)}>
                      <span className="rv-item-top">
                        <span>{nameOf(p)}</span>
                        <span className="num">{p.final_total ?? p.ai_total ?? 0}/{exam.total_marks}</span>
                      </span>
                      <span className="rv-item-sub">
                        <span className={`chip ${chip.cls}`}>{chip.label}</span>
                        {!p.student_id && <span className="chip chip-amber">No student</span>}
                        <ConfidenceBadge value={p.ai_confidence} />
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          {/* ---------- the selected script ---------- */}
          {selected ? (
            <div style={{ minWidth: 0 }}>
              <div className="rv-bar">
                <div className="rv-nav">
                  <button type="button" className="btn-secondary btn-sm" disabled={!prevId} onClick={() => selectPaper(prevId)} aria-label="Previous script">
                    <Icon name="chevronLeft" size={18} />
                  </button>
                  <button type="button" className="btn-secondary btn-sm" disabled={!nextId} onClick={() => selectPaper(nextId)} aria-label="Next script">
                    <Icon name="chevronRight" size={18} />
                  </button>
                </div>
                <div className="rv-who">
                  <h2 style={{ margin: 0, fontSize: '1.125rem' }}>{nameOf(selected)}</h2>
                  <p className="meta num" style={{ marginTop: 2 }}>
                    <span>{idx + 1} of {visiblePapers.length}</span>
                    {studentById[selected.student_id] && <span>{studentById[selected.student_id].reg_no}</span>}
                    {selected.escalated && <span>Re-checked by the stronger model</span>}
                  </p>
                </div>
                <label className="rv-jump visually-hidden" htmlFor="rv-jump">Jump to script</label>
                <select id="rv-jump" className="rv-jump" value={selected.id} onChange={(e) => selectPaper(e.target.value)} style={{ minHeight: 40, maxWidth: 220 }}>
                  {visiblePapers.map((p) => (
                    <option key={p.id} value={p.id}>{nameOf(p)}</option>
                  ))}
                </select>
                <PenScore value={liveTotal === null ? '?' : liveTotal} outOf={exam.total_marks} />
                {isApproved ? (
                  <span className="chip chip-green"><Icon name="check" size={14} strokeWidth={3} /> Approved</span>
                ) : (
                  <button type="button" disabled={busy} onClick={() => saveCurrent(true)}>
                    {busy ? 'Saving...' : 'Approve and next'}
                  </button>
                )}
              </div>

              {(!draftStudentId || selected.page_issues) && (
                <div style={{ marginBottom: 'var(--s-4)' }}>
                  {!draftStudentId && (
                    <p className="alert alert-warn">
                      <span>
                        <strong>Who is this?</strong>{' '}
                        {selected.detected_name || selected.detected_reg_no
                          ? `The AI read \u201C${[selected.detected_name, selected.detected_reg_no].filter(Boolean).join(', ')}\u201D on the first page. `
                          : ''}
                        {selected.match_note || 'Choose the student below before approving.'}
                      </span>
                    </p>
                  )}
                  {selected.page_issues && (
                    <p className="alert alert-warn"><span><strong>Photo problem.</strong> {selected.page_issues}</span></p>
                  )}
                </div>
              )}

              <div className="rv-detail">
                <div className="rv-pages">
                  {pageUrls.length === 0 ? (
                    <p className="section-note" style={{ margin: 0 }}>Loading photos...</p>
                  ) : (
                    pageUrls.map((url, i) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={url} src={url} alt={`Page ${i + 1} of the script`} onClick={() => window.open(url, '_blank')} />
                    ))
                  )}
                  <p className="hint" style={{ margin: 0 }}>Click a page to open it full size.</p>
                </div>

                <div>
                  <label htmlFor="rv-student" style={{ marginTop: 0 }}>Student</label>
                  <select id="rv-student" value={draftStudentId} onChange={(e) => setDraftStudentId(e.target.value)} disabled={busy} style={{ marginBottom: 'var(--s-4)' }}>
                    <option value="">Not assigned. Choose a student</option>
                    {pickableStudents.map((st) => (
                      <option key={st.id} value={st.id}>{st.full_name} ({st.reg_no})</option>
                    ))}
                  </select>

                  {questions.map((q) => {
                    const sc = scoreByQuestion[q.id];
                    const changed = sc && Number(draftMarks[q.id]) !== Number(sc.ai_marks);
                    const shaky = sc && Number(sc.confidence ?? 0) < LOW_CONFIDENCE;
                    return (
                      <div key={q.id} className={`qmark${shaky ? ' is-shaky' : ''}`}>
                        <div className="qmark-head">
                          <h3 style={{ margin: 0 }}>Question {q.label}</h3>
                          {sc && <ConfidenceBadge value={sc.confidence} />}
                        </div>
                        <p className="qmark-q">{q.question_text}</p>

                        {q.question_type === 'objective' ? (
                          <p className="qmark-says">
                            <span>Student answered </span><strong>{sc?.student_answer || 'nothing'}</strong>
                            <span>. Correct answer is </span><strong>{q.answer_key}</strong>
                          </p>
                        ) : (
                          <>
                            {sc?.evidence && <p className="qmark-says"><span>The student wrote: </span>{sc.evidence}</p>}
                            {sc?.reasoning && <p className="qmark-says"><span>Why this mark: </span>{sc.reasoning}</p>}
                          </>
                        )}

                        <div className="qmark-entry">
                          <input
                            type="number"
                            min="0"
                            max={q.max_marks}
                            step="0.5"
                            value={draftMarks[q.id] ?? ''}
                            disabled={busy}
                            onChange={(e) => setMarks(q.id, e.target.value)}
                            aria-label={`Marks for question ${q.label}, out of ${q.max_marks}`}
                          />
                          <span className="num">/ {q.max_marks}</span>
                          <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => setMarks(q.id, '0')}>0</button>
                          <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => setMarks(q.id, String(q.max_marks))}>Full</button>
                          {changed && <span className="chip chip-amber num">AI gave {sc.ai_marks}</span>}
                        </div>
                      </div>
                    );
                  })}

                  <div className="qmark">
                    <label htmlFor="rv-comment" style={{ marginTop: 0 }}>Comment for the student <span className="hint" style={{ display: 'inline' }}>(optional)</span></label>
                    <textarea id="rv-comment" rows={2} value={draftComment} disabled={busy} onChange={(e) => setDraftComment(e.target.value)} placeholder="e.g. Good method, but check your units." />

                    <div style={{ display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap', marginTop: 'var(--s-4)' }}>
                      {isApproved ? (
                        <>
                          <button type="button" disabled={busy || !dirty} onClick={() => saveCurrent(false)}>Save changes</button>
                          <button type="button" className="btn-secondary" disabled={busy} onClick={handleUnapprove}>Unapprove</button>
                        </>
                      ) : (
                        <>
                          <button type="button" className="btn-secondary" disabled={busy || !dirty} onClick={() => saveCurrent(false)}>Save without approving</button>
                          <button type="button" className="btn-quiet" disabled={busy} onClick={handleRegrade}>Grade again with AI</button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="surface"><p className="section-note" style={{ margin: 0 }}>Choose a script on the left.</p></div>
          )}
        </div>
      )}
    </div>
  );
}
