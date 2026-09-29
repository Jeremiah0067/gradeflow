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
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="appbar-logo">G</div>
          <span>GradeFlow</span>
        </div>
        <nav className="sidebar-nav">
          <button type="button" className="sidebar-link" onClick={() => router.push('/dashboard')}>
            <span className="sidebar-link-left">📊 Dashboard</span>
          </button>
          <button type="button" className="sidebar-link" onClick={() => router.push('/dashboard')}>
            <span className="sidebar-link-left">📚 Classes</span>
          </button>
          <button type="button" className="sidebar-link active">
            <span className="sidebar-link-left">📥 Inbox</span>
            {pending.length > 0 && <span className="sidebar-badge">{pending.length}</span>}
          </button>
        </nav>
        <div className="sidebar-footer">
          <div className="avatar-chip">{profile?.name?.[0]?.toUpperCase() || '?'}</div>
          <div className="sidebar-footer-info">
            <p className="sidebar-footer-name">{profile?.name}</p>
            <p className="sidebar-footer-role">Teacher</p>
          </div>
        </div>
      </aside>

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
