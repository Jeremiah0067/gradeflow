'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { supabase } from '../../../../lib/supabaseClient';
import { buildReportCards } from '../../../../lib/reportCard';

const BRAND_KEY = 'gf-report-brand';
const DEFAULT_BRAND = { school: '', term: '', accent: '#2340b4', logo: '' };

function pctText(value) {
  return value === null || value === undefined ? '—' : `${Math.round(value)}%`;
}

// Shrinks the chosen logo so it fits comfortably in browser storage.
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

function ReportCard({ card, brand, klass, teacherName, dateText, comment, onComment, showFeedback }) {
  const accent = brand.accent || DEFAULT_BRAND.accent;
  return (
    <article className="report-page" style={{ '--accent': accent }}>
      <header className="report-head">
        <div className="report-brand">
          {brand.logo && <img src={brand.logo} alt="" className="report-logo" />}
          <div>
            <p className="report-school">{brand.school || 'Your school name'}</p>
            <p className="report-sub">Student report{brand.term ? ` · ${brand.term}` : ''}</p>
          </div>
        </div>
        <p className="report-date">{dateText}</p>
      </header>

      <div className="report-meta">
        <div>
          <span>Student</span>
          <strong>{card.name}</strong>
        </div>
        <div>
          <span>Class</span>
          <strong>
            {klass?.name}
            {klass?.subject ? ` · ${klass.subject}` : ''}
          </strong>
        </div>
        <div>
          <span>Teacher</span>
          <strong>{teacherName || '—'}</strong>
        </div>
      </div>

      <div className="report-summary">
        <div>
          <span>Overall</span>
          <strong>{pctText(card.overallPct)}</strong>
        </div>
        <div>
          <span>Points</span>
          <strong>
            {card.totalScore} / {card.totalMax}
          </strong>
        </div>
        <div>
          <span>Assignments graded</span>
          <strong>{card.rows.length}</strong>
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="report-table">
          <thead>
            <tr>
              <th>Assignment</th>
              <th>Score</th>
              <th>Percent</th>
            </tr>
          </thead>
          <tbody>
            {card.rows.map((r) => (
              <tr key={r.title}>
                <td>
                  {r.title}
                  {showFeedback && r.feedback.length > 0 && (
                    <ul className="report-feedback">
                      {r.feedback.map((f, i) => (
                        <li key={i}>
                          <strong>
                            {f.label} ({f.points}
                            {f.max !== null ? `/${f.max}` : ''}):
                          </strong>{' '}
                          {f.comment}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="num">
                  {r.score} / {r.max}
                </td>
                <td className="num">{pctText(r.pct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="report-comment">
        <span>Teacher&apos;s comment</span>
        <textarea
          className="no-print"
          rows={3}
          placeholder="Write a short comment for this student (optional)"
          value={comment}
          onChange={(e) => onComment(e.target.value)}
        />
        {comment.trim() && <p className="print-only">{comment}</p>}
      </div>

      <footer className="report-sign">
        <div>Teacher&apos;s signature</div>
        <div>Parent / guardian signature</div>
      </footer>
    </article>
  );
}

export default function ReportsPage() {
  const router = useRouter();
  const { classId } = useParams();

  const [klass, setKlass] = useState(null);
  const [teacherName, setTeacherName] = useState('');
  const [cards, setCards] = useState([]);
  const [selected, setSelected] = useState('all');
  const [brand, setBrand] = useState(DEFAULT_BRAND);
  const [comments, setComments] = useState({});
  const [showFeedback, setShowFeedback] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [brandNote, setBrandNote] = useState('');

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(BRAND_KEY) || 'null');
      if (saved) setBrand({ ...DEFAULT_BRAND, ...saved });
    } catch {
      // Storage can be unavailable (private browsing); the defaults still work.
    }
  }, []);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId]);

  function updateBrand(patch) {
    const next = { ...brand, ...patch };
    setBrand(next);
    setBrandNote('');
    try {
      localStorage.setItem(BRAND_KEY, JSON.stringify(next));
    } catch {
      setBrandNote('Your branding could not be saved on this browser, but it will still print.');
    }
  }

  async function handleLogo(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      updateBrand({ logo: await fileToLogo(file) });
    } catch {
      setBrandNote('That image could not be read. Try a PNG or JPG file.');
    }
  }

  async function load() {
    setLoading(true);
    setError('');

    const { data: sessionData } = await supabase.auth.getSession();
    const session = sessionData?.session;
    if (!session) {
      router.push('/login');
      return;
    }

    const { data: profileData } = await supabase.from('users').select('name, role').eq('id', session.user.id).single();
    if (profileData?.role !== 'teacher') {
      router.push(`/class/${classId}`);
      return;
    }
    setTeacherName(profileData.name || '');

    const { data: classData, error: classErr } = await supabase.from('classes').select('*').eq('id', classId).single();
    if (classErr) {
      setError(classErr.message);
      setLoading(false);
      return;
    }
    setKlass(classData);

    const { data: assignments } = await supabase
      .from('assignments')
      .select('id, title, max_points, type')
      .eq('class_id', classId)
      .order('created_at', { ascending: true });

    const { data: enrollments } = await supabase
      .from('enrollments')
      .select('student_id, users(name, email)')
      .eq('class_id', classId);
    const students = (enrollments || []).map((e) => ({ id: e.student_id, name: e.users?.name, email: e.users?.email }));

    const assignmentIds = (assignments || []).map((a) => a.id);
    let submissions = [];
    let criteria = [];
    if (assignmentIds.length > 0) {
      const { data: subs, error: subErr } = await supabase
        .from('submissions')
        .select('*, rubric_scores(*)')
        .in('assignment_id', assignmentIds)
        .eq('status', 'published');
      if (subErr) setError(subErr.message);
      submissions = subs || [];

      const { data: crit } = await supabase
        .from('rubric_criteria')
        .select('id, assignment_id, label, max_points, sort_order')
        .in('assignment_id', assignmentIds);
      criteria = crit || [];
    }

    setCards(buildReportCards({ students, assignments: assignments || [], submissions, criteria }));
    setLoading(false);
  }

  const ready = useMemo(() => cards.filter((c) => c.rows.length > 0), [cards]);
  const skipped = cards.length - ready.length;
  const visible = selected === 'all' ? ready : ready.filter((c) => c.id === selected);
  const dateText = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div className="layout-shell">
      <style>{`
        .report-page { background: #fff; border: 1px solid var(--rule); border-radius: var(--r-panel); padding: 32px; margin-bottom: 24px; box-shadow: var(--shadow-raised); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .report-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding-bottom: 16px; border-bottom: 3px solid var(--accent); margin-bottom: 20px; }
        .report-brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
        .report-logo { max-height: 56px; max-width: 120px; object-fit: contain; }
        .report-school { margin: 0; font-size: 1.375rem; font-weight: 800; color: var(--accent); overflow-wrap: anywhere; }
        .report-sub { margin: 2px 0 0 0; font-size: .875rem; color: #555; }
        .report-date { margin: 0; font-size: .8125rem; color: #555; white-space: nowrap; }
        .report-meta, .report-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
        .report-meta span, .report-summary span, .report-comment span { display: block; font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; color: #666; margin-bottom: 2px; }
        .report-meta strong { font-size: .9375rem; }
        .report-summary { background: #f5f7fb; border-radius: 10px; padding: 14px 16px; }
        .report-summary strong { font-size: 1.375rem; font-variant-numeric: tabular-nums; color: var(--accent); }
        .report-table { width: 100%; border-collapse: collapse; font-size: .875rem; }
        .report-table th { text-align: left; font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; color: var(--accent); border-bottom: 2px solid var(--accent); padding: 8px 10px; }
        .report-table td { padding: 10px; border-bottom: 1px solid #e2e6ee; vertical-align: top; }
        .report-table .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; font-weight: 600; }
        .report-table th:nth-child(2), .report-table th:nth-child(3) { text-align: right; }
        .report-feedback { margin: 8px 0 0 0; padding-left: 18px; font-size: .8125rem; color: #444; font-weight: 400; }
        .report-feedback li { margin-bottom: 4px; }
        .report-comment { margin-top: 20px; }
        .report-comment textarea { width: 100%; box-sizing: border-box; font: inherit; padding: 10px; border: 1px solid var(--control-border); border-radius: 10px; }
        .print-only { display: none; margin: 4px 0 0 0; white-space: pre-wrap; font-size: .9375rem; }
        .report-sign { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; margin-top: 44px; }
        .report-sign div { border-top: 1px solid #444; padding-top: 6px; font-size: .75rem; color: #555; }
        @media print {
          .no-print { display: none !important; }
          .print-only { display: block; }
          .layout-shell, .main-content { padding: 0 !important; margin: 0 !important; max-width: none !important; }
          .report-page { border: none; box-shadow: none; border-radius: 0; margin: 0; padding: 0; page-break-after: always; break-after: page; }
          .report-page:last-child { page-break-after: auto; break-after: auto; }
          @page { margin: 16mm; }
        }
      `}</style>

      <div className="main-content" style={{ maxWidth: 900 }}>
        <div className="no-print">
          <p className="breadcrumb">
            <a onClick={() => router.push('/dashboard')}>Classes</a> ›{' '}
            <a onClick={() => router.push(`/class/${classId}`)}>{klass?.name}</a> › Report cards
          </p>

          <div className="main-header">
            <div>
              <h1>Report cards</h1>
              <p className="subtitle" style={{ marginBottom: 0 }}>
                Built from published grades only. Print or save as PDF.
              </p>
            </div>
            <button
              type="button"
              className="btn-primary"
              style={{ width: 'auto', marginTop: 0 }}
              disabled={visible.length === 0}
              onClick={() => window.print()}
            >
              {selected === 'all' ? `Print all (${visible.length})` : 'Print report'}
            </button>
          </div>

          {error && <p className="error-text">{error}</p>}

          <section
            style={{
              background: 'var(--paper)',
              border: '1px solid var(--rule)',
              borderRadius: 'var(--r-panel)',
              padding: 'var(--s-5)',
              marginBottom: 'var(--s-5)',
            }}
          >
            <h2 style={{ margin: '0 0 12px 0', fontSize: '1.0625rem' }}>School branding</h2>
            <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              <div>
                <label htmlFor="rc-school">School name</label>
                <input id="rc-school" value={brand.school} placeholder="e.g. Greenfield College" onChange={(e) => updateBrand({ school: e.target.value })} />
              </div>
              <div>
                <label htmlFor="rc-term">Term or session</label>
                <input id="rc-term" value={brand.term} placeholder="e.g. 2025/2026 · First Term" onChange={(e) => updateBrand({ term: e.target.value })} />
              </div>
              <div>
                <label htmlFor="rc-logo">Logo</label>
                <input id="rc-logo" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleLogo} />
                {brand.logo && (
                  <button type="button" className="btn-quiet btn-sm" style={{ marginTop: 6 }} onClick={() => updateBrand({ logo: '' })}>
                    Remove logo
                  </button>
                )}
              </div>
              <div>
                <label htmlFor="rc-accent">Brand colour</label>
                <input id="rc-accent" type="color" value={brand.accent} onChange={(e) => updateBrand({ accent: e.target.value })} style={{ width: 64, height: 40, padding: 2 }} />
              </div>
            </div>
            <p style={{ margin: '12px 0 0 0', fontSize: '0.8125rem', color: 'var(--ink-2)' }}>
              Branding is saved on this device and browser, so set it once on each device you print from.
            </p>
            {brandNote && <p className="error-text">{brandNote}</p>}
          </section>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 'var(--s-5)' }}>
            <div style={{ minWidth: 220 }}>
              <label htmlFor="rc-student">Student</label>
              <select id="rc-student" value={selected} onChange={(e) => setSelected(e.target.value)}>
                <option value="all">All students ({ready.length})</option>
                {ready.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0, minHeight: 40 }}>
              <input type="checkbox" checked={showFeedback} onChange={(e) => setShowFeedback(e.target.checked)} style={{ width: 'auto' }} />
              Include feedback under each assignment
            </label>
          </div>

          {skipped > 0 && !loading && (
            <p style={{ fontSize: '0.8125rem', color: 'var(--ink-2)', marginTop: 0 }}>
              {skipped} {skipped === 1 ? 'student has' : 'students have'} no published grades yet and {skipped === 1 ? 'is' : 'are'} left out.
            </p>
          )}
        </div>

        {loading && <p className="no-print">Loading...</p>}

        {!loading && ready.length === 0 && (
          <div className="no-print" style={{ textAlign: 'center', padding: 'var(--s-7) var(--s-5)', background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 'var(--r-panel)' }}>
            <h2 style={{ margin: '0 0 8px 0' }}>No report cards yet</h2>
            <p className="subtitle" style={{ margin: 0 }}>
              Report cards appear once you approve and publish grades for your students.
            </p>
          </div>
        )}

        {!loading &&
          visible.map((card) => (
            <ReportCard
              key={card.id}
              card={card}
              brand={brand}
              klass={klass}
              teacherName={teacherName}
              dateText={dateText}
              comment={comments[card.id] || ''}
              onComment={(v) => setComments((prev) => ({ ...prev, [card.id]: v }))}
              showFeedback={showFeedback}
            />
          ))}
      </div>
    </div>
  );
}
