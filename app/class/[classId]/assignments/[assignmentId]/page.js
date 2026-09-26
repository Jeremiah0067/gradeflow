'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { supabase } from '../../../../../lib/supabaseClient';

function totalFor(rubricScores) {
  return (rubricScores || []).reduce(
    (sum, s) => sum + Number(s.teacher_override_points ?? s.ai_awarded_points ?? 0),
    0
  );
}

function isVisibleToStudent(status) {
  return status === 'published';
}

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

  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);

  const [overrideDrafts, setOverrideDrafts] = useState({});
  const [savingOverrideId, setSavingOverrideId] = useState(null);

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

  // Typed answer: insert directly, status pending_ai_review. A Supabase
  // Database Webhook (configured in the dashboard, not in code) calls
  // /api/process-grading asynchronously - this returns instantly.
  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError('');

    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData.session.user.id;

    const { error: insertError } = await supabase.from('submissions').insert({
      assignment_id: assignmentId,
      student_id: userId,
      status: 'pending_ai_review',
      raw_content: { text: answerText },
    });

    setSubmitting(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    load();
  }

  function handleImageSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  }

  // Handwritten: upload the image to the private "submissions" storage
  // bucket, then insert a row referencing its path. Grading happens later
  // via the same async webhook pipeline.
  async function handleHandwrittenSubmit(e) {
    e.preventDefault();
    if (!imageFile) return;

    setSubmitting(true);
    setError('');

    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData.session.user.id;

    const path = `${userId}/${assignmentId}-${Date.now()}-${imageFile.name}`;
    const { error: uploadError } = await supabase.storage.from('submissions').upload(path, imageFile);

    if (uploadError) {
      setSubmitting(false);
      setError(uploadError.message);
      return;
    }

    const { error: insertError } = await supabase.from('submissions').insert({
      assignment_id: assignmentId,
      student_id: userId,
      status: 'pending_ai_review',
      raw_content: { image_path: path, mime_type: imageFile.type },
    });

    setSubmitting(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    load();
  }

  function draftValueFor(score) {
    if (score.id in overrideDrafts) return overrideDrafts[score.id];
    return score.teacher_override_points ?? score.ai_awarded_points ?? '';
  }

  function handleOverrideChange(scoreId, value) {
    setOverrideDrafts((prev) => ({ ...prev, [scoreId]: value }));
  }

  async function saveOverride(score) {
    setSavingOverrideId(score.id);
    setError('');

    const value = overrideDrafts[score.id];
    const numeric = value === '' ? null : Number(value);

    const { error: updateError } = await supabase
      .from('rubric_scores')
      .update({ teacher_override_points: numeric })
      .eq('id', score.id);

    setSavingOverrideId(null);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    setOverrideDrafts((prev) => {
      const next = { ...prev };
      delete next[score.id];
      return next;
    });

    load();
  }

  async function handlePublish(submissionId) {
    await supabase.from('submissions').update({ status: 'published' }).eq('id', submissionId);
    load();
  }

  function statusLabel(status) {
    if (status === 'pending_ai_review') return 'submitted - waiting on AI grading';
    if (status === 'needs_teacher_approval') return 'AI graded - awaiting teacher approval';
    if (status === 'published') return 'graded';
    return status;
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
            {assignment?.due_date && ` · due ${new Date(assignment.due_date).toLocaleDateString()}`}
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

        {assignment?.attachment_url && (
          <div style={{ marginTop: 16 }}>
            <iframe
              src={assignment.attachment_url}
              title="Assignment attachment"
              style={{ width: '100%', height: 500, border: '1px solid #e5e7eb', borderRadius: 8 }}
            />
            <p className="subtitle" style={{ marginTop: 6 }}>
              <a href={assignment.attachment_url} target="_blank" rel="noreferrer">
                Open attachment in a new tab
              </a>{' '}
              if it doesn&apos;t display correctly above.
            </p>
          </div>
        )}

        {assignment?.rubric_criteria?.length > 0 && (
          <>
            <h1 style={{ fontSize: 16, marginTop: 20 }}>Rubric</h1>
            {assignment.rubric_criteria.map((c) => (
              <div key={c.id} style={{ margin: '4px 0' }}>
                <p style={{ margin: 0 }}>
                  {c.label} — {c.max_points} pts
                </p>
                {c.description && (
                  <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>{c.description}</p>
                )}
              </div>
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
              <span className={`badge badge-${isVisibleToStudent(mySubmission.status) ? 'graded' : 'flagged'}`}>
                {statusLabel(mySubmission.status)}
              </span>
              {isVisibleToStudent(mySubmission.status) && mySubmission.rubric_scores?.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  {mySubmission.rubric_scores.map((s) => (
                    <p key={s.id} style={{ margin: '4px 0', fontSize: 14 }}>
                      {s.ai_reasoning} — {s.teacher_override_points ?? s.ai_awarded_points} pts
                    </p>
                  ))}
                  <p style={{ fontWeight: 600, marginTop: 12 }}>
                    Total: {totalFor(mySubmission.rubric_scores)} / {assignment.max_points}
                  </p>
                </div>
              )}
              {!isVisibleToStudent(mySubmission.status) && (
                <p className="subtitle" style={{ marginTop: 12 }}>
                  Your grade will appear here once your teacher reviews and publishes it.
                </p>
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
                  {submitting ? 'Submitting...' : 'Submit'}
                </button>
              </form>
            </>
          )}
        </div>
      )}

      {profile?.role === 'student' && assignment?.type === 'handwritten' && (
        <div className="page" style={{ margin: 0, maxWidth: 'none' }}>
          {mySubmission ? (
            <>
              <h1 style={{ fontSize: 16 }}>Your submission</h1>
              <span className={`badge badge-${isVisibleToStudent(mySubmission.status) ? 'graded' : 'flagged'}`}>
                {statusLabel(mySubmission.status)}
              </span>
              {mySubmission.status === 'flagged' && (
                <p className="subtitle" style={{ marginTop: 12 }}>
                  This submission needs your teacher to review it manually before a grade is shown.
                </p>
              )}
              {isVisibleToStudent(mySubmission.status) && mySubmission.rubric_scores?.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  {mySubmission.rubric_scores.map((s) => (
                    <p key={s.id} style={{ margin: '4px 0', fontSize: 14 }}>
                      {s.ai_reasoning} — {s.teacher_override_points ?? s.ai_awarded_points} pts
                    </p>
                  ))}
                  <p style={{ fontWeight: 600, marginTop: 12 }}>
                    Total: {totalFor(mySubmission.rubric_scores)} / {assignment.max_points}
                  </p>
                </div>
              )}
            </>
          ) : (
            <>
              <h1 style={{ fontSize: 16 }}>Upload your answer</h1>
              <p className="subtitle">Take a photo or upload an image of your handwritten answer.</p>
              <form onSubmit={handleHandwrittenSubmit}>
                <input type="file" accept="image/*" onChange={handleImageSelect} required />
                {imagePreview && (
                  <img
                    src={imagePreview}
                    alt="Preview of your handwritten answer"
                    style={{ maxWidth: '100%', marginTop: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
                  />
                )}
                <button type="submit" disabled={submitting || !imageFile}>
                  {submitting ? 'Uploading...' : 'Submit'}
                </button>
              </form>
            </>
          )}
        </div>
      )}

      {profile?.role === 'student' && assignment?.type === 'quiz' && (
        <div className="page" style={{ margin: 0, maxWidth: 'none' }}>
          <p className="subtitle">
            Quiz-taking isn&apos;t wired up in this starter yet — question building and deterministic grading are
            the next piece to build.
          </p>
        </div>
      )}

      {profile?.role === 'teacher' && (
        <div className="page" style={{ margin: 0, maxWidth: 'none' }}>
          <h1 style={{ fontSize: 16 }}>Submissions ({allSubmissions.length})</h1>
          {allSubmissions.length === 0 && <p className="subtitle">No submissions yet.</p>}
          {allSubmissions.map((s) => (
            <div key={s.id} style={{ borderBottom: '1px solid #e5e7eb', padding: '16px 0' }}>
              <p style={{ margin: '0 0 4px 0', fontWeight: 600 }}>{s.users?.name}</p>
              <p style={{ margin: '0 0 8px 0', whiteSpace: 'pre-wrap', fontSize: 14 }}>{s.raw_content?.text}</p>
              <span className={`badge badge-${s.status === 'published' ? 'graded' : 'flagged'}`}>
                {statusLabel(s.status)}
              </span>

              {s.rubric_scores?.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  {s.rubric_scores.map((score) => {
                    const overridden = score.teacher_override_points !== null && score.teacher_override_points !== undefined;
                    return (
                      <div
                        key={score.id}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, fontSize: 13 }}
                      >
                        <div style={{ flex: 1 }}>
                          <span style={{ color: overridden ? '#92400e' : 'inherit' }}>{score.ai_reasoning}</span>
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
                          onClick={() => saveOverride(score)}
                          disabled={savingOverrideId === score.id}
                          style={{ width: 'auto', margin: 0, padding: '6px 10px', fontSize: 12 }}
                        >
                          {savingOverrideId === score.id ? 'Saving...' : 'Save'}
                        </button>
                      </div>
                    );
                  })}
                  <p style={{ fontWeight: 600, marginTop: 8 }}>
                    Total: {totalFor(s.rubric_scores)} / {assignment.max_points}
                  </p>
                </div>
              )}

              {s.status === 'needs_teacher_approval' && (
                <button type="button" onClick={() => handlePublish(s.id)} style={{ marginTop: 10, width: 'auto' }}>
                  Approve & publish
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
