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

  const [extracting, setExtracting] = useState(false);

  const [attachmentFile, setAttachmentFile] = useState(null);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);

  const [extractingRubric, setExtractingRubric] = useState(false);

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

    if (type !== 'quiz') {
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

            <label>Attachment (optional - shown to students above their submission box)</label>
            <input
              type="file"
              accept="application/pdf,.doc,.docx,image/*"
              onChange={(e) => setAttachmentFile(e.target.files?.[0] || null)}
            />
            {uploadingAttachment && <p className="subtitle" style={{ marginTop: 4 }}>Uploading attachment...</p>}

            {type === 'quiz' ? (
              <p className="subtitle" style={{ marginTop: 16 }}>
                Quiz questions aren&apos;t built into this form yet — add them via Supabase&apos;s{' '}
                <code>quiz_questions</code> table for now, referencing this assignment&apos;s id once created.
              </p>
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
            <div>
              <p className="assignment-row-title">{a.title}</p>
              <p className="assignment-row-meta">
                {a.type} · {a.max_points} pts
                {a.due_date && ` · due ${new Date(a.due_date).toLocaleDateString()}`}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
