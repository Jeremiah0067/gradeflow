'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '../../../lib/supabaseClient';
import { compressImage } from '../../../lib/imageCompress';

const BUCKET = 'exam-papers';
const MAX_PAGES_PER_SCRIPT = 20;
const GRADING_CONCURRENCY = 3; // how many scripts are graded at the same time
const MAX_ATTEMPTS = 3; // keep in step with lib/gradeExamPaper.js
const STALE_GRADING_MS = 10 * 60 * 1000;
const smallBtn = { width: 'auto', margin: 0, padding: '6px 14px', fontSize: 13 };

const STATUS_LABEL = {
  uploaded: 'Uploaded',
  queued: 'Queued',
  grading: 'Grading',
  needs_review: 'Graded, needs your review',
  approved: 'Approved',
  flagged: 'Graded, check carefully',
  failed: 'Failed',
};

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
      .select('est_cost_usd')
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

// Scripts that can be sent to the AI now
function isGradable(paper) {
  if (['uploaded', 'queued'].includes(paper.status)) return true;
  if (paper.status === 'failed') return (paper.grading_attempts || 0) < MAX_ATTEMPTS;
  if (paper.status === 'grading' && paper.grading_started_at) {
    return Date.now() - new Date(paper.grading_started_at).getTime() > STALE_GRADING_MS;
  }
  return false;
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
  async function handleGradeAll() {
    const targets = papers.filter(isGradable);
    if (targets.length === 0) return;

    const ok = confirm(
      `Grade ${targets.length} script${targets.length === 1 ? '' : 's'} with AI now?\n\nEach script is one AI call. You can stop at any time.`
    );
    if (!ok) return;

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
    setGrading({ done: 0, total: ids.length, failed: 0 });

    async function worker() {
      while (queue.length > 0 && !cancelRef.current) {
        const id = queue.shift();
        try {
          const result = await callGradeApi(id, false);
          if (result.ok === false) {
            failed += 1;
            problems.push(result.error);
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
    const stopped = cancelRef.current && queue.length > 0;
    setNotice(
      `${done - failed} graded${failed ? `, ${failed} failed` : ''}${stopped ? `. Stopped early with ${queue.length} left in the queue` : ''}.`
    );
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
  const gradableCount = papers.filter(isGradable).length;
  const visibleStudents = showMissingOnly ? students.filter((s) => !studentIdsWithScript.has(s.id)) : students;

  return (
    <div className="page-wide" style={{ maxWidth: 980 }}>
      <div className="breadcrumb">
        <Link href="/dashboard">Dashboard</Link> / <Link href="/marking">Marking</Link> / {exam.title}
      </div>

      <div className="main-header" style={{ marginBottom: 16 }}>
        <div>
          <h1>{exam.title}</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            {[exam.subject, exam.class_label].filter(Boolean).join(' · ') || 'Marking job'} · {questions.length} question
            {questions.length === 1 ? '' : 's'} · {exam.total_marks} marks
          </p>
        </div>
        {grading ? (
          <button
            type="button"
            className="btn-secondary"
            style={{ width: 'auto', marginTop: 0 }}
            onClick={() => {
              cancelRef.current = true;
            }}
          >
            Stop after current scripts
          </button>
        ) : (
          <button
            type="button"
            style={{ width: 'auto', marginTop: 0 }}
            disabled={gradableCount === 0 || !!uploading}
            onClick={handleGradeAll}
          >
            {gradableCount === 0
              ? 'Nothing to grade'
              : `Grade ${gradableCount} script${gradableCount === 1 ? '' : 's'} with AI`}
          </button>
        )}
      </div>

      {grading && (
        <div className="surface" style={{ marginBottom: 16 }}>
          <p className="assignment-row-title">
            Grading {grading.done} of {grading.total}
            {grading.failed > 0 && ` (${grading.failed} failed)`}
          </p>
          <div style={{ height: 8, background: 'var(--gf-border)', borderRadius: 4, overflow: 'hidden', marginTop: 8 }}>
            <div
              style={{
                height: '100%',
                width: `${Math.round((grading.done / grading.total) * 100)}%`,
                background: 'var(--gf-blue)',
                transition: 'width 0.3s',
              }}
            />
          </div>
          <p className="assignment-row-meta" style={{ marginTop: 8 }}>
            Keep this page open until it finishes. Results appear below as each script is graded.
          </p>
        </div>
      )}

      {error && <p className="error-text">{error}</p>}
      {notice && <p style={{ color: 'var(--gf-success-text)', fontSize: 13 }}>{notice}</p>}

      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-icon" style={{ background: '#e3edfd' }}>🎓</div>
          <div>
            <p className="stat-value">{students.length}</p>
            <p className="stat-label">Students on roster</p>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon" style={{ background: '#e6f4ea' }}>📄</div>
          <div>
            <p className="stat-value">{papers.length}</p>
            <p className="stat-label">Scripts uploaded</p>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon" style={{ background: '#fdf0da' }}>❓</div>
          <div>
            <p className="stat-value">{unmatchedCount}</p>
            <p className="stat-label">Not yet assigned to a student</p>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon" style={{ background: '#efe7fb' }}>💰</div>
          <div>
            <p className="stat-value">${usage.cost.toFixed(4)}</p>
            <p className="stat-label">AI cost so far ({usage.calls} call{usage.calls === 1 ? '' : 's'}, estimate)</p>
          </div>
        </div>
      </div>

      <div className="surface">
        <p className="section-heading">Add scripts</p>
        <p className="subtitle" style={{ marginBottom: 14 }}>
          One card per student. Add every page of that student&apos;s script, in order. You can choose the student now, or
          leave it and the AI will read the name on the first page. On a phone, the photo box lets you take a picture
          or pick from your gallery.
        </p>

        {drafts.map((draft, index) => (
          <div
            key={draft.key}
            style={{ border: '1px solid var(--gf-border)', borderRadius: 8, padding: 14, marginBottom: 12 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <p className="assignment-row-title">Script {index + 1}</p>
              {(drafts.length > 1 || draft.pages.length > 0) && (
                <button type="button" className="btn-secondary" style={smallBtn} onClick={() => removeDraft(draft.key)}>
                  Clear
                </button>
              )}
            </div>

            {draft.pages.length > 0 && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '12px 0' }}>
                {draft.pages.map((page, i) => (
                  <div key={page.id} style={{ position: 'relative' }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={page.url}
                      alt={`Page ${i + 1}`}
                      style={{ width: 84, height: 112, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--gf-border)' }}
                    />
                    <span
                      style={{
                        position: 'absolute', left: 4, bottom: 4, background: 'rgba(0,0,0,0.65)', color: 'white',
                        fontSize: 11, borderRadius: 4, padding: '1px 6px',
                      }}
                    >
                      {i + 1}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove page ${i + 1}`}
                      onClick={() => removePage(draft.key, page.id)}
                      style={{
                        position: 'absolute', top: -6, right: -6, width: 22, height: 22, padding: 0, margin: 0,
                        borderRadius: '50%', background: 'var(--gf-danger)', fontSize: 13, lineHeight: '22px',
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            <label>{draft.pages.length === 0 ? 'Add page photos' : 'Add more pages'}</label>
            <input
              type="file"
              accept="image/*"
              multiple
              disabled={preparingKey === draft.key || !!uploading}
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                e.target.value = '';
                addFiles(draft.key, files);
              }}
            />
            {preparingKey === draft.key && <p className="assignment-row-meta">Preparing photos...</p>}

            <label>Student (optional)</label>
            <select value={draft.studentId} onChange={(e) => setDraftStudent(draft.key, e.target.value)}>
              <option value="">Not sure. Let the AI read the name</option>
              {studentsAvailableForDraft(draft.key).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.full_name} ({s.reg_no})
                </option>
              ))}
            </select>
          </div>
        ))}

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="btn-secondary" style={smallBtn} onClick={addDraft} disabled={!!uploading}>
            + Another script
          </button>
          <button
            type="button"
            style={{ width: 'auto', margin: 0 }}
            disabled={draftsWithPages === 0 || !!uploading || !!preparingKey}
            onClick={handleUploadAll}
          >
            {uploading
              ? `Uploading ${uploading.done} of ${uploading.total}...`
              : `Upload ${draftsWithPages || ''} script${draftsWithPages === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>

      <div className="surface">
        <p className="section-heading">Uploaded scripts ({papers.length})</p>

        {papers.length === 0 ? (
          <p className="subtitle" style={{ marginBottom: 0 }}>Nothing uploaded yet.</p>
        ) : (
          papers.map((paper) => {
            const student = paper.student_id ? studentById[paper.student_id] : null;
            const thumb = thumbs[paper.exam_paper_pages[0]?.storage_path];
            const pickable = students.filter((s) => !studentIdsWithScript.has(s.id) || s.id === paper.student_id);
            return (
              <div
                key={paper.id}
                style={{
                  display: 'flex', gap: 14, alignItems: 'center', padding: '10px 0',
                  borderBottom: '1px solid var(--gf-border)', flexWrap: 'wrap',
                }}
              >
                {thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={thumb}
                    alt="First page"
                    style={{ width: 54, height: 72, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--gf-border)' }}
                  />
                ) : (
                  <div className="assignment-icon">📄</div>
                )}

                <div style={{ flex: 1, minWidth: 200 }}>
                  <p className="assignment-row-title">
                    {student ? student.full_name : 'Not assigned yet'}
                    <span className="tag">{STATUS_LABEL[paper.status] || paper.status}</span>
                  </p>
                  <p className="assignment-row-meta">
                    {student
                      ? student.reg_no
                      : paper.detected_name || paper.detected_reg_no
                        ? `AI read: ${[paper.detected_name, paper.detected_reg_no].filter(Boolean).join(' / ')}`
                        : 'The AI will read the name on the first page'}{' '}
                    · {paper.exam_paper_pages.length} page{paper.exam_paper_pages.length === 1 ? '' : 's'}
                    {paper.ai_total !== null && paper.ai_total !== undefined && ` · AI score ${paper.ai_total}/${exam.total_marks}`}
                  </p>
                  {paper.match_note && !student && <p className="assignment-row-meta">{paper.match_note}</p>}
                  {paper.page_issues && <p className="assignment-row-meta">Photo issue: {paper.page_issues}</p>}
                  {paper.status === 'failed' && paper.last_error && (
                    <p className="error-text" style={{ margin: '4px 0 0 0' }}>{paper.last_error}</p>
                  )}
                </div>

                <select
                  value={paper.student_id || ''}
                  onChange={(e) => handleAssign(paper.id, e.target.value)}
                  style={{ width: 230 }}
                >
                  <option value="">Not assigned</option>
                  {pickable.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.full_name} ({s.reg_no})
                    </option>
                  ))}
                </select>

                {paper.status === 'failed' && (
                  <button
                    type="button"
                    className="btn-secondary"
                    style={smallBtn}
                    disabled={!!grading || retryingId === paper.id}
                    onClick={() => handleRetry(paper)}
                  >
                    {retryingId === paper.id ? 'Retrying...' : 'Retry'}
                  </button>
                )}
                <button
                  type="button"
                  className="btn-danger"
                  style={smallBtn}
                  disabled={paper.status === 'grading' || !!grading}
                  onClick={() => handleDeletePaper(paper)}
                >
                  Delete
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="surface">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <p className="section-heading" style={{ margin: 0 }}>
            Roster ({matchedCount} of {students.length} have a script)
          </p>
          <button type="button" className="btn-secondary" style={smallBtn} onClick={() => setShowMissingOnly((v) => !v)}>
            {showMissingOnly ? 'Show everyone' : 'Show missing only'}
          </button>
        </div>

        <div style={{ maxHeight: 340, overflowY: 'auto', border: '1px solid var(--gf-border)', borderRadius: 8 }}>
          {visibleStudents.length === 0 ? (
            <p style={{ padding: 12, margin: 0, fontSize: 13, color: 'var(--gf-text-secondary)' }}>
              Every student on the roster has a script.
            </p>
          ) : (
            visibleStudents.map((s) => (
              <div
                key={s.id}
                style={{
                  display: 'flex', gap: 16, padding: '8px 12px', fontSize: 13,
                  borderBottom: '1px solid var(--gf-border)', alignItems: 'center',
                }}
              >
                <span style={{ width: 150, color: 'var(--gf-text-secondary)' }}>{s.reg_no}</span>
                <span style={{ flex: 1 }}>{s.full_name}</span>
                <span style={{ color: studentIdsWithScript.has(s.id) ? 'var(--gf-success-text)' : 'var(--gf-warning-text)' }}>
                  {studentIdsWithScript.has(s.id) ? '✓ Script uploaded' : 'No script yet'}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
