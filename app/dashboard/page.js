'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../../lib/supabaseClient';
import { colorForClass } from '../../lib/classColors';

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

  const [googleConnected, setGoogleConnected] = useState(false);
  const [googleCourses, setGoogleCourses] = useState([]);
  const [loadingCourses, setLoadingCourses] = useState(false);
  const [importingCourseId, setImportingCourseId] = useState(null);

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
      .maybeSingle();

    if (!profileData) {
      router.push('/select-role');
      return;
    }

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

      const { data: googleAccount } = await supabase
        .from('google_accounts')
        .select('id')
        .eq('teacher_id', userId)
        .maybeSingle();

      setGoogleConnected(!!googleAccount);

      if (googleAccount) {
        loadGoogleCourses(session.access_token);
      }
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

  async function loadGoogleCourses(token) {
    setLoadingCourses(true);
    const res = await fetch('/api/google/courses', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    setLoadingCourses(false);

    if (res.ok) {
      setGoogleCourses(data.courses || []);
    }
  }

  function handleConnectGoogle() {
    if (!profile?.id) return;
    window.location.href = `/api/google/connect?teacherId=${profile.id}`;
  }

  async function handleImportCourse(googleCourseId) {
    setImportingCourseId(googleCourseId);
    setError('');

    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData?.session?.access_token;

    const res = await fetch('/api/google/import-class', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ googleCourseId }),
    });
    const data = await res.json();

    setImportingCourseId(null);

    if (!res.ok) {
      setError(data.error || 'Failed to import course.');
      return;
    }

    loadDashboard();
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

  const importedGoogleCourseIds = new Set(classes.map((c) => c.google_course_id).filter(Boolean));

  return (
    <div className="page-wide">
      <div className="appbar" style={{ margin: '-24px -24px 24px -24px' }}>
        <div className="appbar-left">
          <div className="appbar-logo">G</div>
          <span className="appbar-title">GradeFlow</span>
        </div>
        <div className="appbar-right">
          <span className="subtitle" style={{ margin: 0 }}>
            {profile?.role === 'teacher' ? 'Teacher' : 'Student'}
          </span>
          <div className="avatar-chip">{profile?.name?.[0]?.toUpperCase() || '?'}</div>
          <button
            type="button"
            className="btn-secondary"
            style={{ width: 'auto', margin: 0, padding: '8px 14px' }}
            onClick={handleLogout}
          >
            Log out
          </button>
        </div>
      </div>

      <h1 style={{ marginBottom: 20 }}>Hi, {profile?.name}</h1>

      {error && <p className="error-text">{error}</p>}

      {profile?.role === 'teacher' && (
        <div className="surface">
          <p className="section-heading">Google Classroom</p>

          {!googleConnected ? (
            <>
              <p className="subtitle">
                Connect your Google account to import an existing Classroom course and its roster.
              </p>
              <button type="button" onClick={handleConnectGoogle} style={{ width: 'auto' }}>
                Connect Google Classroom
              </button>
            </>
          ) : loadingCourses ? (
            <p className="subtitle">Loading your Classroom courses...</p>
          ) : googleCourses.length === 0 ? (
            <p className="subtitle">Connected, but no active courses were found on your Google account.</p>
          ) : (
            <>
              <p className="subtitle">Pick a course to import as a GradeFlow class.</p>
              {googleCourses.map((course) => {
                const alreadyImported = importedGoogleCourseIds.has(course.id);
                return (
                  <div
                    key={course.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '10px 0',
                      borderBottom: '1px solid #e5e7eb',
                    }}
                  >
                    <div>
                      <p style={{ margin: 0, fontWeight: 600 }}>{course.name}</p>
                      <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>{course.section}</p>
                    </div>
                    <button
                      type="button"
                      disabled={alreadyImported || importingCourseId === course.id}
                      onClick={() => handleImportCourse(course.id)}
                      style={{ width: 'auto', margin: 0, padding: '8px 14px', fontSize: 13 }}
                    >
                      {alreadyImported
                        ? 'Imported'
                        : importingCourseId === course.id
                        ? 'Importing...'
                        : 'Import'}
                    </button>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}

      {profile?.role === 'teacher' && (
        <div className="surface">
          <p className="section-heading">Create a class</p>
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
        <div className="surface">
          <p className="section-heading">Join a class</p>
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

      <p className="section-heading">Your classes</p>
      {classes.length === 0 && <p className="subtitle">No classes yet.</p>}
      <div className="class-grid">
        {classes.map((c) => (
          <div key={c.id} className="class-card" onClick={() => router.push(`/class/${c.id}`)}>
            <div className="class-card-banner" style={{ background: colorForClass(c.name) }}>
              <h3>{c.name}</h3>
              {c.subject && <p>{c.subject}</p>}
            </div>
            <div className="class-card-body">
              {c.google_course_id && <span className="tag">From Google Classroom</span>}
              {profile?.role === 'teacher' && !c.google_course_id && (
                <span className="code">Join code: {c.join_code}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
