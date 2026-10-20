'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '../../../lib/supabaseClient';
import { compressImage, DATA_SAVER } from '../../../lib/imageCompress';
import { withRetry, isTransient } from '../../../lib/netRetry';
import { uploadScript } from '../../../lib/resumableUpload';
import { runGradingQueue } from '../../../lib/gradeQueue';
import { displayReg, studentLabel } from '../../../lib/studentIds';
import { saveDrafts, loadDrafts } from '../../../lib/draftStore';
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

let draftCounter = 0;
function newDraft() {
  draftCounter += 1;
  return { key: `draft-${draftCounter}`, pages: [], studentId: '', paperId: '', doneIds: [] };
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

async function callGradeApi(paperId, force = false) {
  // A dropped connection is retried once. Marking is safe to repeat: a script that was already marked is skipped.
  return withRetry(
    async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      const res = await fetch('/api/marking/grade-paper', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ paperId, force }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || `Request failed (${res.status}).`);
        err.status = res.status;
        throw err;
      }
      return data;
    },
    { attempts: 2, baseMs: 2000 }
  );
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
  const [showAdd, setShowAdd] = useState(false);
  const [dataSaver, setDataSaver] = useState(false);
  const [online, setOnline] = useState(true);
  const [saveWarning, setSaveWarning] = useState('');
  const [retryNote, setRetryNote] = useState('');
  const stopUploadRef = useRef(false);
  const restoredRef = useRef(false);
  const persistOkRef = useRef(true);
  const uploadingRef = useRef(null);
  const cancelRef = useRef(false);
  const gradingRef = useRef(null);

  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  gradingRef.current = grading;
  uploadingRef.current = uploading;

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId]);

  // Know when the phone goes offline, so we can say so and wait instead of failing
  useEffect(() => {
    const update = () => setOnline(typeof navigator === 'undefined' || navigator.onLine !== false);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  // Bring back photos that were waiting to upload (after a refresh, a closed tab or a phone restart)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = await loadDrafts(examId);
        if (!cancelled && saved.length > 0) {
          setDrafts(
            saved.map((r) => ({
              ...newDraft(),
              studentId: r.studentId,
              paperId: r.paperId,
              doneIds: r.doneIds,
              pages: r.pages.map((p) => ({ id: p.id, blob: p.blob, url: URL.createObjectURL(p.blob) })),
            }))
          );
          setShowAdd(true);
          setNotice(`Restored ${saved.length} script${saved.length === 1 ? '' : 's'} from this phone. They have not been uploaded yet.`);
        }
      } catch {
        // This phone cannot save photos; everything still works for this visit.
      }
      if (!cancelled) restoredRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [examId]);

  // Save the photos on the phone a moment after every change
  useEffect(() => {
    if (!restoredRef.current) return undefined;
    const withPhotos = drafts.filter((d) => d.pages.length > 0);
    const timer = setTimeout(async () => {
      try {
        await saveDrafts(examId, withPhotos);
        persistOkRef.current = true;
        setSaveWarning('');
      } catch {
        persistOkRef.current = withPhotos.length === 0;
        if (withPhotos.length > 0) {
          setSaveWarning('These photos could not be saved on this phone (its storage may be full). Keep this page open until they are uploaded.');
        }
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [drafts, examId]);

  // Warn before leaving the page if photos are uploading, grading is running, or photos could not be saved
  useEffect(() => {
    function onBeforeUnload(e) {
      if ((draftsRef.current.some((d) => d.pages.length > 0) && !persistOkRef.current) || gradingRef.current || uploadingRef.current) {
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
    const gone = draftsRef.current.find((d) => d.key === key);
    if (gone?.paperId && gone.doneIds?.length > 0) {
      const paths = gone.doneIds.map((id) => `${userId}/${examId}/${gone.paperId}/${id}.jpg`);
      supabase.storage.from(BUCKET).remove(paths).catch(() => {});
    }
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
        const blob = await compressImage(file, dataSaver ? DATA_SAVER : undefined);
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
    await uploadScript({
      supabase,
      bucket: BUCKET,
      userId,
      examId,
      draft,
      retry: { onRetry: ({ attempt }) => setRetryNote(`The connection is weak. Trying again (attempt ${attempt + 1})...`) },
      shouldStop: () => stopUploadRef.current,
      onPaperId: (paperId) => setDrafts((prev) => prev.map((d) => (d.key === draft.key ? { ...d, paperId } : d))),
      onPageDone: (pageId) =>
        setDrafts((prev) => prev.map((d) => (d.key === draft.key ? { ...d, doneIds: [...(d.doneIds || []), pageId] } : d))),
      onProgress: ({ page, pages }) => {
        setRetryNote('');
        setUploading((u) => (u ? { ...u, page, pages } : u));
      },
    });
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

    stopUploadRef.current = false;
    setRetryNote('');
    setUploading({ done: 0, total: ready.length, page: 0, pages: 0 });
    const succeeded = new Set();
    const failures = [];
    let stopped = false;

    for (let i = 0; i < ready.length; i++) {
      if (stopUploadRef.current) {
        stopped = true;
        break;
      }
      try {
        await uploadOneScript(ready[i]);
        succeeded.add(ready[i].key);
      } catch (err) {
        if (err.stopped) {
          stopped = true;
          break;
        }
        const label = `Script ${drafts.findIndex((d) => d.key === ready[i].key) + 1}`;
        failures.push(
          isTransient(err)
            ? `${label}: the connection kept dropping. Your photos are saved on this phone. Tap Upload again when the signal is better.`
            : `${label}: ${err.message}`
        );
      }
      setUploading({ done: i + 1, total: ready.length, page: 0, pages: 0 });
    }

    // Keep only the scripts that failed, so the teacher can retry them
    setDrafts((prev) => {
      prev.filter((d) => succeeded.has(d.key)).forEach((d) => d.pages.forEach((p) => URL.revokeObjectURL(p.url)));
      const remaining = prev.filter((d) => !succeeded.has(d.key));
      return remaining.length > 0 ? remaining : [newDraft()];
    });

    setUploading(null);
    setRetryNote('');
    if (succeeded.size > 0) setNotice(`${succeeded.size} script${succeeded.size === 1 ? '' : 's'} uploaded.`);
    if (stopped) setNotice((n) => `${n ? `${n} ` : ''}Upload stopped. The rest are saved on this phone.`);
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
  async function handleGradeAll() {
    const targets = papers.filter(isGradable);
    if (targets.length === 0) return;

    const lines = [`Grade ${targets.length} script${targets.length === 1 ? '' : 's'} with AI now?`, '', 'You can stop at any time.'];
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

    setGrading({ done: 0, total: ids.length, failed: 0, pause: 0 });

    // If the AI service says it is busy, the queue waits as long as it asks and carries on by itself.
    const summary = await runGradingQueue({
      ids,
      callGrade: (id) => callGradeApi(id, false),
      concurrency: GRADING_CONCURRENCY,
      shouldStop: () => cancelRef.current,
      onProgress: (st) => {
        setGrading((g) => ({ done: st.done, total: ids.length, failed: st.failed, pause: g?.pause || 0 }));
        if (st.done % 4 === 0) load(false);
      },
      onPause: (secs) => setGrading((g) => (g ? { ...g, pause: secs } : g)),
    });

    setGrading(null);
    const graded = summary.done - summary.failed - summary.skipped;
    const parts = [`${graded} graded`];
    if (summary.failed) parts.push(`${summary.failed} failed`);
    if (summary.escalated) parts.push(`${summary.escalated} re-checked by the stronger model`);
    let message = `${parts.join(', ')}.`;
    if (summary.limitMessage) {
      message += ` ${summary.limitMessage}`;
      if (summary.remaining > 0) message += ` ${summary.remaining} ${summary.remaining === 1 ? 'script is' : 'scripts are'} still queued.`;
    } else if (summary.stopped && summary.remaining > 0) {
      message += ` Stopped early with ${summary.remaining} left in the queue.`;
    }
    setNotice(message);
    if (summary.problems.length > 0) setError(`Some scripts failed: ${[...new Set(summary.problems)].slice(0, 3).join(' | ')}`);
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
  const photoCount = drafts.reduce((n, d) => n + d.pages.length, 0);
  const photoMb = drafts.reduce((n, d) => n + d.pages.reduce((m, p) => m + (p.blob?.size || 0), 0), 0) / (1024 * 1024);
  const missingStudents = students.filter((st) => !studentIdsWithScript.has(st.id));
  const addOpen = showAdd || papers.length === 0;
  const progress = computeProgress({ questionCount: questions.length, rosterCount: students.length, papers });
  const next = progress.next;
  const gradableScripts = papers.filter((p) => isGradable(p));

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
            {grading.pause > 0 && (
              <p className="hint" role="status" style={{ margin: '6px 0 0 0' }}>
                The AI service is busy. Waiting {grading.pause} {grading.pause === 1 ? 'second' : 'seconds'}, then continuing by itself. Nothing is lost.
              </p>
            )}
          </div>
          <button type="button" className="btn-secondary" onClick={() => { cancelRef.current = true; }}>
            Stop after current scripts
          </button>
        </NextAction>
      ) : (
        <NextAction next={next}>
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
            {!online && (
              <p className="alert alert-warn" role="status">
                You are offline. Your photos are saved on this phone, and uploading continues when the connection is back.
              </p>
            )}
            {saveWarning && (
              <p className="alert alert-warn" role="status">
                {saveWarning}
              </p>
            )}
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
                      {studentLabel(st)}
                    </option>
                  ))}
                </select>
              </div>
            ))}

            {photoCount > 0 && (
              <p className="section-note" style={{ margin: 'var(--s-4) 0 0 0' }}>
                Ready to upload: <strong className="num">{draftsWithPages}</strong> {draftsWithPages === 1 ? 'script' : 'scripts'},{' '}
                <strong className="num">{photoCount}</strong> {photoCount === 1 ? 'photo' : 'photos'}, about{' '}
                <strong className="num">{photoMb < 10 ? photoMb.toFixed(1) : Math.round(photoMb)} MB</strong> of data.
                {retryNote ? ` ${retryNote}` : ''}
              </p>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 'var(--s-3) 0 0 0', fontWeight: 400 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={dataSaver} onChange={(e) => setDataSaver(e.target.checked)} disabled={!!uploading} />
              <span>
                Data saver: smaller photos for slow or expensive data
                <span className="hint"> Affects photos you add from now on. Very small handwriting may be harder for the AI to read.</span>
              </span>
            </label>

            <div style={{ display: 'flex', gap: 'var(--s-3)', alignItems: 'center', flexWrap: 'wrap', marginTop: 'var(--s-4)' }}>
              <button type="button" disabled={draftsWithPages === 0 || !!uploading || !!preparingKey} onClick={handleUploadAll}>
                <Icon name="upload" size={18} />
                {uploading
                  ? `Uploading script ${Math.min(uploading.done + 1, uploading.total)} of ${uploading.total}${uploading.pages ? `, photo ${uploading.page} of ${uploading.pages}` : ''}...`
                  : `Upload ${draftsWithPages > 0 ? draftsWithPages : ''} ${draftsWithPages === 1 ? 'script' : 'scripts'}`.replace('  ', ' ')}
              </button>
              <button type="button" className="btn-secondary" onClick={addDraft} disabled={!!uploading}>
                <Icon name="plus" size={18} />
                Another script
              </button>
              {uploading && (
                <button type="button" className="btn-quiet" onClick={() => (stopUploadRef.current = true)}>
                  Stop
                </button>
              )}
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
                          ? displayReg(student.reg_no) || 'Student assigned'
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
                            {studentLabel(st)}
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
                  <span>{displayReg(st.reg_no)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

    </div>
  );
}
