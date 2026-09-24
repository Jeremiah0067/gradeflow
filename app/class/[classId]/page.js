'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { supabase } from '../../../lib/supabaseClient';

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
  const [maxPoints, setMaxPoints] = useState(10);
  const [creating, setCreating] = useState(false);

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
      .select('*')
      .eq('class_id', classId)
      .order('created_at', { ascending: false });

    if (aErr) setError(aErr.message);
    setAssignments(assignmentData || []);

    setLoading(false);
  }

  async function handleCreateAssignment(e) {
    e.preventDefault();
    setCreating(true);
    setError('');

    const { error: insertError } = await supabase.from('assignments').insert({
      class_id: classId,
      title,
      instructions,
      type,
      max_points: Number(maxPoints),
    });

    setCreating(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    setTitle('');
    setInstructions('');
    setMaxPoints(10);
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

            <label>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="typed">Typed answer</option>
              <option value="handwritten">Handwritten (photo upload)</option>
              <option value="quiz">Quiz</option>
            </select>

            <label>Max points</label>
            <input type="number" value={maxPoints} onChange={(e) => setMaxPoints(e.target.value)} min={1} />

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
