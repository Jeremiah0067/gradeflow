'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../../../lib/supabaseClient';
import { buildMarkingReports, toCsv, pctText } from '../../../lib/markingReports';

const BRAND_KEY = 'gf-report-brand'; // same key as the class report cards, so branding is set once
const DEFAULT_BRAND = { school: '', term: '', accent: '#2340b4', logo: '' };

// Supabase returns at most 1000 rows per request, so read a long list a page at a time.
async function fetchPaged(makeQuery) {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await makeQuery().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

async function fetchChunks(ids, size, makeQuery) {
  const rows = [];
  for (let i = 0; i < ids.length; i += size) {
    rows.push(...(await fetchPaged(() => makeQuery(ids.slice(i, i + size)))));
  }
  return rows;
}

function fileToLogo(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, 240 / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function Header({ brand, subtitle, dateText }) {
  return (
    <header className="report-head">
      <div className="report-brand">
        {brand.logo && <img src={brand.logo} alt="" className="report-logo" />}
        <div>
          <p className="report-school">{brand.school || 'Your school name'}</p>
          <p className="report-sub">
            {subtitle}
            {brand.term ? ` · ${brand.term}` : ''}
          </p>
        </div>
      </div>
      <p className="report-date">{dateText}</p>
    </header>
  );
}

function ReportCard({ s, brand, teacherName, dateText, comment, onComment, showPosition }) {
  return (
    <article className="report-page" style={{ '--accent': brand.accent }}>
      <Header brand={brand} subtitle="Student report card" dateText={dateText} />

      <div className="report-meta">
        <div><span>Student</span><strong>{s.name || '—'}</strong></div>
        <div><span>Reg. number</span><strong>{s.regNo || '—'}</strong></div>
        <div><span>Class</span><strong>{s.classLabel || '—'}</strong></div>
        <div><span>Teacher</span><strong>{teacherName || '—'}</strong></div>
      </div>

      <div className="report-summary">
        <div><span>Overall</span><strong>{pctText(s.overallPct)}</strong></div>
        <div><span>Total marks</span><strong>{s.totalScore} / {s.totalMax}</strong></div>
        {showPosition && <div><span>Position in class</span><strong>{s.positionText}</strong></div>}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="report-table">
          <thead>
            <tr>
              <th>Subject</th>
              <th>Score</th>
              <th>Percent</th>
              {showPosition && <th>Class average</th>}
            </tr>
          </thead>
          <tbody>
            {s.rows.map((r) => (
              <tr key={r.paperId}>
                <td>
                  {r.subject}
                  {r.title !== r.subject && <div className="report-sub-line">{r.title}</div>}
                </td>
                <td className="num">{r.score} / {r.total}</td>
                <td className="num">{pctText(r.pct)}</td>
                {showPosition && <td className="num">{pctText(r.classAvgPct)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="report-comment">
        <span>Teacher&apos;s comment</span>
        <textarea className="no-print" rows={3} placeholder="Write a short comment for this student (optional)" value={comment} onChange={(e) => onComment(e.target.value)} />
        {comment.trim() && <p className="print-only">{comment}</p>}
      </div>

      <footer className="report-sign">
        <div>Teacher&apos;s signature</div>
        <div>Parent / guardian signature</div>
      </footer>
    </article>
  );
}

function Analysis({ s, brand, dateText, onSaveRec }) {
  return (
    <article className="report-page" style={{ '--accent': brand.accent }}>
      <Header brand={brand} subtitle="Subject analysis and recommendations" dateText={dateText} />

      <div className="report-meta">
        <div><span>Student</span><strong>{s.name || '—'}</strong></div>
        <div><span>Reg. number</span><strong>{s.regNo || '—'}</strong></div>
        <div><span>Class</span><strong>{s.classLabel || '—'}</strong></div>
      </div>

      {s.rows.map((r) => (
        <section key={r.paperId} className="analysis-block">
          <div className="analysis-head">
            <strong>{r.subject}{r.title !== r.subject ? ` · ${r.title}` : ''}</strong>
            <span className="num">{r.score} / {r.total} · {pctText(r.pct)}</span>
          </div>
          {r.strong.length > 0 && (
            <p className="analysis-line"><b>Doing well:</b> {r.strong.map((q) => `Question ${q.label} (${q.marks}/${q.max})`).join(', ')}</p>
          )}
          {r.weak.length > 0 && (
            <p className="analysis-line"><b>Needs more work:</b> {r.weak.map((q) => `Question ${q.label} (${q.marks}/${q.max})`).join(', ')}</p>
          )}
          <div className="analysis-rec">
            <span>Recommendation</span>
            <textarea
              className="no-print"
              rows={3}
              defaultValue={r.recommendation}
              key={`${r.paperId}-${r.recommendation}`}
              placeholder="No recommendation yet. Use Write recommendations above, or type your own."
              onBlur={(e) => e.target.value.trim() !== r.recommendation.trim() && onSaveRec(r.paperId, e.target.value)}
            />
            {r.recommendation.trim() && <p className="print-only">{r.recommendation}</p>}
          </div>
        </section>
      ))}
    </article>
  );
}

export default function MarkingReportsPage() {
  const router = useRouter();
  const stopRef = useRef(false);
  const stopCRef = useRef(false);
  const commentsRef = useRef({});

  const [teacherName, setTeacherName] = useState('');
  const [exams, setExams] = useState([]);
  const [classFilter, setClassFilter] = useState('all');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [raw, setRaw] = useState(null);
  const [building, setBuilding] = useState(false);
  const [brand, setBrand] = useState(DEFAULT_BRAND);
  const [comments, setComments] = useState({});
  const [genC, setGenC] = useState({ running: false, done: 0, total: 0 });
  const [publishing, setPublishing] = useState(false);
  const [showPosition, setShowPosition] = useState(true);
  const [mode, setMode] = useState('card');
  const [selectedStudent, setSelectedStudent] = useState('all');
  const [gen, setGen] = useState({ running: false, done: 0, total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(BRAND_KEY) || 'null');
      if (saved) setBrand({ ...DEFAULT_BRAND, ...saved });
    } catch {
      // Storage can be unavailable; the defaults still work.
    }
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateBrand(patch) {
    const next = { ...brand, ...patch };
    setBrand(next);
    try {
      localStorage.setItem(BRAND_KEY, JSON.stringify(next));
    } catch {
      setNotice('Your branding could not be saved on this browser, but it will still print.');
    }
  }

  async function handleLogo(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      updateBrand({ logo: await fileToLogo(file) });
    } catch {
      setError('That image could not be read. Try a PNG or JPG file.');
    }
  }

  async function init() {
    const { data: sessionData } = await supabase.auth.getSession();
    const session = sessionData?.session;
    if (!session) {
      router.push('/login');
      return;
    }
    const { data: profile } = await supabase.from('users').select('name, role').eq('id', session.user.id).single();
    if (profile?.role !== 'teacher') {
      router.push('/dashboard');
      return;
    }
    setTeacherName(profile.name || '');

    const { data, error: examErr } = await supabase
      .from('exams')
      .select('id, title, subject, class_label, total_marks')
      .order('created_at', { ascending: false });
    if (examErr) setError(examErr.message);
    setExams(data || []);
    setLoading(false);
  }

  const classes = useMemo(() => [...new Set(exams.map((e) => e.class_label).filter(Boolean))].sort(), [exams]);
  const shownExams = exams.filter((e) => classFilter === 'all' || e.class_label === classFilter);

  function toggleExam(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function build() {
    const ids = exams.filter((e) => selectedIds.has(e.id)).map((e) => e.id);
    if (ids.length === 0) return;
    setBuilding(true);
    setError('');
    setNotice('');
    setSelectedStudent('all');
    try {
      const students = await fetchChunks(ids, 20, (c) => supabase.from('exam_students').select('id, exam_id, reg_no, full_name').in('exam_id', c).order('id'));
      const questions = await fetchChunks(ids, 20, (c) => supabase.from('exam_questions').select('id, exam_id, label, max_marks, position').in('exam_id', c).order('id'));
      const papers = await fetchChunks(ids, 20, (c) =>
        supabase.from('exam_papers').select('id, exam_id, student_id, status, final_total, detected_name, detected_reg_no').in('exam_id', c).eq('status', 'approved').order('id')
      );
      const paperIds = papers.map((p) => p.id);
      const scores = await fetchChunks(paperIds, 40, (c) => supabase.from('exam_scores').select('id, paper_id, question_id, final_marks').in('paper_id', c).order('id'));
      const recommendations = await fetchChunks(paperIds, 100, (c) => supabase.from('exam_paper_recommendations').select('paper_id, text').in('paper_id', c).order('paper_id'));
      setRaw({ exams: exams.filter((e) => selectedIds.has(e.id)), students, questions, papers, scores, recommendations });
    } catch (err) {
      setError(err.message);
    }
    setBuilding(false);
  }

  const report = useMemo(() => (raw ? buildMarkingReports(raw) : null), [raw]);
  const students = report?.students || [];
  const visible = selectedStudent === 'all' ? students : students.filter((s) => s.key === selectedStudent);
  const missingRecs = report ? students.flatMap((s) => s.rows.filter((r) => !r.recommendation).map((r) => r.paperId)) : [];
  const dateText = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  function setRec(paperId, text) {
    setRaw((prev) => ({
      ...prev,
      recommendations: [...prev.recommendations.filter((r) => r.paper_id !== paperId), ...(text ? [{ paper_id: paperId, text }] : [])],
    }));
  }

  async function saveRec(paperId, text) {
    const clean = text.trim();
    setError('');
    const { error: err } = clean
      ? await supabase.from('exam_paper_recommendations').upsert({ paper_id: paperId, text: clean.slice(0, 600) })
      : await supabase.from('exam_paper_recommendations').delete().eq('paper_id', paperId);
    if (err) setError(err.message);
    else setRec(paperId, clean.slice(0, 600));
  }

  async function writeRecommendations() {
    const queue = [...missingRecs];
    if (queue.length === 0) return;
    if (!confirm(`Write recommendations for ${queue.length} subject${queue.length === 1 ? '' : 's'}? You can stop at any time and edit every one before printing.`)) return;

    stopRef.current = false;
    setError('');
    setNotice('');
    const total = queue.length;
    setGen({ running: true, done: 0, total });
    let done = 0;
    let failed = 0;
    let paused = '';

    async function worker() {
      while (queue.length > 0 && !stopRef.current) {
        const paperId = queue.shift();
        try {
          const { data: sessionData } = await supabase.auth.getSession();
          const res = await fetch('/api/marking/recommend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionData?.session?.access_token}` },
            body: JSON.stringify({ paperId }),
          });
          const json = await res.json().catch(() => ({}));
          if (json.budgetReached) {
            paused = json.error;
            stopRef.current = true;
            return;
          }
          if (json.ok && json.text) setRec(paperId, json.text);
          else failed += 1;
        } catch {
          failed += 1;
        }
        done += 1;
        setGen({ running: true, done, total });
      }
    }

    await Promise.all([worker(), worker()]);
    setGen({ running: false, done: 0, total: 0 });
    if (paused) setError(paused);
    else if (failed > 0) setNotice(`${failed} could not be written. Run it again to retry them.`);
    else if (stopRef.current) setNotice('Stopped. The ones already written are saved.');
    else setNotice('Recommendations are ready. Please read and edit them before you print.');
  }

  // Comments are saved on this device as you go, so a refresh does not lose them.
  const commentsKey = raw ? 'gf-comments:' + raw.exams.map((e) => e.id).sort().join(',') : null;
  commentsRef.current = comments;

  useEffect(() => {
    if (!commentsKey) return;
    try {
      setComments(JSON.parse(localStorage.getItem(commentsKey) || '{}'));
    } catch {
      setComments({});
    }
  }, [commentsKey]);

  function updateComments(patch) {
    setComments((prev) => {
      const next = { ...prev, ...patch };
      try {
        if (commentsKey) localStorage.setItem(commentsKey, JSON.stringify(next));
      } catch {
        // Storage can be unavailable; the comments still work for this session.
      }
      return next;
    });
  }

  async function draftComments() {
    const targets = students.filter((st) => !(commentsRef.current[st.key] || '').trim());
    if (targets.length === 0) return;
    if (!confirm(`Draft a comment for ${targets.length} student${targets.length === 1 ? '' : 's'}? Students who already have a comment are skipped. Read and edit every comment before you share it.`)) return;

    stopCRef.current = false;
    setError('');
    setNotice('');
    const groups = [];
    for (let i = 0; i < targets.length; i += 10) groups.push(targets.slice(i, i + 10));
    const total = targets.length;
    let done = 0;
    let failed = 0;
    let paused = '';
    setGenC({ running: true, done: 0, total });

    async function worker() {
      while (groups.length > 0 && !stopCRef.current) {
        const group = groups.shift();
        try {
          const { data: sessionData } = await supabase.auth.getSession();
          const res = await fetch('/api/marking/comments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionData?.session?.access_token}` },
            body: JSON.stringify({
              examId: raw.exams[0].id,
              students: group.map((st, i) => ({
                i,
                overallPct: st.overallPct,
                positionText: showPosition ? st.positionText : '',
                subjects: st.rows.map((r) => ({ subject: r.subject, pct: r.pct, classAvgPct: showPosition ? r.classAvgPct : null })),
              })),
            }),
          });
          const json = await res.json().catch(() => ({}));
          if (json.budgetReached) {
            paused = json.error;
            stopCRef.current = true;
            return;
          }
          if (json.comments) {
            const patch = {};
            group.forEach((st, i) => {
              const text = json.comments[i];
              if (!text) failed += 1;
              else if (!(commentsRef.current[st.key] || '').trim()) patch[st.key] = text;
            });
            updateComments(patch);
          } else {
            failed += group.length;
          }
        } catch {
          failed += group.length;
        }
        done += group.length;
        setGenC({ running: true, done, total });
      }
    }

    await Promise.all([worker(), worker()]);
    setGenC({ running: false, done: 0, total: 0 });
    if (paused) setError(paused);
    else if (failed > 0) setNotice(`${failed} could not be written. Run it again to retry them.`);
    else if (stopCRef.current) setNotice('Stopped. The comments already written are saved.');
    else setNotice('Comments are ready. Please read and edit them before you share the reports.');
  }

  async function createParentLinks() {
    if (!brand.school.trim()) {
      setError('Add your school name in the branding section first. Parents will see it at the top of the report.');
      return;
    }
    if (!confirm(`Create a private link for each of the ${students.length} students? Each link opens only that student's report, with no sign-in. You can switch them all off later.`)) return;
    setPublishing(true);
    setError('');
    setNotice('');
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const res = await fetch('/api/marking/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionData?.session?.access_token}` },
        body: JSON.stringify({
          action: 'publish',
          examIds: raw.exams.map((e) => e.id),
          comments,
          showPosition,
          label: `${classFilter === 'all' ? 'All classes' : classFilter} · ${brand.term || dateText}`,
          branding: { school: brand.school, term: brand.term, accent: brand.accent, logo: brand.logo },
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Could not create the links.');
      router.push(`/marking/shares?batch=${json.batchId}`);
      return;
    } catch (err) {
      setError(err.message);
    }
    setPublishing(false);
  }

  function downloadCsv() {
    const blob = new Blob([toCsv(visible, { includeClassStats: showPosition })], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `results-${classFilter === 'all' ? 'all-classes' : classFilter.replace(/[^\w-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const count = visible.length;

  return (
    <div className="page-wide">
      <style>{`
        .report-page { background: #fff; border: 1px solid var(--rule); border-radius: var(--r-panel); padding: 32px; margin-bottom: 24px; box-shadow: var(--shadow-raised); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .report-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding-bottom: 16px; border-bottom: 3px solid var(--accent); margin-bottom: 20px; }
        .report-brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
        .report-logo { max-height: 56px; max-width: 120px; object-fit: contain; }
        .report-school { margin: 0; font-size: 1.375rem; font-weight: 800; color: var(--accent); overflow-wrap: anywhere; }
        .report-sub { margin: 2px 0 0 0; font-size: .875rem; color: #555; }
        .report-date { margin: 0; font-size: .8125rem; color: #555; white-space: nowrap; }
        .report-meta, .report-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 20px; }
        .report-meta span, .report-summary span, .report-comment span, .analysis-rec span { display: block; font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; color: #666; margin-bottom: 2px; }
        .report-meta strong { font-size: .9375rem; overflow-wrap: anywhere; }
        .report-summary { background: #f5f7fb; border-radius: 10px; padding: 14px 16px; }
        .report-summary strong { font-size: 1.375rem; font-variant-numeric: tabular-nums; color: var(--accent); }
        .report-table { width: 100%; border-collapse: collapse; font-size: .875rem; }
        .report-table th { text-align: left; font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; color: var(--accent); border-bottom: 2px solid var(--accent); padding: 8px 10px; }
        .report-table td { padding: 10px; border-bottom: 1px solid #e2e6ee; vertical-align: top; }
        .report-table .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; font-weight: 600; }
        .report-table th:nth-child(n+2) { text-align: right; }
        .report-sub-line { font-size: .75rem; color: #666; font-weight: 400; }
        .report-comment { margin-top: 20px; }
        .report-comment textarea, .analysis-rec textarea { width: 100%; box-sizing: border-box; font: inherit; padding: 10px; border: 1px solid var(--control-border); border-radius: 10px; }
        .print-only { display: none; margin: 4px 0 0 0; white-space: pre-wrap; font-size: .9375rem; }
        .report-sign { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; margin-top: 44px; }
        .report-sign div { border-top: 1px solid #444; padding-top: 6px; font-size: .75rem; color: #555; }
        .analysis-block { border: 1px solid #e2e6ee; border-left: 4px solid var(--accent); border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; break-inside: avoid; }
        .analysis-head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; }
        .analysis-head .num { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--accent); }
        .analysis-line { margin: 4px 0; font-size: .875rem; }
        .analysis-rec { margin-top: 8px; }
        @media print {
          .no-print { display: none !important; }
          .print-only { display: block; }
          .page-wide { padding: 0 !important; margin: 0 !important; max-width: none !important; }
          .report-page { border: none; box-shadow: none; border-radius: 0; margin: 0; padding: 0; page-break-after: always; break-after: page; }
          .report-page:last-child { page-break-after: auto; break-after: auto; }
          @page { margin: 16mm; }
        }
      `}</style>

      <div className="no-print">
        <p className="breadcrumb"><a onClick={() => router.push('/marking')}>Marking</a> › Report cards</p>
        <div className="page-head">
          <div>
            <h1>Report cards</h1>
            <p className="subtitle">Choose the subjects, then print report cards and subject analysis, or download the results as a spreadsheet. Only approved scripts are counted.</p>
          </div>
        </div>

        {error && <p className="alert alert-error" role="alert">{error}</p>}
        {notice && <p className="alert alert-ok" role="status">{notice}</p>}

        <section className="surface">
          <p className="section-heading" style={{ marginBottom: 8 }}>1. Choose the subjects</p>
          {loading && <p>Loading...</p>}
          {!loading && exams.length === 0 && <p className="subtitle">You have no marking jobs yet.</p>}
          {exams.length > 0 && (
            <>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 8 }}>
                {classes.length > 0 && (
                  <div>
                    <label htmlFor="mr-class">Class</label>
                    <select id="mr-class" value={classFilter} onChange={(e) => setClassFilter(e.target.value)}>
                      <option value="all">All classes</option>
                      {classes.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                )}
                <button type="button" className="btn-quiet btn-sm" onClick={() => setSelectedIds(new Set([...selectedIds, ...shownExams.map((e) => e.id)]))}>Select all shown</button>
                <button type="button" className="btn-quiet btn-sm" onClick={() => setSelectedIds(new Set())}>Clear</button>
              </div>
              <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--rule)', borderRadius: 8 }}>
                {shownExams.map((e) => (
                  <label key={e.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid var(--rule)', margin: 0, cursor: 'pointer' }}>
                    <input type="checkbox" style={{ width: 'auto' }} checked={selectedIds.has(e.id)} onChange={() => toggleExam(e.id)} />
                    <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                      <strong>{e.title}</strong>
                      <span className="section-note" style={{ margin: 0 }}>{[e.subject, e.class_label].filter(Boolean).map((x) => ` · ${x}`)}</span>
                    </span>
                  </label>
                ))}
              </div>
              <button type="button" className="btn-primary" style={{ width: 'auto', marginTop: 12 }} disabled={selectedIds.size === 0 || building} onClick={build}>
                {building ? 'Building...' : `Build reports (${selectedIds.size} selected)`}
              </button>
            </>
          )}
        </section>

        {report && report.classSize === 0 && (
          <p className="subtitle" style={{ marginTop: 16 }}>No approved scripts in these subjects yet. Approve scripts in each marking job, then build again.</p>
        )}

        {report && report.classSize > 0 && (
          <>
            <section className="surface" style={{ marginTop: 'var(--s-4)' }}>
              <p className="section-heading" style={{ marginBottom: 8 }}>2. School branding</p>
              <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' }}>
                <div><label htmlFor="mr-school">School name</label><input id="mr-school" value={brand.school} placeholder="e.g. Greenfield College" onChange={(e) => updateBrand({ school: e.target.value })} /></div>
                <div><label htmlFor="mr-term">Term or session</label><input id="mr-term" value={brand.term} placeholder="e.g. 2025/2026 · First Term" onChange={(e) => updateBrand({ term: e.target.value })} /></div>
                <div>
                  <label htmlFor="mr-logo">Logo</label>
                  <input id="mr-logo" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleLogo} />
                  {brand.logo && <button type="button" className="btn-quiet btn-sm" style={{ marginTop: 6 }} onClick={() => updateBrand({ logo: '' })}>Remove logo</button>}
                </div>
                <div><label htmlFor="mr-accent">Brand colour</label><input id="mr-accent" type="color" value={brand.accent} onChange={(e) => updateBrand({ accent: e.target.value })} style={{ width: 64, height: 40, padding: 2 }} /></div>
              </div>
              <p className="section-note" style={{ margin: '10px 0 0 0' }}>Branding is saved on this device and browser.</p>
            </section>

            <section className="surface" style={{ marginTop: 'var(--s-4)' }}>
              <p className="section-heading" style={{ marginBottom: 4 }}>3. Recommendations</p>
              <p className="section-note" style={{ margin: '0 0 10px 0' }}>
                Short study suggestions for each student in each subject, written from the marks. Read and edit them before you print.
                {missingRecs.length > 0 ? ` ${missingRecs.length} still to write.` : ' All are written.'}
              </p>
              {!gen.running ? (
                <button type="button" className="btn-secondary" style={{ width: 'auto', marginTop: 0 }} disabled={missingRecs.length === 0} onClick={writeRecommendations}>
                  Write recommendations ({missingRecs.length})
                </button>
              ) : (
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="num">Writing... {gen.done} of {gen.total}</span>
                  <button type="button" className="btn-quiet btn-sm" onClick={() => (stopRef.current = true)}>Stop</button>
                </div>
              )}
            </section>

            <section className="surface" style={{ marginTop: 'var(--s-4)' }}>
              <p className="section-heading" style={{ marginBottom: 4 }}>4. Comments and parent links</p>
              <p className="section-note" style={{ margin: '0 0 10px 0' }}>
                Draft the teacher&apos;s comment for each student, edit it on the report card below, then create a private link for every parent.
                {students.filter((st) => !(comments[st.key] || '').trim()).length > 0
                  ? ` ${students.filter((st) => !(comments[st.key] || '').trim()).length} students have no comment yet.`
                  : ' Every student has a comment.'}
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {!genC.running ? (
                  <button type="button" className="btn-secondary" style={{ width: 'auto', marginTop: 0 }} disabled={students.every((st) => (comments[st.key] || '').trim())} onClick={draftComments}>
                    Draft comments
                  </button>
                ) : (
                  <>
                    <span className="num">Writing... {genC.done} of {genC.total}</span>
                    <button type="button" className="btn-quiet btn-sm" onClick={() => (stopCRef.current = true)}>Stop</button>
                  </>
                )}
                <button type="button" className="btn-primary" style={{ width: 'auto', marginTop: 0 }} disabled={publishing || genC.running} onClick={createParentLinks}>
                  {publishing ? 'Creating links...' : `Create parent links (${students.length})`}
                </button>
                <a style={{ cursor: 'pointer', fontSize: '0.875rem' }} onClick={() => router.push('/marking/shares')}>Links already created</a>
              </div>
              <p className="section-note" style={{ margin: '10px 0 0 0' }}>
                Switch to the Report card tab in the next section to read and edit the comments. Links show the school branding, results, comment and recommendations, and stay active for 180 days.
              </p>
            </section>

            <section className="surface" style={{ marginTop: 'var(--s-4)' }}>
              <p className="section-heading" style={{ marginBottom: 8 }}>5. Print or download</p>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div style={{ minWidth: 220 }}>
                  <label htmlFor="mr-student">Student</label>
                  <select id="mr-student" value={selectedStudent} onChange={(e) => setSelectedStudent(e.target.value)}>
                    <option value="all">All students ({students.length})</option>
                    {students.map((s) => <option key={s.key} value={s.key}>{s.name || s.regNo}</option>)}
                  </select>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0, minHeight: 40 }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={showPosition} onChange={(e) => setShowPosition(e.target.checked)} />
                  Show class position and class average
                </label>
              </div>
              <div role="tablist" style={{ display: 'flex', gap: 8, margin: '14px 0', flexWrap: 'wrap' }}>
                <button type="button" role="tab" aria-selected={mode === 'card'} className={mode === 'card' ? 'btn-primary' : 'btn-secondary'} style={{ width: 'auto', marginTop: 0 }} onClick={() => setMode('card')}>Report card</button>
                <button type="button" role="tab" aria-selected={mode === 'analysis'} className={mode === 'analysis' ? 'btn-primary' : 'btn-secondary'} style={{ width: 'auto', marginTop: 0 }} onClick={() => setMode('analysis')}>Subject analysis</button>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn-primary" style={{ width: 'auto', marginTop: 0 }} onClick={() => window.print()}>
                  {mode === 'card' ? 'Print report cards' : 'Print subject analysis'} ({count})
                </button>
                <button type="button" className="btn-secondary" style={{ width: 'auto', marginTop: 0 }} onClick={downloadCsv}>Download results (CSV)</button>
              </div>
              <p className="section-note" style={{ margin: '10px 0 0 0' }}>
                In the print window, choose &quot;Save as PDF&quot; as the destination to get a PDF file.
                {report.unmatched > 0 && ` ${report.unmatched} approved ${report.unmatched === 1 ? 'script is' : 'scripts are'} not linked to a roster student and ${report.unmatched === 1 ? 'was' : 'were'} matched by the name or reg number the AI read. Check the names.`}
              </p>
            </section>
          </>
        )}
      </div>

      <div style={{ marginTop: 24 }}>
        {report && mode === 'card' && visible.map((s) => (
          <ReportCard key={s.key} s={s} brand={brand} teacherName={teacherName} dateText={dateText} showPosition={showPosition}
            comment={comments[s.key] || ''} onComment={(v) => updateComments({ [s.key]: v })} />
        ))}
        {report && mode === 'analysis' && visible.map((s) => (
          <Analysis key={s.key} s={s} brand={brand} dateText={dateText} onSaveRec={saveRec} />
        ))}
      </div>
    </div>
  );
}
