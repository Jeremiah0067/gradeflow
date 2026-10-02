'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { supabase } from '../../../lib/supabaseClient';

const emptyCriterion = () => ({ label: '', maxPoints: '', description: '' });

export default function ClassPage() {
  const router = useRouter();
  const { classId } = useParams();

  const [profile, setProfile] = useState(null);
  const [klass, setKlass] = useState(null);
  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [type, setType] = useState('typed');
  const [dueDate, setDueDate] = useState('');
  const [creating, setCreating] = useState(false);

  const [criteria, setCriteria] = useState([emptyCriterion()]);

  const [attachmentFile, setAttachmentFile] = useState(null);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);

  const [extractingRubric, setExtractingRubric] = useState(false);

  const emptyQuizQuestion = () => ({ prompt: '', options: ['', '', '', ''], correctIndex: 0 });
  const [quizQuestions, setQuizQuestions] = useState([emptyQuizQuestion()]);

  useEffect(() => {
    loadClass();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId]);

  async function loadClass() {
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

    const { data: classData, error: classErr } = await supabase.from('classes').select('*').eq('id', classId).single();
    if (classErr) {
      setError(classErr.message);
      setLoading(false);
      return;
    }
    setKlass(classData);

    const { data: assignmentData, error: aErr } = await supabase
      .from('assignments')
      .select('*, rubric_criteria(*)')
      .eq('class_id', classId)
      .order('created_at', { ascending: false });

    if (aErr) setError(aErr.message);
    setAssignments(assignmentData || []);

    setLoading(false);
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function handleRubricDocumentUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    setExtractingRubric(true);
    setError('');

    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData?.session?.access_token;
    const fileBase64 = await fileToBase64(file);

    const res = await fetch('/api/extract-rubric', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mimeType: file.type, fileBase64 }),
    });

    const data = await res.json();
    setExtractingRubric(false);

    if (!res.ok) {
      setError(data.error || 'Failed to extract rubric from the document.');
      return;
    }

    if (!data.criteria || data.criteria.length === 0) {
      setError('No rubric criteria were found in that document.');
      return;
    }

    setCriteria(
      data.criteria.map((c) => ({
        label: c.criterion_title || '',
        maxPoints: c.max_points || '',
        description: c.description || '',
      }))
    );
  }

  function updateCriterion(index, field, value) {
    setCriteria((prev) => prev.map((c, i) => (i === index ? { ...c, [field]: value } : c)));
  }

  function addCriterion() {
    setCriteria((prev) => [...prev, emptyCriterion()]);
  }

  function removeCriterion(index) {
    setCriteria((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  function updateQuizQuestion(index, field, value) {
    setQuizQuestions((prev) => prev.map((q, i) => (i === index ? { ...q, [field]: value } : q)));
  }

  function updateQuizOption(qIndex, optIndex, value) {
    setQuizQuestions((prev) =>
      prev.map((q, i) =>
        i === qIndex ? { ...q, options: q.options.map((o, oi) => (oi === optIndex ? value : o)) } : q
      )
    );
  }

  function addQuizQuestion() {
    setQuizQuestions((prev) => [...prev, emptyQuizQuestion()]);
  }

  function removeQuizQuestion(index) {
    setQuizQuestions((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  async function handleDeleteAssignment(e, assignmentId) {
    e.stopPropagation();
    if (!confirm('Delete this assignment? This also deletes all its submissions and grades. This cannot be undone.')) return;
    await supabase.from('assignments').delete().eq('id', assignmentId);
    loadClass();
  }

  const rubricTotal = criteria.reduce((sum, c) => sum + (Number(c.maxPoints) || 0), 0);

  async function handleCreateAssignment(e) {
    e.preventDefault();
    setCreating(true);
    setError('');

    const validCriteria = criteria.filter((c) => c.label.trim() && Number(c.maxPoints) > 0);

    if (type !== 'quiz' && validCriteria.length === 0) {
      setError('Add at least one rubric criterion with a label and point value.');
      setCreating(false);
      return;
    }

    const validQuestions = quizQuestions.filter(
      (q) => q.prompt.trim() && q.options.every((o) => o.trim()) && q.options[q.correctIndex]?.trim()
    );

    if (type === 'quiz' && validQuestions.length === 0) {
      setError('Add at least one quiz question with all 4 options filled in and a correct answer selected.');
      setCreating(false);
      return;
    }

    const maxPoints = type === 'quiz' ? validQuestions.length : rubricTotal;

    let attachmentUrl = null;
    if (attachmentFile) {
      setUploadingAttachment(true);
      const path = `${classId}/${Date.now()}-${attachmentFile.name}`;
      const { error: uploadError } = await supabase.storage.from('assignment-files').upload(path, attachmentFile);
      setUploadingAttachment(false);

      if (uploadError) {
        setError(`Failed to upload attachment: ${uploadError.message}`);
        setCreating(false);
        return;
      }
      const { data: publicUrlData } = supabase.storage.from('assignment-files').getPublicUrl(path);
      attachmentUrl = publicUrlData.publicUrl;
    }

    const { data: assignment, error: insertError } = await supabase
      .from('assignments')
      .insert({
        class_id: classId,
        title,
        instructions,
        type,
        max_points: maxPoints,
        due_date: dueDate ? new Date(dueDate).toISOString() : null,
        attachment_url: attachmentUrl,
      })
      .select()
      .single();

    if (insertError) {
      setError(insertError.message);
      setCreating(false);
      return;
    }

    if (type === 'quiz') {
      const questionRows = validQuestions.map((q, i) => ({
        assignment_id: assignment.id,
        prompt: q.prompt.trim(),
        options: q.options.map((o) => o.trim()),
        correct_answer: q.options[q.correctIndex].trim(),
        sort_order: i,
      }));

      const { error: questionError } = await supabase.from('quiz_questions').insert(questionRows);

      if (questionError) {
        setError(`Assignment created, but quiz questions failed to save: ${questionError.message}`);
        setCreating(false);
        loadClass();
        return;
      }
    } else {
      const criteriaRows = validCriteria.map((c, i) => ({
        assignment_id: assignment.id,
        label: c.label.trim(),
        description: c.description || null,
        max_points: Number(c.maxPoints),
        sort_order: i,
      }));

      const { error: criteriaError } = await supabase.from('rubric_criteria').insert(criteriaRows);

      if (criteriaError) {
        setError(`Assignment created, but rubric failed to save: ${criteriaError.message}`);
        setCreating(false);
        loadClass();
        return;
      }
    }

    setCreating(false);
    setTitle('');
    setInstructions('');
    setDueDate('');
    setCriteria([emptyCriterion()]);
    setQuizQuestions([emptyQuizQuestion()]);
    setAttachmentFile(null);
    loadClass();
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
      <div className="appbar" style={{ margin: '-24px -24px 24px -24px' }}>
        <div className="appbar-left">
          <button
            type="button"
            className="btn-secondary"
            style={{ width: 'auto', margin: 0, padding: '8px 14px' }}
            onClick={() => router.push('/dashboard')}
          >
            ← Dashboard
          </button>
        </div>
        {profile?.role === 'teacher' && (
          <div className="appbar-right" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn-secondary"
              style={{ width: 'auto', margin: 0, padding: '8px 14px' }}
              onClick={() => router.push(`/class/${classId}/gradebook`)}
            >
              Gradebook
            </button>
            <button
              type="button"
              className="btn-secondary"
              style={{ width: 'auto', margin: 0, padding: '8px 14px' }}
              onClick={() => router.push(`/class/${classId}/people`)}
            >
              People
            </button>
          </div>
        )}
      </div>

      <h1>{klass?.name}</h1>
      <p className="subtitle">
        {klass?.subject} {profile?.role === 'teacher' && `· Join code: ${klass?.join_code}`}
      </p>

      {error && <p className="error-text">{error}</p>}

      {profile?.role === 'teacher' && (
        <div className="surface">
          <p className="section-heading">New assignment</p>
          <form onSubmit={handleCreateAssignment}>
            <label>Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} required />

            <label>Instructions</label>
            <textarea rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} />

            <label>Attachment (optional - students can view this file on the assignment page)</label>
            <input
              type="file"
              accept="application/pdf,.doc,.docx,image/*"
              onChange={(e) => setAttachmentFile(e.target.files?.[0] || null)}
            />
            {attachmentFile && (
              <p className="subtitle" style={{ marginTop: 4, marginBottom: 0 }}>Selected: {attachmentFile.name}</p>
            )}
            {uploadingAttachment && <p className="subtitle" style={{ marginTop: 4 }}>Uploading attachment...</p>}

            <label>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="typed">Typed answer</option>
              <option value="handwritten">Handwritten (photo upload)</option>
              <option value="quiz">Quiz</option>
            </select>

            <label>Due date (optional)</label>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />

            {type === 'quiz' ? (
              <>
                <p className="section-heading" style={{ marginTop: 20 }}>Quiz questions</p>
                {quizQuestions.map((q, qi) => (
                  <div key={qi} className="criterion-row">
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      <input
                        style={{ flex: 1 }}
                        placeholder={`Question ${qi + 1}`}
                        value={q.prompt}
                        onChange={(e) => updateQuizQuestion(qi, 'prompt', e.target.value)}
                      />
                      <button
                        type="button"
                        onClick={() => removeQuizQuestion(qi)}
                        style={{
                          width: 'auto',
                          marginTop: 0,
                          background: '#fee2e2',
                          color: '#b91c1c',
                          padding: '10px 12px',
                        }}
                      >
                        ×
                      </button>
                    </div>
                    {q.options.map((opt, oi) => (
                      <div key={oi} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                        <input
                          type="radio"
                          name={`correct-${qi}`}
                          checked={q.correctIndex === oi}
                          onChange={() => updateQuizQuestion(qi, 'correctIndex', oi)}
                          style={{ width: 'auto', margin: 0 }}
                        />
                        <input
                          style={{ flex: 1, fontSize: 13 }}
                          placeholder={`Option ${String.fromCharCode(65 + oi)}`}
                          value={opt}
                          onChange={(e) => updateQuizOption(qi, oi, e.target.value)}
                        />
                      </div>
                    ))}
                    <p className="subtitle" style={{ marginTop: 6, marginBottom: 0, fontSize: 12 }}>
                      Select the radio next to the correct answer.
                    </p>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addQuizQuestion}
                  style={{ background: 'white', color: '#1f2937', border: '1px dashed #d1d5db', marginTop: 4 }}
                >
                  + Add question
                </button>
                <p className="subtitle" style={{ marginTop: 8, marginBottom: 0 }}>
                  {quizQuestions.filter((q) => q.prompt.trim()).length} question(s), 1 point each
                </p>
              </>
            ) : (
              <>
                <p className="section-heading" style={{ marginTop: 20 }}>Rubric</p>
                <p className="subtitle" style={{ marginTop: 0, marginBottom: 6 }}>
                  Or upload an existing rubric document and let AI fill in the rows below:
                </p>
                <input
                  type="file"
                  accept="application/pdf,image/*"
                  onChange={handleRubricDocumentUpload}
                  disabled={extractingRubric}
                  style={{ marginBottom: 10 }}
                />
                {extractingRubric && <p className="subtitle">Extracting rubric...</p>}
                {criteria.map((c, i) => (
                  <div key={i} className="criterion-row">
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      <input
                        style={{ flex: 3 }}
                        placeholder="Criterion, e.g. Names both required inputs"
                        value={c.label}
                        onChange={(e) => updateCriterion(i, 'label', e.target.value)}
                      />
                      <input
                        style={{ flex: 1 }}
                        type="number"
                        min={1}
                        placeholder="Pts"
                        value={c.maxPoints}
                        onChange={(e) => updateCriterion(i, 'maxPoints', e.target.value)}
                      />
                      <button
                        type="button"
                        onClick={() => removeCriterion(i)}
                        style={{
                          width: 'auto',
                          marginTop: 0,
                          background: '#fee2e2',
                          color: '#b91c1c',
                          padding: '10px 12px',
                        }}
                      >
                        ×
                      </button>
                    </div>
                    <input
                      placeholder="Description (optional)"
                      value={c.description || ''}
                      onChange={(e) => updateCriterion(i, 'description', e.target.value)}
                      style={{ marginTop: 6, fontSize: 13 }}
                    />
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addCriterion}
                  style={{ background: 'white', color: '#1f2937', border: '1px dashed #d1d5db', marginTop: 4 }}
                >
                  + Add criterion
                </button>
                <p className="subtitle" style={{ marginTop: 8, marginBottom: 0 }}>
                  Total: {rubricTotal} pts
                </p>
              </>
            )}

            <button type="submit" disabled={creating}>
              {creating ? 'Creating...' : 'Create assignment'}
            </button>
          </form>
        </div>
      )}

      <p className="section-heading">Assignments</p>
      {assignments.length === 0 && <p className="subtitle">No assignments yet.</p>}
      {assignments.map((a) => {
        const icon = a.type === 'quiz' ? '📝' : a.type === 'handwritten' ? '✍️' : '📄';
        return (
          <div
            key={a.id}
            className="assignment-row"
            onClick={() => router.push(`/class/${classId}/assignments/${a.id}`)}
          >
            <div className="assignment-icon">{icon}</div>
            <div style={{ flex: 1 }}>
              <p className="assignment-row-title">{a.title}</p>
              <p className="assignment-row-meta">
                {a.type} · {a.max_points} pts
                {a.due_date && ` · due ${new Date(a.due_date).toLocaleDateString()}`}
              </p>
            </div>
            {profile?.role === 'teacher' && (
              <button
                type="button"
                className="btn-danger"
                style={{ width: 'auto', margin: 0, padding: '6px 12px', fontSize: 12 }}
                onClick={(e) => handleDeleteAssignment(e, a.id)}
              >
                Delete
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
