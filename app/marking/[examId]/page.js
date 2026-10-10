'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '../../../lib/supabaseClient';
import { compressImage } from '../../../lib/imageCompress';
import { estimateBatch, formatUsd } from '../../../lib/estimateCost';
import { GRADING_MODES } from '../../../lib/gradingModels';
import { computeProgress, isGradable } from '../../../lib/jobProgress';
import { Icon } from '../../../components/icons';
import { Rail, NextAction } from '../../../components/marking/JobRail';
import { PhotoButtons } from '../../../components/ui/FilePicker';

const BUCKET = 'exam-papers';
const MAX_PAGES_PER_SCRIPT = 20;
const GRADING_CONCURRENCY = 3; // how many scripts are graded at the same time

const STATUS_CHIP = {
  uploaded: { label: 'Waiting', cls: '' },
  queued: { label: 'Queued', cls: 'chip-blue' },
  grading: { label: 'Grading', cls: 'chip-blue chip-dot chip-live' },
  needs_review: { label: 'Ready to review', cls: 'chip-blue' },
  flagged: { label: 'Check carefully', cls: 'chip-amber' },
  approved: { label: 'Approved', cls: 'chip-green' },
  failed: { label: 'Failed', cls: 'chip-red' },
};

const MODE_SHORT = { standard: 'Standard', smart: 'Smart saver', economy: 'Economy' };

let draftCounter = 0;
function newDraft() {
  draftCounter += 1;
  return { key: `draft-${draftCounter}`, pages: [], studentId: '' };
}

async function fetchAllStudents(examId) {
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('exam_students')
      .select('*')
      .eq('exam_id', examId)
      .order('full_name')
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all;
}

async function fetchAllUsage(examId) {
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('exam_ai_usage')
      .select('*')
      .eq('exam_id', examId)
      .order('created_at')
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all;
}

async function callGradeApi(paperId, force = false) {
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

export default function ExamWorkspacePage() {
  const router = useRouter();
  const { examId } = useParams();

  const [userId, setUserId] = useState(null);
  const [exam, setExam] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [students, setStudents] = useState([]);
  const [papers, setPapers] = useState([]);
  const [thumbs, setThumbs] = useState({});

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [drafts, setDrafts] = useState(() => [newDraft()]);
  const [preparingKey, setPreparingKey] = useState(null);
  const [uploading, setUploading] = useState(null);
  const [showMissingOnly, setShowMissingOnly] = useState(false);
  const [grading, setGrading] = useState(null); // { done, total, failed } while a batch is running
  const [retryingId, setRetryingId] = useState(null);
  const [usage, setUsage] = useState({ calls: 0, cost: 0 });
  const [measuredOut, setMeasuredOut] = useState({}); // average AI output per script, by model, from real calls
  const [budgetInput, setBudgetInput] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const cancelRef = useRef(false);
  const gradingRef = useRef(null);

  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  gradingRef.current = grading;

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId]);

  // Warn before leaving the page if there are photos that were not uploaded yet
  useEffect(() => {
    function onBeforeUnload(e) {
      if (draftsRef.current.some((d) => d.pages.length > 0) || gradingRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // showSpinner=false refreshes the data quietly (after an upload, assign or delete)
  // so the page doesn't flash to "Loading..." and jump back to the top.
  async function load(showSpinner = true) {
    if (showSpinner) setLoading(true);
    if (showSpinner) setError('');

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

    try {
      const { data: examRow, error: examErr } = await supabase
        .from('exams')
        .select('*')
        .eq('id', examId)
        .maybeSingle();
      if (examErr) throw new Error(examErr.message);
      if (!examRow) {
        setError('This marking job was not found.');
        setLoading(false);
        return;
      }
      setExam(examRow);

      const { data: questionRows } = await supabase
        .from('exam_questions')
        .select('*')
        .eq('exam_id', examId)
        .order('position');
      setQuestions(questionRows || []);

      setStudents(await fetchAllStudents(examId));

      const { data: paperRows, error: paperErr } = await supabase
        .from('exam_papers')
        .select('*, exam_paper_pages(id, page_no, storage_path)')
        .eq('exam_id', examId)
        .order('created_at', { ascending: true });
      if (paperErr) throw new Error(paperErr.message);

      const sortedPapers = (paperRows || []).map((p) => ({
        ...p,
        exam_paper_pages: [...(p.exam_paper_pages || [])].sort((a, b) => a.page_no - b.page_no),
      }));
      setPapers(sortedPapers);

      // Small preview of each script's first page (private bucket, so we need signed links)
      const firstPaths = sortedPapers.map((p) => p.exam_paper_pages[0]?.storage_path).filter(Boolean);
      if (firstPaths.length > 0) {
        const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrls(firstPaths, 3600);
        const map = {};
        (signed || []).forEach((s) => {
          if (s.signedUrl) map[s.path] = s.signedUrl;
        });
        setThumbs(map);
      } else {
        setThumbs({});
      }

      const usageRows = await fetchAllUsage(examId);
      setUsage({
        calls: usageRows.length,
        cost: usageRows.reduce((sum, r) => sum + (Number(r.est_cost_usd) || 0), 0),
      });
      const byModel = {};
      usageRows.forEach((r) => {
        const out = (Number(r.output_tokens) || 0) + (Number(r.thought_tokens) || 0);
        byModel[r.model] ||= { sum: 0, n: 0 };
        byModel[r.model].sum += out;
        byModel[r.model].n += 1;
      });
      setMeasuredOut(Object.fromEntries(Object.entries(byModel).map(([m, v]) => [m, { avg: v.sum / v.n, n: v.n }])));
      setBudgetInput(examRow.budget_usd === null || examRow.budget_usd === undefined ? '' : String(examRow.budget_usd));
    } catch (err) {
      setError(err.message);
    }

    setLoading(false);
  }

  const studentById = useMemo(() => Object.fromEntries(students.map((s) => [s.id, s])), [students]);
  const studentIdsWithScript = useMemo(
    () => new Set(papers.map((p) => p.student_id).filter(Boolean)),
    [papers]
  );
  const matchedCount = papers.filter((p) => p.student_id).length;
  const unmatchedCount = papers.length - matchedCount;

  // Students that can still be picked for a new script in the builder
  function studentsAvailableForDraft(draftKey) {
    const takenByOtherDrafts = new Set(
      drafts.filter((d) => d.key !== draftKey && d.studentId).map((d) => d.studentId)
    );
    return students.filter((s) => !studentIdsWithScript.has(s.id) && !takenByOtherDrafts.has(s.id));
  }

  // ---------- builder actions ----------
  function addDraft() {
    setDrafts((prev) => [...prev, newDraft()]);
  }

  function removeDraft(key) {
    setDrafts((prev) => {
      const target = prev.find((d) => d.key === key);
      target?.pages.forEach((p) => URL.revokeObjectURL(p.url));
      const rest = prev.filter((d) => d.key !== key);
      return rest.length > 0 ? rest : [newDraft()];
    });
  }

  function setDraftStudent(key, studentId) {
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, studentId } : d)));
  }

  function removePage(draftKey, pageId) {
    setDrafts((prev) =>
      prev.map((d) => {
        if (d.key !== draftKey) return d;
        const gone = d.pages.find((p) => p.id === pageId);
        if (gone) URL.revokeObjectURL(gone.url);
        return { ...d, pages: d.pages.filter((p) => p.id !== pageId) };
      })
    );
  }

  async function addFiles(draftKey, files) {
    if (files.length === 0) return;
    setError('');
    setNotice('');

    const draft = drafts.find((d) => d.key === draftKey);
    if ((draft?.pages.length || 0) + files.length > MAX_PAGES_PER_SCRIPT) {
      setError(`A script can have at most ${MAX_PAGES_PER_SCRIPT} pages.`);
      return;
    }

    setPreparingKey(draftKey);
    try {
      const added = [];
      for (const file of files) {
        if (!file.type.startsWith('image/')) throw new Error(`"${file.name}" is not a photo.`);
        const blob = await compressImage(file);
        added.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          blob,
          url: URL.createObjectURL(blob),
        });
      }
      setDrafts((prev) => prev.map((d) => (d.key === draftKey ? { ...d, pages: [...d.pages, ...added] } : d)));
    } catch (err) {
      setError(err.message);
    }
    setPreparingKey(null);
  }

  async function uploadOneScript(draft) {
    const { data: paper, error: paperErr } = await supabase
      .from('exam_papers')
      .insert({ exam_id: examId, student_id: draft.studentId || null, status: 'uploaded' })
      .select('id')
      .single();

    if (paperErr) {
      throw new Error(paperErr.code === '23505' ? 'That student already has a script uploaded.' : paperErr.message);
    }

    const uploadedPaths = [];
    try {
      for (let i = 0; i < draft.pages.length; i++) {
        const path = `${userId}/${examId}/${paper.id}/${i + 1}.jpg`;
        const { error: upErr } = await supabase.storage
          .from(BUCKET)
          .upload(path, draft.pages[i].blob, { contentType: 'image/jpeg', upsert: false });
        if (upErr) throw new Error(upErr.message);
        uploadedPaths.push(path);

        const { error: pageErr } = await supabase
          .from('exam_paper_pages')
          .insert({ paper_id: paper.id, page_no: i + 1, storage_path: path, mime_type: 'image/jpeg' });
        if (pageErr) throw new Error(pageErr.message);
      }
    } catch (err) {
      // Clean up so a failed script never leaves half-uploaded pages behind
      if (uploadedPaths.length > 0) await supabase.storage.from(BUCKET).remove(uploadedPaths);
      await supabase.from('exam_papers').delete().eq('id', paper.id);
      throw err;
    }
  }

  async function handleUploadAll() {
    setError('');
    setNotice('');

    const ready = drafts.filter((d) => d.pages.length > 0);
    if (ready.length === 0) {
      setError('Add at least one photo first.');
      return;
    }

    const chosen = ready.map((d) => d.studentId).filter(Boolean);
    if (new Set(chosen).size !== chosen.length) {
      setError('Two of these scripts are assigned to the same student.');
      return;
    }

    setUploading({ done: 0, total: ready.length });
    const succeeded = new Set();
    const failures = [];

    for (let i = 0; i < ready.length; i++) {
      try {
        await uploadOneScript(ready[i]);
        succeeded.add(ready[i].key);
      } catch (err) {
        failures.push(`Script ${drafts.findIndex((d) => d.key === ready[i].key) + 1}: ${err.message}`);
      }
      setUploading({ done: i + 1, total: ready.length });
    }

    // Keep only the scripts that failed, so the teacher can retry them
    setDrafts((prev) => {
      prev.filter((d) => succeeded.has(d.key)).forEach((d) => d.pages.forEach((p) => URL.revokeObjectURL(p.url)));
      const remaining = prev.filter((d) => !succeeded.has(d.key));
      return remaining.length > 0 ? remaining : [newDraft()];
    });

    setUploading(null);
    if (succeeded.size > 0) setNotice(`${succeeded.size} script${succeeded.size === 1 ? '' : 's'} uploaded.`);
    if (failures.length > 0) setError(failures.join(' | '));
    await load(false);
  }

  // ---------- uploaded-script actions ----------
  async function handleAssign(paperId, studentId) {
    setError('');
    setNotice('');
    const { error: updErr } = await supabase
      .from('exam_papers')
      .update({ student_id: studentId || null })
      .eq('id', paperId);
    if (updErr) {
      setError(updErr.code === '23505' ? 'That student already has a script uploaded.' : updErr.message);
      return;
    }
    await load(false);
  }

  async function handleDeletePaper(paper) {
    if (!confirm('Delete this script and its photos? This cannot be undone.')) return;
    setError('');
    setNotice('');
    const paths = paper.exam_paper_pages.map((p) => p.storage_path);
    if (paths.length > 0) await supabase.storage.from(BUCKET).remove(paths);
    const { error: delErr } = await supabase.from('exam_papers').delete().eq('id', paper.id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    await load(false);
  }

  // ---------- AI grading ----------
  const clientEnv = {
    GEMINI_MODEL: process.env.NEXT_PUBLIC_GEMINI_MODEL,
    GEMINI_ECONOMY_MODEL: process.env.NEXT_PUBLIC_GEMINI_ECONOMY_MODEL,
  };

  function estimateFor(targets) {
    return estimateBatch({
      exam,
      questions,
      pageCounts: targets.map((p) => p.exam_paper_pages.length),
      mode: exam.grading_mode || 'standard',
      env: clientEnv,
      measured: { outputByModel: measuredOut },
    });
  }

  async function handleModeChange(mode) {
    setError('');
    setNotice('');
    const { error: updErr } = await supabase.from('exams').update({ grading_mode: mode }).eq('id', examId);
    if (updErr) {
      setError(
        /grading_mode/.test(updErr.message)
          ? 'The database needs the Phase 7 update first. Run exam_schema_phase7.sql in Supabase, then try again.'
          : updErr.message
      );
      return;
    }
    setExam((prev) => ({ ...prev, grading_mode: mode }));
  }

  async function handleBudgetSave() {
    setError('');
    setNotice('');
    const raw = budgetInput.trim();
    const value = raw === '' ? null : Number(raw);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      setError('The spending limit must be a number, zero or more. Leave it empty for no limit.');
      return;
    }
    if (value === (exam.budget_usd === undefined ? null : exam.budget_usd === null ? null : Number(exam.budget_usd))) return;
    const { error: updErr } = await supabase.from('exams').update({ budget_usd: value }).eq('id', examId);
    if (updErr) {
      setError(
        /budget_usd/.test(updErr.message)
          ? 'The database needs the Phase 7 update first. Run exam_schema_phase7.sql in Supabase, then try again.'
          : updErr.message
      );
      return;
    }
    setExam((prev) => ({ ...prev, budget_usd: value }));
    setNotice(value === null ? 'Spending limit removed.' : `Spending limit set to ${formatUsd(value)}.`);
  }

  async function handleGradeAll() {
    const targets = papers.filter(isGradable);
    if (targets.length === 0) return;

    const estimate = estimateFor(targets);
    const mode = GRADING_MODES.find((m) => m.id === (exam.grading_mode || 'standard'));
    const limit = exam.budget_usd === null || exam.budget_usd === undefined ? null : Number(exam.budget_usd);

    const lines = [`Grade ${targets.length} script${targets.length === 1 ? '' : 's'} with AI now?`, '', `Mode: ${mode?.label || 'Standard'}`];
    if (estimate.known) {
      lines.push(
        `Estimated cost: about ${formatUsd(estimate.expected)} (most likely between ${formatUsd(estimate.low)} and ${formatUsd(estimate.high)}).`
      );
      if (estimate.escalateTo) lines.push(`This assumes about ${Math.round(estimate.escalationRate * 100)}% of scripts need the stronger model's second look.`);
    } else {
      lines.push('Cost estimate unavailable for this model.');
    }
    if (limit !== null) {
      lines.push(`Spending limit: ${formatUsd(limit)} (already spent ${formatUsd(usage.cost)}). Grading stops by itself at the limit.`);
      if (estimate.known && usage.cost + estimate.expected > limit) lines.push('The estimate is above your limit, so some scripts may not be graded.');
    }
    lines.push('', 'You can stop at any time.');
    if (!confirm(lines.join('\n'))) return;

    setError('');
    setNotice('');
    cancelRef.current = false;

    const ids = targets.map((p) => p.id);

    // Mark them as queued (in small groups, so the request stays short)
    for (let i = 0; i < ids.length; i += 50) {
      await supabase
        .from('exam_papers')
        .update({ status: 'queued' })
        .in('id', ids.slice(i, i + 50))
        .in('status', ['uploaded', 'failed']);
    }

    const queue = [...ids];
    const problems = [];
    let done = 0;
    let failed = 0;
    let skipped = 0;
    let escalated = 0;
    let totalCost = 0;
    let limitMessage = '';
    setGrading({ done: 0, total: ids.length, failed: 0 });

    async function worker() {
      while (queue.length > 0 && !cancelRef.current) {
        const id = queue.shift();
        try {
          const result = await callGradeApi(id, false);
          if (result.budgetReached) {
            // Out of budget: stop everyone. Scripts not yet graded stay queued, nothing is lost.
            skipped += 1;
            limitMessage = result.error;
            cancelRef.current = true;
          } else if (result.ok === false) {
            failed += 1;
            problems.push(result.error);
          } else if (result.skipped) {
            skipped += 1;
          } else {
            totalCost += Number(result.costUsd) || 0;
            if (result.escalated) escalated += 1;
          }
        } catch (err) {
          failed += 1;
          problems.push(err.message);
        }
        done += 1;
        setGrading({ done, total: ids.length, failed });
        if (done % 4 === 0) load(false);
      }
    }

    await Promise.all(Array.from({ length: Math.min(GRADING_CONCURRENCY, ids.length) }, worker));

    setGrading(null);
    const graded = done - failed - skipped;
    const notLeftBehind = queue.length;
    const parts = [`${graded} graded`];
    if (failed) parts.push(`${failed} failed`);
    if (escalated) parts.push(`${escalated} re-checked by the stronger model`);
    let message = `${parts.join(', ')}. Cost about ${formatUsd(totalCost)}${estimate.known ? ` (estimated ${formatUsd(estimate.expected)})` : ''}.`;
    if (limitMessage) message += ` ${limitMessage}`;
    else if (cancelRef.current && notLeftBehind > 0) message += ` Stopped early with ${notLeftBehind} left in the queue.`;
    setNotice(message);
    if (problems.length > 0) setError(`Some scripts failed: ${[...new Set(problems)].slice(0, 3).join(' | ')}`);
    await load(false);
  }

  async function handleRetry(paper) {
    setError('');
    setNotice('');
    setRetryingId(paper.id);
    try {
      const result = await callGradeApi(paper.id, true);
      if (result.ok === false) setError(result.error);
    } catch (err) {
      setError(err.message);
    }
    setRetryingId(null);
    await load(false);
  }

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

  const draftsWithPages = drafts.filter((d) => d.pages.length > 0).length;
  const missingStudents = students.filter((st) => !studentIdsWithScript.has(st.id));
  const addOpen = showAdd || papers.length === 0;
  const progress = computeProgress({ questionCount: questions.length, rosterCount: students.length, papers });
  const next = progress.next;
  const gradableScripts = papers.filter((p) => isGradable(p));
  const nextEstimate = next.kind === 'grade' ? estimateFor(gradableScripts) : null;
  const nextHint = nextEstimate?.known ? `${next.hint} Estimated cost about ${formatUsd(nextEstimate.expected)}.` : next.hint;
  const activeMode = exam.grading_mode || 'standard';
  const limit = exam.budget_usd === null || exam.budget_usd === undefined ? null : Number(exam.budget_usd);
  const settingsSummary = `${MODE_SHORT[activeMode]}, ${formatUsd(usage.cost)} spent${limit !== null ? ` of ${formatUsd(limit)}` : ''}`;

  const railLinks = {
    questions: `/marking/${examId}/edit`,
    scripts: '#scripts',
    grading: '#scripts',
    review: `/marking/${examId}/review`,
    export: `/marking/${examId}/review?export=1`,
  };

  function openAddPanel() {
    setShowAdd(true);
    setTimeout(() => document.getElementById('add-scripts')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }

  return (
    <div className="page-wide">
      <div className="breadcrumb">
        <Link href="/marking">Marking</Link> / {exam.title}
      </div>

      <div className="page-head">
        <div>
          <h1>{exam.title}</h1>
          <div className="meta">
            {exam.subject && <span>{exam.subject}</span>}
            {exam.class_label && <span>{exam.class_label}</span>}
            <span className="num">{questions.length} {questions.length === 1 ? 'question' : 'questions'}</span>
            <span className="num">{exam.total_marks} marks</span>
          </div>
        </div>
        <div className="page-head-actions">
          <Link href={`/marking/${examId}/edit`} className="btn btn-secondary btn-sm">
            Edit questions
          </Link>
        </div>
      </div>

      <Rail steps={progress.steps} links={railLinks} />

      {grading ? (
        <NextAction next={{ title: `Grading ${grading.done} of ${grading.total}`, hint: 'Keep this page open until it finishes. Results appear below as each script is done.' }}>
          <div style={{ flex: '1 1 260px', minWidth: 220 }}>
            <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={grading.total} aria-valuenow={grading.done}>
              <span style={{ width: `${Math.round((grading.done / grading.total) * 100)}%` }} />
            </div>
            {grading.failed > 0 && <p className="hint" style={{ margin: '6px 0 0 0' }}>{grading.failed} failed so far</p>}
          </div>
          <button type="button" className="btn-secondary" onClick={() => { cancelRef.current = true; }}>
            Stop after current scripts
          </button>
        </NextAction>
      ) : (
        <NextAction next={{ ...next, hint: nextHint }}>
          {next.kind === 'add' && (
            <button type="button" className="btn-lg" onClick={openAddPanel}>
              <Icon name="camera" size={20} />
              Add scripts
            </button>
          )}
          {next.kind === 'grade' && (
            <button type="button" className="btn-lg" onClick={handleGradeAll} disabled={!!uploading}>
              Grade {gradableScripts.length} {gradableScripts.length === 1 ? 'script' : 'scripts'}
            </button>
          )}
          {next.kind === 'review' && (
            <button type="button" className="btn-lg" onClick={() => router.push(`/marking/${examId}/review`)}>
              Start reviewing
              <Icon name="chevronRight" size={18} />
            </button>
          )}
          {next.kind === 'export' && (
            <button type="button" className="btn-lg" onClick={() => router.push(`/marking/${examId}/review?export=1`)}>
              <Icon name="download" size={18} />
              Export results
            </button>
          )}
          {next.kind === 'retry' && (
            <a href="#scripts" className="btn btn-lg">
              Show failed scripts
            </a>
          )}
        </NextAction>
      )}

      {error && (
        <p className="alert alert-error" role="alert" style={{ marginTop: 'var(--s-4)' }}>
          {error}
        </p>
      )}
      {notice && (
        <p className="alert alert-ok" role="status" style={{ marginTop: 'var(--s-4)' }}>
          {notice}
        </p>
      )}

      {/* ---------- scripts ---------- */}
      <section id="scripts" style={{ marginTop: 'var(--s-6)' }}>
        <div className="section-head">
          <div>
            <h2 style={{ margin: 0 }}>Scripts</h2>
            <p className="section-note num" style={{ margin: 0 }}>
              {papers.length} of {students.length} students have a script
            </p>
          </div>
          {papers.length > 0 && (
            <button type="button" className="btn-secondary" onClick={() => (addOpen ? setShowAdd(false) : openAddPanel())}>
              {addOpen ? 'Close' : <><Icon name="plus" size={18} /> Add scripts</>}
            </button>
          )}
        </div>

        {addOpen && (
          <div id="add-scripts" className="surface">
            <h3>Add scripts</h3>
            <p className="section-note">
              One card for each student. Photograph every page of that script, in order. On a phone, the camera opens straight away.
            </p>

            {drafts.map((draft, index) => (
              <div key={draft.key} className="draft">
                <div className="draft-head">
                  <h3 style={{ margin: 0 }}>Script {index + 1}</h3>
                  {(drafts.length > 1 || draft.pages.length > 0) && (
                    <button type="button" className="btn-quiet btn-sm" onClick={() => removeDraft(draft.key)}>
                      Clear
                    </button>
                  )}
                </div>

                {draft.pages.length > 0 && (
                  <div className="thumbs">
                    {draft.pages.map((page, i) => (
                      <div key={page.id} className="thumb">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={page.url} alt={`Page ${i + 1}`} />
                        <span className="thumb-n">{i + 1}</span>
                        <button type="button" className="thumb-x" aria-label={`Remove page ${i + 1}`} onClick={() => removePage(draft.key, page.id)}>
                          &times;
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ marginTop: draft.pages.length ? 0 : 'var(--s-3)' }}>
                  <PhotoButtons
                    addMore={draft.pages.length > 0}
                    disabled={preparingKey === draft.key || !!uploading}
                    onFiles={(files) => addFiles(draft.key, files)}
                  />
                  {preparingKey === draft.key && <p className="hint" style={{ margin: 'var(--s-2) 0 0 0' }}>Preparing photos...</p>}
                </div>

                <label htmlFor={`student-${draft.key}`}>
                  Whose script is this?
                  <span className="hint">Optional. If you leave it, the AI reads the name on the first page.</span>
                </label>
                <select id={`student-${draft.key}`} value={draft.studentId} onChange={(e) => setDraftStudent(draft.key, e.target.value)}>
                  <option value="">Let the AI read the name</option>
                  {studentsAvailableForDraft(draft.key).map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.full_name} ({st.reg_no})
                    </option>
                  ))}
                </select>
              </div>
            ))}

            <div style={{ display: 'flex', gap: 'var(--s-3)', alignItems: 'center', flexWrap: 'wrap', marginTop: 'var(--s-4)' }}>
              <button type="button" disabled={draftsWithPages === 0 || !!uploading || !!preparingKey} onClick={handleUploadAll}>
                <Icon name="upload" size={18} />
                {uploading
                  ? `Uploading ${uploading.done} of ${uploading.total}...`
                  : `Upload ${draftsWithPages > 0 ? draftsWithPages : ''} ${draftsWithPages === 1 ? 'script' : 'scripts'}`.replace('  ', ' ')}
              </button>
              <button type="button" className="btn-secondary" onClick={addDraft} disabled={!!uploading}>
                <Icon name="plus" size={18} />
                Another script
              </button>
            </div>
          </div>
        )}

        {papers.length > 0 && (
          <div className="rows">
            {papers.map((paper) => {
              const student = paper.student_id ? studentById[paper.student_id] : null;
              const thumb = thumbs[paper.exam_paper_pages[0]?.storage_path];
              const chip = STATUS_CHIP[paper.status] || STATUS_CHIP.uploaded;
              const pageCount = paper.exam_paper_pages.length;
              const pickable = students.filter((st) => !studentIdsWithScript.has(st.id) || st.id === paper.student_id);
              const hasScore = paper.ai_total !== null && paper.ai_total !== undefined;
              return (
                <div key={paper.id} className="row">
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="script-thumb" src={thumb} alt="First page of the script" />
                  ) : (
                    <span className="assignment-icon">
                      <Icon name="file" size={18} />
                    </span>
                  )}

                  <div className="row-main">
                    <p className="row-title">{student ? student.full_name : 'Not assigned to a student yet'}</p>
                    <div className="meta">
                      <span className="num">
                        {student
                          ? student.reg_no
                          : paper.detected_name || paper.detected_reg_no
                            ? `AI read: ${[paper.detected_name, paper.detected_reg_no].filter(Boolean).join(', ')}`
                            : 'The AI will read the name'}
                      </span>
                      <span className="num">{pageCount} {pageCount === 1 ? 'page' : 'pages'}</span>
                      {paper.escalated && <span>Re-checked by the stronger model</span>}
                    </div>
                    {paper.match_note && !student && <p className="unsure-note">{paper.match_note}</p>}
                    {paper.page_issues && <p className="unsure-note">Photo problem: {paper.page_issues}</p>}
                    {paper.status === 'failed' && paper.last_error && (
                      <p className="unsure-note" style={{ color: 'var(--red-ink)' }}>{paper.last_error}</p>
                    )}
                  </div>

                  <div className="row-actions">
                    <span className={`chip ${chip.cls}`}>
                      {paper.status === 'approved' && <Icon name="check" size={14} strokeWidth={3} />}
                      {chip.label}
                    </span>
                    {hasScore && (
                      <span className="num" aria-label={`Score ${paper.final_total ?? paper.ai_total} out of ${exam.total_marks}`}>
                        <strong>{paper.final_total ?? paper.ai_total}</strong> / {exam.total_marks}
                      </span>
                    )}
                    {!student && (
                      <select
                        aria-label="Assign this script to a student"
                        value=""
                        onChange={(e) => handleAssign(paper.id, e.target.value)}
                        style={{ width: 210, minHeight: 36, padding: '4px 34px 4px 10px', fontSize: '0.875rem' }}
                      >
                        <option value="">Choose a student...</option>
                        {pickable.map((st) => (
                          <option key={st.id} value={st.id}>
                            {st.full_name} ({st.reg_no})
                          </option>
                        ))}
                      </select>
                    )}
                    {paper.status === 'failed' && (
                      <button type="button" className="btn-secondary btn-sm" disabled={!!grading || retryingId === paper.id} onClick={() => handleRetry(paper)}>
                        {retryingId === paper.id ? 'Retrying...' : 'Retry'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-quiet btn-sm is-danger"
                      style={{ color: 'var(--ink-3)' }}
                      disabled={paper.status === 'grading' || !!grading}
                      onClick={() => handleDeletePaper(paper)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {missingStudents.length > 0 && papers.length > 0 && (
          <details className="disclosure" style={{ marginTop: 'var(--s-4)' }}>
            <summary>
              {missingStudents.length} {missingStudents.length === 1 ? 'student has' : 'students have'} no script yet
            </summary>
            <ul className="plainlist num">
              {missingStudents.map((st) => (
                <li key={st.id}>
                  <span>{st.full_name}</span>
                  <span>{st.reg_no}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {/* ---------- settings ---------- */}
      <details className="disclosure surface" style={{ marginTop: 'var(--s-6)' }}>
        <summary>
          <span>Grading settings and cost</span>
          <span className="disclosure-sub num">{settingsSummary}</span>
        </summary>

        <label htmlFor="grading-mode" style={{ marginTop: 'var(--s-4)' }}>Quality and cost</label>
        <select id="grading-mode" value={activeMode} onChange={(e) => handleModeChange(e.target.value)} disabled={!!grading}>
          {GRADING_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <p className="section-note" style={{ margin: '6px 0 0 0' }}>
          {GRADING_MODES.find((m) => m.id === activeMode)?.blurb}
        </p>

        <label htmlFor="budget">Spending limit for this job (US dollars, optional)</label>
        <input
          id="budget"
          type="number"
          min="0"
          step="0.01"
          placeholder="No limit"
          value={budgetInput}
          onChange={(e) => setBudgetInput(e.target.value)}
          onBlur={handleBudgetSave}
          style={{ maxWidth: 220 }}
        />
        <p className="section-note" style={{ margin: '6px 0 0 0' }}>
          Grading stops by itself once the logged cost reaches this amount. These are estimates, so check Google&apos;s billing page for the
          exact amount.
        </p>
      </details>
    </div>
  );
}
