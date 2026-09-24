'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../../lib/supabaseClient';

export default function DashboardPage() {
  const router = useRouter();
  const [profile, setProfile] = useState(null);
  const [classes, setClasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [newClassName, setNewClassName] = useState('');
  const [newClassSubject, setNewClassSubject] = useState('');
  const [creating, setCreating] = useState(false);

  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    loadDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadDashboard() {
    setLoading(true);
    setError('');

    const { data: sessionData } = await supabase.auth.getSession();
    const session = sessionData?.session;
    if (!session) {
      router.push('/login');
      return;
    }

    const userId = session.user.id;

    const { data: profileData, error: profileError } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    if (profileError) {
      setError(profileError.message);
      setLoading(false);
      return;
    }

    setProfile(profileData);

    if (profileData.role === 'teacher') {
      const { data: teacherClasses, error: classErr } = await supabase
        .from('classes')
        .select('*')
        .eq('teacher_id', userId)
        .order('created_at', { ascending: false });

      if (classErr) setError(classErr.message);
      setClasses(teacherClasses || []);
    } else {
      const { data: enrollments, error: enrollErr } = await supabase
        .from('enrollments')
        .select('class_id, classes(*)')
        .eq('student_id', userId);

      if (enrollErr) setError(enrollErr.message);
      setClasses((enrollments || []).map((e) => e.classes));
    }

    setLoading(false);
  }

  async function handleCreateClass(e) {
    e.preventDefault();
    setCreating(true);
    setError('');

    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData?.session?.access_token;

    const res = await fetch('/api/create-class', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: newClassName, subject: newClassSubject }),
    });
    const data = await res.json();

    setCreating(false);

    if (!res.ok) {
      setError(data.error || 'Failed to create class.');
      return;
    }

    setNewClassName('');
    setNewClassSubject('');
    loadDashboard();
  }

  async function handleJoinClass(e) {
    e.preventDefault();
    setJoining(true);
    setError('');

    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData?.session?.access_token;

    const res = await fetch('/api/join-class', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ joinCode }),
    });
    const data = await res.json();

    setJoining(false);

    if (!res.ok) {
      setError(data.error || 'Failed to join class.');
      return;
    }

    setJoinCode('');
    loadDashboard();
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push('/login');
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
          <h1>Hi, {profile?.name}</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            {profile?.role === 'teacher' ? 'Teacher dashboard' : 'Student dashboard'}
          </p>
        </div>
        <button style={{ width: 'auto', marginTop: 0 }} onClick={handleLogout}>
          Log out
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {profile?.role === 'teacher' && (
        <div className="page" style={{ margin: '0 0 24px 0', maxWidth: 'none' }}>
          <h1 style={{ fontSize: 16 }}>Create a class</h1>
          <form onSubmit={handleCreateClass}>
            <label>Class name</label>
            <input value={newClassName} onChange={(e) => setNewClassName(e.target.value)} required />
            <label>Subject (optional)</label>
            <input value={newClassSubject} onChange={(e) => setNewClassSubject(e.target.value)} />
            <button type="submit" disabled={creating}>
              {creating ? 'Creating...' : 'Create class'}
            </button>
          </form>
        </div>
      )}

      {profile?.role === 'student' && (
        <div className="page" style={{ margin: '0 0 24px 0', maxWidth: 'none' }}>
          <h1 style={{ fontSize: 16 }}>Join a class</h1>
          <form onSubmit={handleJoinClass}>
            <label>Class code</label>
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              placeholder="e.g. k3f9pqz"
              required
            />
            <button type="submit" disabled={joining}>
              {joining ? 'Joining...' : 'Join class'}
            </button>
          </form>
        </div>
      )}

      <h1 style={{ fontSize: 16 }}>Your classes</h1>
      {classes.length === 0 && <p className="subtitle">No classes yet.</p>}
      {classes.map((c) => (
        <div key={c.id} className="class-card" onClick={() => router.push(`/class/${c.id}`)}>
          <h3>{c.name}</h3>
          <p style={{ margin: '0 0 8px 0', color: '#6b7280' }}>{c.subject}</p>
          {profile?.role === 'teacher' && <p className="code">Join code: {c.join_code}</p>}
        </div>
      ))}
    </div>
  );
}
