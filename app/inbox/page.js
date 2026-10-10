'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../../lib/supabaseClient';

function initials(name) {
  if (!name) return '?';
  return name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
}

function confidenceClass(avg) {
  if (avg === null) return '';
  if (avg >= 0.85) return 'confidence-high';
  if (avg >= 0.6) return 'confidence-medium';
  return 'confidence-low';
}

function avgConfidence(rubricScores) {
  const withConf = (rubricScores || []).filter((s) => typeof s.ai_confidence === 'number');
  if (withConf.length === 0) return null;
  return withConf.reduce((sum, s) => sum + s.ai_confidence, 0) / withConf.length;
}

function totalFor(rubricScores) {
  return (rubricScores || []).reduce((sum, s) => sum + Number(s.ai_awarded_points ?? 0), 0);
}

export default function InboxPage() {
  const router = useRouter();
  const [profile, setProfile] = useState(null);
  const [pending, setPending] = useState([]);
  const [reviewed, setReviewed] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('pending');
  const [stuck, setStuck] = useState([]);
  const [sweeping, setSweeping] = useState(false);
  const [regradingId, setRegradingId] = useState(null);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setLoading(true);
    setError('');

    const { data: sessionData } = await supabase.auth.getSession();
    const session = sessionData?.session;
    if (!session) {
      router.push('/login');
      return;
    }

    const { data: profileData } = await supabase.from('users').select('*').eq('id', session.user.id).single();
    if (profileData.role !== 'teacher') {
      router.push('/dashboard');
      return;
    }
    setProfile(profileData);

    const { data: ownedClasses } = await supabase.from('classes').select('id').eq('teacher_id', session.user.id);
    const { data: coTeacherRows } = await supabase
      .from('class_teachers')
      .select('class_id')
      .eq('teacher_id', session.user.id);
    const classIds = [
      ...new Set([...(ownedClasses || []).map((c) => c.id), ...(coTeacherRows || []).map((r) => r.class_id)]),
    ];

    if (classIds.length === 0) {
      setPending([]);
      setReviewed([]);
      setLoading(false);
      return;
    }

    const { data: assignments } = await supabase
      .from('assignments')
      .select('id, title, class_id, max_points, classes(name)')
      .in('class_id', classIds);
    const assignmentIds = (assignments || []).map((a) => a.id);
    const assignmentById = Object.fromEntries((assignments || []).map((a) => [a.id, a]));

    if (assignmentIds.length === 0) {
      setPending([]);
      setReviewed([]);
      setLoading(false);
      return;
    }

    const { data: pendingSubs, error: pErr } = await supabase
      .from('submissions')
      .select('*, users(name, email), rubric_scores(*)')
      .in('assignment_id', assignmentIds)
      .eq('status', 'needs_teacher_approval')
      .order('submitted_at', { ascending: false });
    if (pErr) setError(pErr.message);

    // Flag anything that's been sitting unpaid-attention for 3+ minutes as stuck
    const threeMinAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const stuckSubs = (pendingSubs || []).filter((s) => s.submitted_at < threeMinAgo);

    const stuckWithErrors = await Promise.all(
      stuckSubs.map(async (s) => {
        const { data: errors } = await supabase
          .from('grading_errors')
          .select('error_message, created_at')
          .eq('submission_id', s.id)
          .order('created_at', { ascending: false })
          .limit(1);
        return { ...s, assignment: assignmentById[s.assignment_id], lastError: errors?.[0]?.error_message };
      })
    );
    setStuck(stuckWithErrors);

    const { data: reviewedSubs } = await supabase
      .from('submissions')
      .select('*, users(name, email), rubric_scores(*)')
      .in('assignment_id', assignmentIds)
      .eq('status', 'published')
      .order('submitted_at', { ascending: false })
      .limit(20);

    setPending((pendingSubs || []).map((s) => ({ ...s, assignment: assignmentById[s.assignment_id] })));
    setReviewed((reviewedSubs || []).map((s) => ({ ...s, assignment: assignmentById[s.assignment_id] })));
    setLoading(false);
  }

  async function handleRegrade(submissionId) {
    setRegradingId(submissionId);
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData?.session?.access_token;

    await fetch('/api/process-grading', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ record: { id: submissionId } }),
    });

    setRegradingId(null);
    load();
  }

  async function handleSweepStuck() {
    setSweeping(true);
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData?.session?.access_token;

    await fetch('/api/sweep-stuck', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    setSweeping(false);
    load();
  }

  if (loading) {
    return (
      <div className="page-wide">
        <p>Loading...</p>
      </div>
    );
  }

  const highConfidenceCount = pending.filter((s) => {
    const c = avgConfidence(s.rubric_scores);
    return c !== null && c >= 0.85;
  }).length;
  const needsCloserReviewCount = pending.length - highConfidenceCount;

  const items = tab === 'pending' ? pending : reviewed;

  return (
    <div className="layout-shell">
      <div className="main-content">
        <p className="breadcrumb" style={{ textTransform: 'uppercase', fontWeight: 600, fontSize: 11, letterSpacing: 0.5 }}>
          Teacher review queue
        </p>
        <h1>Inbox</h1>
        <p className="subtitle">AI-scored submissions waiting for your approval before students can see grades.</p>

        {error && <p className="error-text">{error}</p>}

        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          <button type="button" className={`tab-pill ${tab === 'pending' ? 'active' : ''}`} onClick={() => setTab('pending')}>
            Pending · {pending.length}
          </button>
          <button type="button" className={`tab-pill ${tab === 'reviewed' ? 'active' : ''}`} onClick={() => setTab('reviewed')}>
            Reviewed
          </button>
        </div>

        {stuck.length > 0 && (
          <div className="surface" style={{ borderColor: '#f9ab00', background: '#fffdf5' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <p className="section-heading" style={{ color: '#b06000', marginBottom: 0 }}>
                ⚠ {stuck.length} submission{stuck.length > 1 ? 's' : ''} stuck grading
              </p>
              <button
                type="button"
                className="btn-secondary"
                style={{ width: 'auto', margin: 0, padding: '6px 12px', fontSize: 12 }}
                onClick={handleSweepStuck}
                disabled={sweeping}
              >
                {sweeping ? 'Checking...' : 'Check for stuck submissions'}
              </button>
            </div>
            <p className="subtitle" style={{ marginBottom: 12 }}>
              These have been waiting on AI grading for over 3 minutes without completing - usually a
              temporary network or API hiccup. A background check retries these automatically every few
              minutes, or you can regrade one directly below.
            </p>
            {stuck.map((s) => (
              <div
                key={s.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '10px 0',
                  borderTop: '1px solid #f3e5c0',
                }}
              >
                <div>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
                    {s.users?.name} · {s.assignment?.title}
                  </p>
                  <p style={{ margin: 0, fontSize: 12, color: '#9aa0a6' }}>
                    Attempt {s.grading_attempts || 0} of 3{s.lastError && ` · last error: ${s.lastError}`}
                  </p>
                </div>
                <button
                  type="button"
                  style={{ width: 'auto', margin: 0, padding: '6px 12px', fontSize: 12 }}
                  onClick={() => handleRegrade(s.id)}
                  disabled={regradingId === s.id}
                >
                  {regradingId === s.id ? 'Regrading...' : 'Regrade now'}
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="two-col">
          <div>
            {items.length === 0 && (
              <p className="subtitle">{tab === 'pending' ? 'Nothing waiting for review right now.' : 'No reviewed submissions yet.'}</p>
            )}
            {items.map((s) => {
              const conf = avgConfidence(s.rubric_scores);
              const total = totalFor(s.rubric_scores);
              return (
                <div key={s.id} className="inbox-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ display: 'flex', gap: 12 }}>
                      <div className="avatar-initials">{initials(s.users?.name)}</div>
                      <div>
                        <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>
                          {s.users?.name} <span style={{ color: '#9aa0a6', fontWeight: 400 }}>· {s.assignment?.classes?.name}</span>
                        </p>
                        <p style={{ margin: '2px 0 0 0', fontSize: 13, color: '#5f6368' }}>{s.assignment?.title}</p>
                      </div>
                    </div>
                    <span className={`badge ${tab === 'pending' ? 'badge-flagged' : 'badge-graded'}`}>
                      {tab === 'pending' ? 'Awaiting approval' : 'Published'}
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: 24, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div>
                      <p style={{ margin: 0, fontSize: 11, color: '#9aa0a6', textTransform: 'uppercase' }}>Submitted</p>
                      <p style={{ margin: 0, fontSize: 13 }}>
                        {s.submitted_at ? new Date(s.submitted_at).toLocaleString() : '-'}
                      </p>
                    </div>
                    <div>
                      <p style={{ margin: 0, fontSize: 11, color: '#9aa0a6', textTransform: 'uppercase' }}>
                        {tab === 'pending' ? 'AI proposed' : 'Score'}
                      </p>
                      <p style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
                        {total} / {s.assignment?.max_points}
                      </p>
                    </div>
                    {conf !== null && (
                      <div>
                        <p style={{ margin: 0, fontSize: 11, color: '#9aa0a6', textTransform: 'uppercase' }}>Confidence</p>
                        <span className={`confidence-pill ${confidenceClass(conf)}`}>{Math.round(conf * 100)}%</span>
                      </div>
                    )}
                    <button
                      type="button"
                      style={{ width: 'auto', margin: 0, marginLeft: 'auto', padding: '8px 16px', fontSize: 13 }}
                      onClick={() => router.push(`/class/${s.assignment?.class_id}/assignments/${s.assignment_id}`)}
                    >
                      Review →
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {tab === 'pending' && (
            <div>
              <div className="surface">
                <p className="section-heading" style={{ color: '#137333' }}>✓ You stay in control</p>
                <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: '#5f6368', lineHeight: 1.8 }}>
                  <li>Review the AI&apos;s rubric-based draft</li>
                  <li>Override any criterion score if needed</li>
                  <li>Approve and publish</li>
                </ol>
              </div>
              <div className="surface">
                <p className="section-heading">Queue snapshot</p>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 8 }}>
                  <span>High confidence</span>
                  <strong>{highConfidenceCount}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                  <span>Needs closer review</span>
                  <strong>{needsCloserReviewCount}</strong>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
