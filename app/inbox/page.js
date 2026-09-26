'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../../lib/supabaseClient';

function totalFor(rubricScores) {
  return (rubricScores || []).reduce(
    (sum, s) => sum + Number(s.teacher_override_points ?? s.ai_awarded_points ?? 0),
    0
  );
}

export default function InboxPage() {
  const router = useRouter();
  const [profile, setProfile] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [overrideDrafts, setOverrideDrafts] = useState({});
  const [publishingId, setPublishingId] = useState(null);

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

    const { data: teacherClasses } = await supabase.from('classes').select('id').eq('teacher_id', session.user.id);
    const classIds = (teacherClasses || []).map((c) => c.id);

    if (classIds.length === 0) {
      setItems([]);
      setLoading(false);
      return;
    }

    const { data: assignments } = await supabase.from('assignments').select('id, title, max_points').in('class_id', classIds);
    const assignmentIds = (assignments || []).map((a) => a.id);
    const assignmentById = Object.fromEntries((assignments || []).map((a) => [a.id, a]));

    if (assignmentIds.length === 0) {
      setItems([]);
      setLoading(false);
      return;
    }

    const { data: submissions, error: subErr } = await supabase
      .from('submissions')
      .select('*, users(name, email), rubric_scores(*)')
      .in('assignment_id', assignmentIds)
      .eq('status', 'needs_teacher_approval')
      .order('submitted_at', { ascending: true });

    if (subErr) setError(subErr.message);

    setItems((submissions || []).map((s) => ({ ...s, assignment: assignmentById[s.assignment_id] })));
    setLoading(false);
  }

  function draftValueFor(score) {
    if (score.id in overrideDrafts) return overrideDrafts[score.id];
    return score.teacher_override_points ?? score.ai_awarded_points ?? '';
  }

  function handleOverrideChange(scoreId, value) {
    setOverrideDrafts((prev) => ({ ...prev, [scoreId]: value }));
  }

  async function saveOverride(scoreId) {
    const value = overrideDrafts[scoreId];
    const numeric = value === '' ? null : Number(value);
    await supabase.from('rubric_scores').update({ teacher_override_points: numeric }).eq('id', scoreId);
    setOverrideDrafts((prev) => {
      const next = { ...prev };
      delete next[scoreId];
      return next;
    });
    load();
  }

  async function handlePublish(submissionId) {
    setPublishingId(submissionId);
    await supabase.from('submissions').update({ status: 'published' }).eq('id', submissionId);
    setPublishingId(null);
    load();
  }

  if (loading) {
    return (
      <div className="page-wide">
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="page-wide">
      <div className="top-bar">
        <div>
          <h1>Ungraded work</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            AI-graded submissions waiting on your approval before students see them.
          </p>
        </div>
        <button style={{ width: 'auto', marginTop: 0 }} onClick={() => router.push('/dashboard')}>
          Back to dashboard
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {items.length === 0 && <p className="subtitle">Nothing waiting for review right now.</p>}

      {items.map((s) => (
        <div key={s.id} className="page" style={{ margin: '0 0 16px 0', maxWidth: 'none' }}>
          <p style={{ margin: '0 0 4px 0', fontWeight: 600 }}>
            {s.assignment?.title} — {s.users?.name}
          </p>
          <p style={{ margin: '0 0 8px 0', whiteSpace: 'pre-wrap', fontSize: 14 }}>{s.raw_content?.text}</p>

          {s.rubric_scores?.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {s.rubric_scores.map((score) => (
                <div key={score.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, fontSize: 13 }}>
                  <div style={{ flex: 1 }}>
                    <span>{score.ai_reasoning}</span>
                    <span style={{ color: '#6b7280' }}> (AI gave {score.ai_awarded_points} pts)</span>
                  </div>
                  <input
                    type="number"
                    value={draftValueFor(score)}
                    onChange={(e) => handleOverrideChange(score.id, e.target.value)}
                    style={{ width: 64, padding: '6px 8px', margin: 0 }}
                  />
                  <button
                    type="button"
                    onClick={() => saveOverride(score.id)}
                    style={{ width: 'auto', margin: 0, padding: '6px 10px', fontSize: 12 }}
                  >
                    Save
                  </button>
                </div>
              ))}
              <p style={{ fontWeight: 600, marginTop: 8 }}>
                Total: {totalFor(s.rubric_scores)} / {s.assignment?.max_points}
              </p>
            </div>
          )}

          <button
            type="button"
            onClick={() => handlePublish(s.id)}
            disabled={publishingId === s.id}
            style={{ marginTop: 12 }}
          >
            {publishingId === s.id ? 'Publishing...' : 'Approve & publish to student'}
          </button>
        </div>
      ))}
    </div>
  );
}
