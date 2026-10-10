'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../../lib/supabaseClient';
import { colorForClass } from '../../lib/classColors';
import { Icon } from '../../components/icons';

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export default function DashboardPage() {
  const router = useRouter();
  const [profile, setProfile] = useState(null);
  const [classes, setClasses] = useState([]);
  const [classStats, setClassStats] = useState({});
  const [stats, setStats] = useState({ awaitingApproval: 0, dueThisWeek: 0, activeStudents: 0 });
  const [markingToReview, setMarkingToReview] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [showAddPanel, setShowAddPanel] = useState(false);
  const [addTab, setAddTab] = useState('create');

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
      const { data: ownedClasses, error: classErr } = await supabase
        .from('classes')
        .select('*')
        .eq('teacher_id', userId)
        .order('created_at', { ascending: false });

      if (classErr) setError(classErr.message);

      const { data: coTeacherRows } = await supabase
        .from('class_teachers')
        .select('classes(*)')
        .eq('teacher_id', userId);

      const coTaughtClasses = (coTeacherRows || []).map((r) => r.classes).filter(Boolean);

      const mergedById = new Map();
      [...(ownedClasses || []), ...coTaughtClasses].forEach((c) => mergedById.set(c.id, c));
      const allClasses = Array.from(mergedById.values());
      setClasses(allClasses);

      await loadTeacherStats(allClasses.map((c) => c.id));

      // scripts in Marking mode that are graded and waiting for the teacher
      const { count: toReview } = await supabase
        .from('exam_papers')
        .select('id', { count: 'exact', head: true })
        .in('status', ['needs_review', 'flagged']);
      setMarkingToReview(toReview || 0);

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

  async function loadTeacherStats(classIds) {
    if (classIds.length === 0) {
      setStats({ awaitingApproval: 0, dueThisWeek: 0, activeStudents: 0 });
      setClassStats({});
      return;
    }

    const { data: assignments } = await supabase
      .from('assignments')
      .select('id, class_id, due_date')
      .in('class_id', classIds);

    const { data: enrollments } = await supabase
      .from('enrollments')
      .select('class_id, student_id')
      .in('class_id', classIds);

    const assignmentIds = (assignments || []).map((a) => a.id);

    let awaitingApproval = 0;
    if (assignmentIds.length > 0) {
      const { count } = await supabase
        .from('submissions')
        .select('id', { count: 'exact', head: true })
        .in('assignment_id', assignmentIds)
        .eq('status', 'needs_teacher_approval');
      awaitingApproval = count || 0;
    }

    const now = new Date();
    const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const dueThisWeek = (assignments || []).filter((a) => {
      if (!a.due_date) return false;
      const d = new Date(a.due_date);
      return d >= now && d <= weekFromNow;
    }).length;

    const activeStudents = new Set((enrollments || []).map((e) => e.student_id)).size;

    setStats({ awaitingApproval, dueThisWeek, activeStudents });

    const perClass = {};
    classIds.forEach((id) => {
      perClass[id] = {
        assignments: (assignments || []).filter((a) => a.class_id === id).length,
        students: new Set((enrollments || []).filter((e) => e.class_id === id).map((e) => e.student_id)).size,
      };
    });
    setClassStats(perClass);
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
    setShowAddPanel(false);
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
    setShowAddPanel(false);
    loadDashboard();
  }

  async function handleDeleteClass(e, classId, isOwner) {
    e.stopPropagation();
    if (!isOwner) {
      setError('Only the class owner can delete this class - ask them, or remove yourself from People instead.');
      return;
    }
    if (!confirm('Delete this class? This also deletes all its assignments, submissions, and grades. This cannot be undone.')) {
      return;
    }
    await supabase.from('classes').delete().eq('id', classId);
    loadDashboard();
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push('/login');
  }

  function openAddPanel(tab) {
    setAddTab(tab);
    setShowAddPanel(true);
  }

  if (loading) {
    return (
      <div className="page-wide">
        <p>Loading...</p>
      </div>
    );
  }

  const importedGoogleCourseIds = new Set(classes.map((c) => c.google_course_id).filter(Boolean));
  const isTeacher = profile?.role === 'teacher';

  return (
    <div className="layout-shell">
      <div className="main-content">
        <div className="page-head">
          <div>
            <h1>{greeting()}, {profile?.name}</h1>
            <p className="subtitle">
              {isTeacher ? 'What would you like to work on?' : 'Welcome back.'}
            </p>
          </div>
          {isTeacher && (
            <button type="button" onClick={() => openAddPanel('create')}>
              <Icon name="plus" size={18} />
              Create class
            </button>
          )}
        </div>

        {error && <p className="alert alert-error" role="alert">{error}</p>}

        {isTeacher && (
          <div className="choice-grid">
            <button type="button" className="choice" onClick={() => router.push('/marking')}>
              <span className="choice-icon">
                <Icon name="pen" size={26} />
              </span>
              <span className="choice-main">
                <span className="choice-title">
                  Mark handwritten papers
                  {markingToReview > 0 && <span className="chip chip-red">{markingToReview} to review</span>}
                </span>
                <span className="choice-text">
                  Photograph a stack of scripts, let the AI mark them in one batch, then check and export the scores.
                </span>
              </span>
            </button>
            <button
              type="button"
              className="choice"
              onClick={() => document.getElementById('your-classes')?.scrollIntoView({ behavior: 'smooth' })}
            >
              <span className="choice-icon">
                <Icon name="book" size={26} />
              </span>
              <span className="choice-main">
                <span className="choice-title">
                  Work in a class
                  {stats.awaitingApproval > 0 && <span className="chip chip-red">{stats.awaitingApproval} to approve</span>}
                </span>
                <span className="choice-text">Assignments, submissions and the gradebook for your classes.</span>
              </span>
            </button>
          </div>
        )}

        {isTeacher && (
          <div className="stats-row">
            <div className="stat-card">
              <div className="stat-icon" style={{ background: 'var(--amber-tint)', color: 'var(--amber)' }}><Icon name="clock" size={20} /></div>
              <div>
                <p className="stat-value">{stats.awaitingApproval}</p>
                <p className="stat-label">Awaiting approval</p>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon" style={{ background: 'var(--blue-tint)', color: 'var(--blue)' }}><Icon name="calendar" size={20} /></div>
              <div>
                <p className="stat-value">{stats.dueThisWeek}</p>
                <p className="stat-label">Due this week</p>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon" style={{ background: 'var(--green-tint)', color: 'var(--green)' }}><Icon name="users" size={20} /></div>
              <div>
                <p className="stat-value">{stats.activeStudents}</p>
                <p className="stat-label">Active students</p>
              </div>
            </div>
          </div>
        )}

        {!isTeacher && (
          <div className="surface">
            <p className="section-heading">Join a class</p>
            <form onSubmit={handleJoinClass}>
              <label>Class code</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                  placeholder="e.g. k3f9pqz"
                  required
                />
                <button type="submit" disabled={joining} style={{ width: 'auto', marginTop: 0 }}>
                  {joining ? 'Joining...' : 'Join'}
                </button>
              </div>
            </form>
          </div>
        )}

        <div id="your-classes" className="section-head" style={{ marginBottom: 'var(--s-3)' }}>
          <h2 style={{ margin: 0 }}>Your classes</h2>
        </div>

        <div className="class-grid">
          {classes.map((c) => {
            const isOwner = isTeacher && c.teacher_id === profile.id;
            const color = colorForClass(c.name);
            const cs = classStats[c.id] || { assignments: 0, students: 0 };
            return (
              <div
                key={c.id}
                className="class-card"
                style={{ '--accent': color.text }}
                onClick={() => router.push(`/class/${c.id}`)}
              >
                <div>
                  <h3>{c.name}</h3>
                  {c.subject && <p className="class-card-sub">{c.subject}</p>}
                  {c.google_course_id ? (
                    <span className="class-card-sync">Synced from Google Classroom</span>
                  ) : isTeacher ? (
                    <span className="code">Join code {c.join_code}</span>
                  ) : null}
                  {isTeacher && (
                    <button
                      type="button"
                      className="btn-quiet card-delete"
                      onClick={(e) => handleDeleteClass(e, c.id, isOwner)}
                    >
                      Delete
                    </button>
                  )}
                </div>
                {isTeacher && (
                  <div className="class-card-meta">
                    <span>{cs.assignments} {cs.assignments === 1 ? 'assignment' : 'assignments'}</span>
                    <span>{cs.students} {cs.students === 1 ? 'student' : 'students'}</span>
                    <span>→</span>
                  </div>
                )}
              </div>
            );
          })}

          {isTeacher && (
            <div className="add-class-card" onClick={() => openAddPanel('create')}>
              <div className="add-class-icon">+</div>
              <p style={{ margin: 0, fontWeight: 600, fontSize: 14, color: 'var(--gf-text)' }}>Add a class</p>
              <p style={{ margin: 0, fontSize: 12 }}>Create a class or join with a code</p>
              <div className="add-class-actions">
                <button
                  type="button"
                  style={{ width: 'auto', marginTop: 0, padding: '6px 14px', fontSize: 12 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    openAddPanel('create');
                  }}
                >
                  Create
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ width: 'auto', marginTop: 0, padding: '6px 14px', fontSize: 12 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    openAddPanel('google');
                  }}
                >
                  Import
                </button>
              </div>
            </div>
          )}
        </div>

        {isTeacher && showAddPanel && (
          <div className="surface">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <p className="section-heading" style={{ marginBottom: 0 }}>Add a class</p>
              <button
                type="button"
                className="btn-secondary"
                style={{ width: 'auto', margin: 0, padding: '4px 10px', fontSize: 12 }}
                onClick={() => setShowAddPanel(false)}
              >
                Close
              </button>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <button
                type="button"
                className={addTab === 'create' ? '' : 'btn-secondary'}
                style={{ width: 'auto', marginTop: 0, padding: '6px 14px', fontSize: 13 }}
                onClick={() => setAddTab('create')}
              >
                Create
              </button>
              <button
                type="button"
                className={addTab === 'google' ? '' : 'btn-secondary'}
                style={{ width: 'auto', marginTop: 0, padding: '6px 14px', fontSize: 13 }}
                onClick={() => setAddTab('google')}
              >
                Import from Google Classroom
              </button>
            </div>

            {addTab === 'create' && (
              <form onSubmit={handleCreateClass}>
                <label>Class name</label>
                <input value={newClassName} onChange={(e) => setNewClassName(e.target.value)} required />
                <label>Subject (optional)</label>
                <input value={newClassSubject} onChange={(e) => setNewClassSubject(e.target.value)} />
                <button type="submit" disabled={creating}>
                  {creating ? 'Creating...' : 'Create class'}
                </button>
              </form>
            )}

            {addTab === 'google' && (
              <>
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
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
