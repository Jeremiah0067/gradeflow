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

function aiTotalFor(rubricScores) {
  return (rubricScores || []).reduce((sum, s) => sum + Number(s.ai_awarded_points ?? 0), 0);
}

function avgConfidence(rubricScores) {
  const withConf = (rubricScores || []).filter((s) => typeof s.ai_confidence === 'number');
  if (withConf.length === 0) return null;
  return withConf.reduce((sum, s) => sum + s.ai_confidence, 0) / withConf.length;
}

function confidenceClass(c) {
  if (c === null) return '';
  if (c >= 0.85) return 'confidence-high';
  if (c >= 0.6) return 'confidence-medium';
  return 'confidence-low';
}

function isVisibleToStudent(status) {
  return status === 'published';
}

function statusLabel(status) {
  if (status === 'pending_ai_review') return 'Submitted';
  if (status === 'needs_teacher_approval') return 'Awaiting teacher approval';
  if (status === 'published') return 'Published';
  if (status === 'needs_revision') return 'Needs revision';
  if (status === 'flagged') return 'Flagged for review';
  return status;
}

export default function AssignmentPage() {
  const router = useRouter();
  const { classId, assignmentId } = useParams();

  const [profile, setProfile] = useState(null);
  const [klass, setKlass] = useState(null);
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
  const [publishing, setPublishing] = useState(false);
  const [selectedSubmissionId, setSelectedSubmissionId] = useState(null);

  const [quizQuestions, setQuizQuestions] = useState([]);
  const [quizAnswers, setQuizAnswers] = useState({});
  const [submittingQuiz, setSubmittingQuiz] = useState(false);

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
      .select('*, rubric_criteria(*), classes(name)')
      .eq('id', assignmentId)
      .single();

    if (aErr) {
      setError(aErr.message);
      setLoading(false);
      return;
    }
    setAssignment(assignmentData);
    setKlass(assignmentData.classes);

    if (assignmentData.type === 'quiz') {
      const { data: questions } = await supabase
        .from('quiz_questions')
        .select('*')
        .eq('assignment_id', assignmentId)
        .order('sort_order', { ascending: true });
      setQuizQuestions(questions || []);
    }

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
      if (subs && subs.length > 0) {
        setSelectedSubmissionId((prev) => prev || subs[0].id);
      }
    }

    setLoading(false);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError('');

    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData.session.user.id;

    const { data: newSubmission, error: insertError } = await supabase
      .from('submissions')
      .insert({
        assignment_id: assignmentId,
        student_id: userId,
        status: 'pending_ai_review',
        raw_content: { text: answerText },
      })
      .select()
      .single();

    setSubmitting(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    fetch('/api/process-grading', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record: newSubmission }),
    }).catch(() => {});

    load();
  }

  function handleImageSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  }

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

    const { data: newSubmission, error: insertError } = await supabase
      .from('submissions')
      .insert({
        assignment_id: assignmentId,
        student_id: userId,
        status: 'pending_ai_review',
        raw_content: { image_path: path, mime_type: imageFile.type },
      })
      .select()
      .single();

    setSubmitting(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    fetch('/api/process-grading', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record: newSubmission }),
    }).catch(() => {});

    load();
  }

  function selectQuizAnswer(questionId, option) {
    setQuizAnswers((prev) => ({ ...prev, [questionId]: option }));
  }

  // Quiz grading is deterministic (compare selected option to correct_answer),
  // so no AI call, no async pipeline, no teacher approval needed - the
  // submission is published immediately.
  async function handleQuizSubmit(e) {
    e.preventDefault();
    setSubmittingQuiz(true);
    setError('');

    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData.session.user.id;

    let correctCount = 0;
    const perQuestion = quizQuestions.map((q) => {
      const selected = quizAnswers[q.id] || null;
      const isCorrect = selected === q.correct_answer;
      if (isCorrect) correctCount += 1;
      return { questionId: q.id, selected, correct: q.correct_answer, isCorrect };
    });

    const { error: insertError } = await supabase.from('submissions').insert({
      assignment_id: assignmentId,
      student_id: userId,
      status: 'published',
      raw_content: {
        quiz: true,
        score: correctCount,
        total: quizQuestions.length,
        perQuestion,
      },
    });

    setSubmittingQuiz(false);

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
    setPublishing(true);
    await supabase.from('submissions').update({ status: 'published' }).eq('id', submissionId);
    setPublishing(false);
    load();
  }

  async function handleReturnForRevision(submissionId) {
    setPublishing(true);
    await supabase.from('submissions').update({ status: 'needs_revision' }).eq('id', submissionId);
    setPublishing(false);
    load();
  }

  if (loading) {
    return (
      <div className="page-wide">
        <p>Loading...</p>
      </div>
    );
  }

  const selectedSubmission = allSubmissions.find((s) => s.id === selectedSubmissionId) || allSubmissions[0];
  const isTeacher = profile?.role === 'teacher';

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
          <button type="button" className="sidebar-link active" onClick={() => router.push(`/class/${classId}`)}>
            <span className="sidebar-link-left">📚 Classes</span>
          </button>
          {isTeacher && (
            <button type="button" className="sidebar-link" onClick={() => router.push('/inbox')}>
              <span className="sidebar-link-left">📥 Inbox</span>
            </button>
          )}
        </nav>
        <div className="sidebar-footer">
          <div className="avatar-chip">{profile?.name?.[0]?.toUpperCase() || '?'}</div>
          <div className="sidebar-footer-info">
            <p className="sidebar-footer-name">{profile?.name}</p>
            <p className="sidebar-footer-role">{isTeacher ? 'Teacher' : 'Student'}</p>
          </div>
        </div>
      </aside>

      <div className="main-content">
        <p className="breadcrumb">
          <a onClick={() => router.push('/dashboard')}>Classes</a> ›{' '}
          <a onClick={() => router.push(`/class/${classId}`)}>{klass?.name}</a> › {assignment?.title}
        </p>

        <div className="main-header">
          <div>
            <h1>{assignment?.title}</h1>
            <p className="subtitle" style={{ marginBottom: 0 }}>
              Due {assignment?.due_date ? new Date(assignment.due_date).toLocaleDateString() : '-'} ·{' '}
              {assignment?.max_points} points
              {isTeacher && ` · ${allSubmissions.length} submitted`}
            </p>
          </div>
        </div>

        {error && <p className="error-text">{error}</p>}

        <div className="two-col">
          <div>
            <div className="surface">
              <p className="section-heading">Instructions</p>
              <p style={{ margin: 0 }}>{assignment?.instructions || 'No instructions provided.'}</p>

              {assignment?.attachment_url && (
                <div style={{ marginTop: 16 }}>
                  <iframe
                    src={assignment.attachment_url}
                    title="Assignment attachment"
                    style={{ width: '100%', height: 400, border: '1px solid #e5e7eb', borderRadius: 8 }}
                  />
                  <p className="subtitle" style={{ marginTop: 6, marginBottom: 0 }}>
                    <a href={assignment.attachment_url} target="_blank" rel="noreferrer">
                      Open attachment in a new tab
                    </a>
                  </p>
                </div>
              )}
            </div>

            {assignment?.rubric_criteria?.length > 0 && (
              <div className="surface">
                <p className="section-heading">
                  Rubric · {assignment.rubric_criteria.reduce((s, c) => s + c.max_points, 0)} pts
                </p>
                {assignment.rubric_criteria.map((c) => (
                  <div key={c.id} className="criterion-row">
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <p style={{ margin: 0, fontWeight: 500 }}>
                        <span className="check-icon">✓</span>
                        {c.label}
                      </p>
                      <p style={{ margin: 0, fontWeight: 600 }}>{c.max_points} pts</p>
                    </div>
                    {c.description && (
                      <p style={{ margin: '4px 0 0 20px', fontSize: 13, color: '#5f6368' }}>{c.description}</p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {profile?.role === 'student' && assignment?.type === 'typed' && (
              <div className="surface">
                {mySubmission ? (
                  <>
                    <p className="section-heading">Your submission</p>
                    <p style={{ whiteSpace: 'pre-wrap' }}>{mySubmission.raw_content?.text}</p>
                    <span className={`badge badge-${isVisibleToStudent(mySubmission.status) ? 'graded' : 'flagged'}`}>
                      {statusLabel(mySubmission.status)}
                    </span>
                    {mySubmission.status === 'needs_revision' && (
                      <p className="subtitle" style={{ marginTop: 10 }}>
                        Your teacher has asked you to revise and resubmit this. Check with them for details.
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
                    {!isVisibleToStudent(mySubmission.status) && mySubmission.status !== 'needs_revision' && (
                      <p className="subtitle" style={{ marginTop: 12 }}>
                        Your grade will appear here once your teacher reviews and publishes it.
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <p className="section-heading">Your answer</p>
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
              <div className="surface">
                {mySubmission ? (
                  <>
                    <p className="section-heading">Your submission</p>
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
                  </>
                ) : (
                  <>
                    <p className="section-heading">Upload your answer</p>
                    <form onSubmit={handleHandwrittenSubmit}>
                      <input type="file" accept="image/*" onChange={handleImageSelect} required />
                      {imagePreview && (
                        <img
                          src={imagePreview}
                          alt="Preview"
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
              <div className="surface">
                {mySubmission ? (
                  <>
                    <p className="section-heading">Your results</p>
                    <p style={{ fontSize: 22, fontWeight: 700, margin: '0 0 16px 0' }}>
                      {mySubmission.raw_content?.score} / {mySubmission.raw_content?.total}
                    </p>
                    {quizQuestions.map((q) => {
                      const result = mySubmission.raw_content?.perQuestion?.find((p) => p.questionId === q.id);
                      return (
                        <div key={q.id} className="criterion-row">
                          <p style={{ margin: '0 0 8px 0', fontWeight: 500 }}>{q.prompt}</p>
                          {q.options.map((opt, oi) => {
                            const isSelected = result?.selected === opt;
                            const isCorrectOpt = q.correct_answer === opt;
                            let color = '#5f6368';
                            if (isCorrectOpt) color = '#137333';
                            else if (isSelected && !isCorrectOpt) color = '#d93025';
                            return (
                              <p key={oi} style={{ margin: '2px 0', fontSize: 13, color, fontWeight: isSelected || isCorrectOpt ? 600 : 400 }}>
                                {isSelected ? '● ' : '○ '}
                                {opt}
                                {isCorrectOpt ? ' ✓ correct' : isSelected ? ' (your answer)' : ''}
                              </p>
                            );
                          })}
                        </div>
                      );
                    })}
                  </>
                ) : (
                  <form onSubmit={handleQuizSubmit}>
                    <p className="section-heading">Quiz</p>
                    {quizQuestions.map((q, qi) => (
                      <div key={q.id} className="criterion-row">
                        <p style={{ margin: '0 0 8px 0', fontWeight: 500 }}>
                          {qi + 1}. {q.prompt}
                        </p>
                        {q.options.map((opt, oi) => (
                          <label key={oi} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 14, cursor: 'pointer' }}>
                            <input
                              type="radio"
                              name={`quiz-${q.id}`}
                              checked={quizAnswers[q.id] === opt}
                              onChange={() => selectQuizAnswer(q.id, opt)}
                              style={{ width: 'auto', margin: 0 }}
                              required
                            />
                            {opt}
                          </label>
                        ))}
                      </div>
                    ))}
                    <button type="submit" disabled={submittingQuiz}>
                      {submittingQuiz ? 'Submitting...' : 'Submit quiz'}
                    </button>
                  </form>
                )}
              </div>
            )}

            {isTeacher && (
              <div className="surface">
                <p className="section-heading">Submissions ({allSubmissions.length})</p>
                {allSubmissions.length === 0 && <p className="subtitle">No submissions yet.</p>}
                {allSubmissions.map((s) => (
                  <div
                    key={s.id}
                    onClick={() => setSelectedSubmissionId(s.id)}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '10px 8px',
                      borderRadius: 8,
                      cursor: 'pointer',
                      background: s.id === selectedSubmissionId ? '#e8f0fe' : 'transparent',
                      marginBottom: 4,
                    }}
                  >
                    <span style={{ fontSize: 14, fontWeight: 500 }}>{s.users?.name}</span>
                    <span className={`badge badge-${s.status === 'published' ? 'graded' : 'flagged'}`}>
                      {statusLabel(s.status)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {isTeacher && selectedSubmission && assignment?.type === 'quiz' && (
            <div className="surface">
              <p className="section-heading">Quiz result</p>
              <p style={{ margin: '0 0 14px 0', fontSize: 13, color: '#5f6368' }}>
                {selectedSubmission.users?.name} · submitted{' '}
                {selectedSubmission.submitted_at ? new Date(selectedSubmission.submitted_at).toLocaleDateString() : '-'}
              </p>
              <p style={{ fontSize: 28, fontWeight: 700, margin: '0 0 12px 0' }}>
                {selectedSubmission.raw_content?.score} / {selectedSubmission.raw_content?.total}
              </p>
              <p className="subtitle" style={{ marginBottom: 0 }}>
                Quizzes are graded automatically and published instantly - no approval needed.
              </p>
            </div>
          )}

          {isTeacher && selectedSubmission && assignment?.type !== 'quiz' && (
            <div className="surface">
              <p className="section-heading">Teacher grading</p>
              <p style={{ margin: '0 0 14px 0', fontSize: 13, color: '#5f6368' }}>
                {selectedSubmission.users?.name} · submitted{' '}
                {selectedSubmission.submitted_at ? new Date(selectedSubmission.submitted_at).toLocaleDateString() : '-'}
              </p>

              {selectedSubmission.rubric_scores?.length > 0 && (
                <div className="ai-summary-banner">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#6b21a8' }}>✨ AI grading summary</span>
                    {(() => {
                      const c = avgConfidence(selectedSubmission.rubric_scores);
                      return c !== null ? (
                        <span className={`confidence-pill ${confidenceClass(c)}`}>{Math.round(c * 100)}% confidence</span>
                      ) : null;
                    })()}
                  </div>
                  <p style={{ margin: '4px 0 0 0', fontSize: 12, color: '#5f6368' }}>Proposed total</p>
                  <p className="proposed-total">
                    {aiTotalFor(selectedSubmission.rubric_scores)} / {assignment.max_points}
                  </p>
                </div>
              )}

              {selectedSubmission.rubric_scores?.map((score) => {
                const criterion = assignment.rubric_criteria?.find((c) => c.id === score.criterion_id);
                const overridden = score.teacher_override_points !== null && score.teacher_override_points !== undefined;
                return (
                  <div key={score.id} className="criterion-review-row">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{criterion?.label}</span>
                      {typeof score.ai_confidence === 'number' && (
                        <span className={`confidence-pill ${confidenceClass(score.ai_confidence)}`}>
                          {Math.round(score.ai_confidence * 100)}% confidence
                        </span>
                      )}
                    </div>
                    <p style={{ margin: '0 0 8px 0', fontSize: 13, color: overridden ? '#92400e' : '#5f6368' }}>
                      {score.ai_reasoning}
                    </p>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: '#9aa0a6' }}>
                        AI score: {score.ai_awarded_points} / {criterion?.max_points}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 11, color: '#9aa0a6' }}>Teacher</span>
                        <input
                          type="number"
                          className="override-input"
                          value={draftValueFor(score)}
                          onChange={(e) => handleOverrideChange(score.id, e.target.value)}
                          onBlur={() => saveOverride(score)}
                        />
                        {savingOverrideId === score.id && <span style={{ fontSize: 11 }}>...</span>}
                      </div>
                    </div>
                  </div>
                );
              })}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
                <span style={{ fontWeight: 600 }}>Teacher-approved total</span>
                <span style={{ fontWeight: 700, fontSize: 20 }}>
                  {totalFor(selectedSubmission.rubric_scores)} / {assignment.max_points}
                </span>
              </div>

              {selectedSubmission.status === 'needs_teacher_approval' ? (
                <>
                  <button
                    type="button"
                    onClick={() => handlePublish(selectedSubmission.id)}
                    disabled={publishing}
                    style={{ marginTop: 16 }}
                  >
                    {publishing ? 'Publishing...' : '✓ Approve & publish grade'}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => handleReturnForRevision(selectedSubmission.id)}
                    disabled={publishing}
                  >
                    ↩ Return for revision
                  </button>
                </>
              ) : (
                <p className="subtitle" style={{ marginTop: 16, marginBottom: 0 }}>
                  Status: {statusLabel(selectedSubmission.status)}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
