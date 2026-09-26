'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { supabase } from '../../../lib/supabaseClient';

const emptyCriterion = () => ({ label: '', maxPoints: '' });

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

  const [extracting, setExtracting] = useState(false);

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

  async function handleDocumentUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    setExtracting(true);
    setError('');

    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData?.session?.access_token;

    const fileBase64 = await fileToBase64(file);

    const res = await fetch('/api/extract-document-text', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ mimeType: file.type, fileBase64 }),
    });

    const data = await res.json();
    setExtracting(false);

    if (!res.ok) {
      setError(data.error || 'Failed to extract text from the document.');
      return;
    }

    setInstructions(data.extractedText);
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

    const maxPoints = type === 'quiz' ? 0 : rubricTotal;

    const { data: assignment, error: insertError } = await supabase
      .from('assignments')
      .insert({
        class_id: classId,
        title,
        instructions,
        type,
        max_points: maxPoints,
        due_date: dueDate ? new Date(dueDate).toISOString() : null,
      })
      .select()
      .single();

    if (insertError) {
      setError(insertError.message);
      setCreating(false);
      return;
    }

    if (type !== 'quiz') {
      const criteriaRows = validCriteria.map((c, i) => ({
        assignment_id: assignment.id,
        label: c.label.trim(),
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
      <div className="top-bar">
        <div>
          <h1>{klass?.name}</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            {klass?.subject} {profile?.role === 'teacher' && `· Join code: ${klass?.join_code}`}
          </p>
        </div>
        <button style={{ width: 'auto', marginTop: 0 }} onClick={() => router.push('/dashboard')}>
          Back to dashboard
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {profile?.role === 'teacher' && (
        <div className="page" style={{ margin: '0 0 24px 0', maxWidth: 'none' }}>
          <h1 style={{ fontSize: 16 }}>New assignment</h1>
          <form onSubmit={handleCreateAssignment}>
            <label>Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} required />

            <label>Instructions</label>
            <textarea rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
            <p className="subtitle" style={{ marginTop: 4, marginBottom: 0 }}>
              Or upload a document (PDF or image) to fill this in automatically:
            </p>
            <input
              type="file"
              accept="application/pdf,image/*"
              onChange={handleDocumentUpload}
              disabled={extracting}
              style={{ marginTop: 6 }}
            />
            {extracting && <p className="subtitle" style={{ marginTop: 4 }}>Extracting text...</p>}

            <label>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="typed">Typed answer</option>
              <option value="handwritten">Handwritten (photo upload)</option>
              <option value="quiz">Quiz</option>
            </select>

            <label>Due date (optional)</label>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />

            {type === 'quiz' ? (
              <p className="subtitle" style={{ marginTop: 16 }}>
                Quiz questions aren&apos;t built into this form yet — add them via Supabase&apos;s{' '}
                <code>quiz_questions</code> table for now, referencing this assignment&apos;s id once created.
              </p>
            ) : (
              <>
                <label>Rubric</label>
                {criteria.map((c, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'flex-start' }}>
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

      <h1 style={{ fontSize: 16 }}>Assignments</h1>
      {assignments.length === 0 && <p className="subtitle">No assignments yet.</p>}
      {assignments.map((a) => (
        <div
          key={a.id}
          className="class-card"
          onClick={() => router.push(`/class/${classId}/assignments/${a.id}`)}
        >
          <h3>{a.title}</h3>
          <p style={{ margin: 0, color: '#6b7280' }}>
            {a.type} · {a.max_points} pts
            {a.due_date && ` · due ${new Date(a.due_date).toLocaleDateString()}`}
          </p>
        </div>
      ))}
    </div>
  );
}
