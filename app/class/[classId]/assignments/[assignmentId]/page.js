'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { supabase } from '../../../../../lib/supabaseClient';

export default function AssignmentPage() {
  const router = useRouter();
  const { classId, assignmentId } = useParams();

  const [profile, setProfile] = useState(null);
  const [assignment, setAssignment] = useState(null);
  const [mySubmission, setMySubmission] = useState(null);
  const [allSubmissions, setAllSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [answerText, setAnswerText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignmentId]);

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
    setProfile(profileData);

    const { data: assignmentData, error: aErr } = await supabase
      .from('assignments')
      .select('*, rubric_criteria(*)')
      .eq('id', assignmentId)
      .single();

    if (aErr) {
      setError(aErr.message);
      setLoading(false);
      return;
    }
    setAssignment(assignmentData);

    if (profileData.role === 'student') {
      const { data: sub } = await supabase
        .from('submissions')
        .select('*, rubric_scores(*)')
        .eq('assignment_id', assignmentId)
        .eq('student_id', session.user.id)
        .maybeSingle();
      setMySubmission(sub);
    } else {
      const { data: subs, error: subErr } = await supabase
        .from('submissions')
        .select('*, users(name, email), rubric_scores(*)')
        .eq('assignment_id', assignmentId)
        .order('submitted_at', { ascending: false });
      if (subErr) setError(subErr.message);
      setAllSubmissions(subs || []);
    }

    setLoading(false);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError('');

    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData?.session?.access_token;

    const res = await fetch('/api/grade', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        assignmentId,
        answerText,
      }),
    });

    const data = await res.json();
    setSubmitting(false);

    if (!res.ok) {
      setError(data.error || 'Failed to submit and grade.');
      return;
    }

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
          <h1>{assignment?.title}</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            {assignment?.type} · {assignment?.max_points} pts
          </p>
        </div>
        <button style={{ width: 'auto', marginTop: 0 }} onClick={() => router.push(`/class/${classId}`)}>
          Back to class
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="page" style={{ margin: '0 0 24px 0', maxWidth: 'none' }}>
        <h1 style={{ fontSize: 16 }}>Instructions</h1>
        <p>{assignment?.instructions || 'No instructions provided.'}</p>

        {assignment?.rubric_criteria?.length > 0 && (
          <>
            <h1 style={{ fontSize: 16, marginTop: 20 }}>Rubric</h1>
            {assignment.rubric_criteria.map((c) => (
              <p key={c.id} style={{ margin: '4px 0' }}>
                {c.label} — {c.max_points} pts
              </p>
            ))}
          </>
        )}
      </div>

      {profile?.role === 'student' && assignment?.type === 'typed' && (
        <div className="page" style={{ margin: 0, maxWidth: 'none' }}>
          {mySubmission ? (
            <>
              <h1 style={{ fontSize: 16 }}>Your submission</h1>
              <p style={{ whiteSpace: 'pre-wrap' }}>{mySubmission.raw_content?.text}</p>
              <span className={`badge badge-${mySubmission.status === 'graded' || mySubmission.status === 'returned' ? 'graded' : 'flagged'}`}>
                {mySubmission.status}
              </span>
              {mySubmission.rubric_scores?.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  {mySubmission.rubric_scores.map((s) => (
                    <p key={s.id} style={{ margin: '4px 0', fontSize: 14 }}>
                      {s.ai_reasoning} — {s.teacher_override_points ?? s.ai_awarded_points} pts
                    </p>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <h1 style={{ fontSize: 16 }}>Your answer</h1>
              <form onSubmit={handleSubmit}>
                <textarea
                  rows={8}
                  value={answerText}
                  onChange={(e) => setAnswerText(e.target.value)}
                  placeholder="Type your answer here..."
                  required
                />
                <button type="submit" disabled={submitting}>
                  {submitting ? 'Submitting and grading...' : 'Submit'}
                </button>
              </form>
            </>
          )}
        </div>
      )}

      {profile?.role === 'student' && assignment?.type !== 'typed' && (
        <div className="page" style={{ margin: 0, maxWidth: 'none' }}>
          <p className="subtitle">
            This assignment type ({assignment?.type}) isn&apos;t wired up in this starter yet — typed answers are
            the first working submission flow. Handwritten photo upload and quiz types are the next pieces to
            build.
          </p>
        </div>
      )}

      {profile?.role === 'teacher' && (
        <div className="page" style={{ margin: 0, maxWidth: 'none' }}>
          <h1 style={{ fontSize: 16 }}>Submissions ({allSubmissions.length})</h1>
          {allSubmissions.length === 0 && <p className="subtitle">No submissions yet.</p>}
          {allSubmissions.map((s) => (
            <div key={s.id} style={{ borderBottom: '1px solid #e5e7eb', padding: '12px 0' }}>
              <p style={{ margin: '0 0 4px 0', fontWeight: 600 }}>{s.users?.name}</p>
              <p style={{ margin: '0 0 8px 0', whiteSpace: 'pre-wrap', fontSize: 14 }}>{s.raw_content?.text}</p>
              <span className={`badge badge-${s.status === 'graded' || s.status === 'returned' ? 'graded' : 'flagged'}`}>
                {s.status}
              </span>
              {s.rubric_scores?.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {s.rubric_scores.map((rs) => (
                    <p key={rs.id} style={{ margin: '4px 0', fontSize: 13 }}>
                      {rs.ai_reasoning} — {rs.teacher_override_points ?? rs.ai_awarded_points} pts
                    </p>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
