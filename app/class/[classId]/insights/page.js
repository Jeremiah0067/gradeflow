'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { supabase } from '../../../../lib/supabaseClient';
import { computeInsights, toneFor } from '../../../../lib/insights';

const TONE = {
  high: { bar: 'var(--green)', tint: 'var(--green-tint)', word: 'Strong' },
  mid: { bar: '#b9770e', tint: 'var(--amber-tint)', word: 'Fair' },
  low: { bar: 'var(--red)', tint: 'var(--red-tint)', word: 'Low' },
};

const panel = {
  background: 'var(--paper)',
  border: '1px solid var(--rule)',
  borderRadius: 'var(--r-panel)',
  padding: 'var(--s-5)',
  boxShadow: 'var(--shadow-raised)',
};

function pctText(value) {
  return value === null || value === undefined ? '—' : `${Math.round(value)}%`;
}

function Panel({ title, note, children, style }) {
  return (
    <section style={{ ...panel, ...style }}>
      <h2 style={{ margin: 0, fontSize: '1.0625rem' }}>{title}</h2>
      {note && <p style={{ margin: '4px 0 0 0', fontSize: '0.8125rem', color: 'var(--ink-2)' }}>{note}</p>}
      <div style={{ marginTop: 'var(--s-4)' }}>{children}</div>
    </section>
  );
}

// Horizontal bar: the percentage is always written out, so colour is never the only signal.
function BarRow({ label, sub, pct }) {
  const tone = pct === null ? null : TONE[toneFor(pct)];
  return (
    <div style={{ marginBottom: 'var(--s-4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: '0.875rem', marginBottom: 6 }}>
        <span style={{ fontWeight: 600, minWidth: 0, overflowWrap: 'anywhere' }}>
          {label}
          {sub && <span style={{ fontWeight: 400, color: 'var(--ink-2)' }}> · {sub}</span>}
        </span>
        <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          {pctText(pct)}
          {tone && <span style={{ fontWeight: 400, color: 'var(--ink-2)' }}> {tone.word}</span>}
        </span>
      </div>
      <div style={{ height: 10, borderRadius: 999, background: 'var(--rule)', overflow: 'hidden' }}>
        <div
          style={{
            height: '100%',
            width: `${Math.max(Math.min(pct ?? 0, 100), pct ? 2 : 0)}%`,
            background: tone ? tone.bar : 'transparent',
            borderRadius: 999,
            transition: 'width 600ms ease',
          }}
        />
      </div>
    </div>
  );
}

function Stat({ value, label, hint }) {
  return (
    <div className="stat-card">
      <div>
        <p className="stat-value">{value}</p>
        <p className="stat-label">{label}</p>
        {hint && <p className="stat-label" style={{ marginTop: 2 }}>{hint}</p>}
      </div>
    </div>
  );
}

function Skeleton() {
  const block = { background: 'var(--rule)', borderRadius: 'var(--r-panel)', animation: 'gf-pulse 1.4s ease-in-out infinite' };
  return (
    <div aria-busy="true" aria-label="Loading insights">
      <style>{`@keyframes gf-pulse { 0%,100% { opacity: .55 } 50% { opacity: 1 } }`}</style>
      <div style={{ ...block, height: 28, width: 220, marginBottom: 24 }} />
      <div style={{ ...block, height: 84, marginBottom: 24 }} />
      <div style={{ ...block, height: 260, marginBottom: 24 }} />
      <div style={{ ...block, height: 200 }} />
    </div>
  );
}

export default function InsightsPage() {
  const router = useRouter();
  const { classId } = useParams();

  const [klass, setKlass] = useState(null);
  const [data, setData] = useState(null);
  const [counts, setCounts] = useState({ students: 0, assignments: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId]);

  async function load() {
    setLoading(true);
    setError('');

    const { data: sessionData } = await supabase.auth.getSession();
    const session = sessionData?.session;
    if (!session) {
      router.push('/login');
      return;
    }

    const { data: profileData } = await supabase.from('users').select('role').eq('id', session.user.id).single();
    if (profileData?.role !== 'teacher') {
      router.push(`/class/${classId}`);
      return;
    }

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
        .in('assignment_id', assignmentIds);
      if (subErr) setError(subErr.message);
      submissions = subs || [];

      const { data: crit } = await supabase
        .from('rubric_criteria')
        .select('id, assignment_id, label, max_points')
        .in('assignment_id', assignmentIds);
      criteria = crit || [];
    }

    setCounts({ students: students.length, assignments: (assignments || []).length });
    setData(computeInsights({ students, assignments: assignments || [], submissions, criteria }));
    setLoading(false);
  }

  const maxBand = data ? Math.max(1, ...data.distribution.map((d) => d.count)) : 1;
  const hasScores = data && data.gradedCount > 0;

  return (
    <div className="layout-shell">
      <div className="main-content" style={{ maxWidth: 1000 }}>
        <p className="breadcrumb">
          <a onClick={() => router.push('/dashboard')}>Classes</a> ›{' '}
          <a onClick={() => router.push(`/class/${classId}`)}>{klass?.name}</a> › Insights
        </p>

        <div className="main-header">
          <div>
            <h1>Class insights</h1>
            <p className="subtitle" style={{ marginBottom: 0 }}>
              {counts.students} students · {counts.assignments} assignments · based on published grades only
            </p>
          </div>
          <button
            type="button"
            className="btn-secondary"
            style={{ width: 'auto', marginTop: 0 }}
            onClick={() => router.push(`/class/${classId}/gradebook`)}
          >
            Open gradebook
          </button>
        </div>

        {error && <p className="error-text">{error}</p>}

        {loading && <Skeleton />}

        {!loading && data && !hasScores && (
          <div style={{ ...panel, textAlign: 'center', padding: 'var(--s-7) var(--s-5)' }}>
            <h2 style={{ margin: '0 0 8px 0' }}>No published grades yet</h2>
            <p className="subtitle" style={{ margin: '0 auto 16px auto', maxWidth: 420 }}>
              Insights appear once you approve and publish grades. Students' work that is still waiting for your review
              is not counted.
            </p>
            {data.pendingCount > 0 && (
              <p style={{ margin: '0 0 16px 0', fontWeight: 600 }}>
                {data.pendingCount} {data.pendingCount === 1 ? 'submission is' : 'submissions are'} waiting for review.
              </p>
            )}
            <button
              type="button"
              className="btn-primary"
              style={{ width: 'auto' }}
              onClick={() => router.push(`/class/${classId}`)}
            >
              Go to assignments
            </button>
          </div>
        )}

        {!loading && hasScores && (
          <>
            <div className="stats-row">
              <Stat value={pctText(data.classAvg)} label="Class average" hint={TONE[toneFor(data.classAvg)].word} />
              <Stat value={pctText(data.completionPct)} label="Work handed in" hint={`${data.gradedCount} graded`} />
              <Stat
                value={data.bestAssignment ? pctText(data.bestAssignment.avgPct) : '—'}
                label="Best assignment"
                hint={data.bestAssignment?.title}
              />
              <Stat
                value={data.hardestAssignment ? pctText(data.hardestAssignment.avgPct) : '—'}
                label="Hardest assignment"
                hint={data.hardestAssignment?.title}
              />
            </div>

            {data.pendingCount > 0 && (
              <div
                role="status"
                style={{
                  background: 'var(--amber-tint)',
                  color: 'var(--amber)',
                  borderRadius: 'var(--r-control)',
                  padding: '12px 16px',
                  marginBottom: 'var(--s-5)',
                  fontSize: '0.875rem',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <span>
                  <strong>{data.pendingCount}</strong> {data.pendingCount === 1 ? 'submission is' : 'submissions are'} still
                  waiting for review, so these numbers will change.
                </span>
                <a style={{ cursor: 'pointer', fontWeight: 700 }} onClick={() => router.push(`/class/${classId}/gradebook`)}>
                  Review in gradebook
                </a>
              </div>
            )}

            <div style={{ display: 'grid', gap: 'var(--s-5)', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
              <Panel title="How the class is doing" note="Number of students in each average band">
                <div
                  role="img"
                  aria-label={data.distribution.map((d) => `${d.label}: ${d.count} students`).join('. ')}
                  style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 170 }}
                >
                  {data.distribution.map((d) => (
                    <div key={d.id} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%', alignItems: 'center' }}>
                      <span style={{ fontWeight: 700, fontSize: '0.9375rem', fontVariantNumeric: 'tabular-nums', marginBottom: 4 }}>
                        {d.count}
                      </span>
                      <div
                        style={{
                          width: '100%',
                          height: `${(d.count / maxBand) * 100}%`,
                          minHeight: d.count > 0 ? 6 : 2,
                          background: d.count > 0 ? TONE[d.tone].bar : 'var(--rule)',
                          borderRadius: '8px 8px 2px 2px',
                          transition: 'height 600ms ease',
                        }}
                      />
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                  {data.distribution.map((d) => (
                    <span key={d.id} style={{ flex: 1, textAlign: 'center', fontSize: '0.6875rem', color: 'var(--ink-2)', lineHeight: 1.2 }}>
                      {d.label}
                    </span>
                  ))}
                </div>
              </Panel>

              <Panel title="Average by assignment" note="Published grades only">
                {data.perAssignment.map((a) => (
                  <BarRow
                    key={a.id}
                    label={a.title}
                    sub={a.avgPct === null ? 'not graded yet' : `${a.gradedCount} graded`}
                    pct={a.avgPct}
                  />
                ))}
              </Panel>
            </div>

            {data.weakestCriteria.length > 0 && (
              <Panel
                title="Where marks are being lost"
                note="The rubric criteria the class scored lowest on. A good place to focus your next lesson."
                style={{ marginTop: 'var(--s-5)' }}
              >
                {data.weakestCriteria.map((c, i) => (
                  <BarRow key={`${c.label}-${i}`} label={c.label} sub={c.assignmentTitle} pct={c.avgPct} />
                ))}
              </Panel>
            )}

            <div
              style={{
                display: 'grid',
                gap: 'var(--s-5)',
                gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
                marginTop: 'var(--s-5)',
              }}
            >
              <Panel title="Needs attention" note="Average below 50%, or at least half the work not handed in">
                {data.needsAttention.length === 0 ? (
                  <p style={{ margin: 0, color: 'var(--green)', fontWeight: 600 }}>No one is flagged right now.</p>
                ) : (
                  data.needsAttention.slice(0, 8).map((s) => (
                    <div
                      key={s.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 12,
                        padding: '10px 0',
                        borderBottom: '1px solid var(--rule)',
                        fontSize: '0.875rem',
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>{s.name}</span>
                      <span style={{ color: 'var(--red-ink)', textAlign: 'right' }}>{s.reasons.join(' · ')}</span>
                    </div>
                  ))
                )}
                {data.needsAttention.length > 8 && (
                  <p style={{ margin: '12px 0 0 0', fontSize: '0.8125rem', color: 'var(--ink-2)' }}>
                    and {data.needsAttention.length - 8} more in the gradebook
                  </p>
                )}
              </Panel>

              <Panel title="Top performers" note="Highest average across published grades">
                {data.topStudents.map((s, i) => (
                  <div
                    key={s.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '10px 0',
                      borderBottom: i < data.topStudents.length - 1 ? '1px solid var(--rule)' : 'none',
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 999,
                        background: 'var(--blue-tint)',
                        color: 'var(--blue)',
                        display: 'grid',
                        placeItems: 'center',
                        fontWeight: 800,
                        fontSize: '0.8125rem',
                      }}
                    >
                      {i + 1}
                    </span>
                    <span style={{ flex: 1, fontWeight: 600, fontSize: '0.875rem' }}>{s.name}</span>
                    <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{pctText(s.avgPct)}</span>
                  </div>
                ))}
              </Panel>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
