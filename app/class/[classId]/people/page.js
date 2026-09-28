'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { supabase } from '../../../../lib/supabaseClient';

export default function PeoplePage() {
  const router = useRouter();
  const { classId } = useParams();

  const [profile, setProfile] = useState(null);
  const [klass, setKlass] = useState(null);
  const [teachers, setTeachers] = useState([]);
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [studentEmail, setStudentEmail] = useState('');
  const [addingStudent, setAddingStudent] = useState(false);

  const [teacherEmail, setTeacherEmail] = useState('');
  const [addingTeacher, setAddingTeacher] = useState(false);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId]);

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
    if (profileData.role !== 'teacher') {
      router.push('/dashboard');
      return;
    }
    setProfile(profileData);

    const { data: classData, error: classErr } = await supabase
      .from('classes')
      .select('*')
      .eq('id', classId)
      .single();
    if (classErr) {
      setError(classErr.message);
      setLoading(false);
      return;
    }
    setKlass(classData);

    const { data: ownerUser } = await supabase
      .from('users')
      .select('name, email')
      .eq('id', classData.teacher_id)
      .single();

    const { data: coTeachers } = await supabase
      .from('class_teachers')
      .select('id, teacher_id, users(name, email)')
      .eq('class_id', classId);

    setTeachers([
      { id: 'owner', name: ownerUser?.name, email: ownerUser?.email, isOwner: true },
      ...(coTeachers || []).map((t) => ({ id: t.id, name: t.users?.name, email: t.users?.email, isOwner: false })),
    ]);

    const { data: enrollments, error: enrollErr } = await supabase
      .from('enrollments')
      .select('id, student_id, users(name, email)')
      .eq('class_id', classId);
    if (enrollErr) setError(enrollErr.message);
    setStudents(enrollments || []);

    setLoading(false);
  }

  async function handleAddStudent(e) {
    e.preventDefault();
    setAddingStudent(true);
    setError('');
    setNotice('');

    const { data: existingUser } = await supabase
      .from('users')
      .select('id, role')
      .eq('email', studentEmail.trim())
      .maybeSingle();

    setAddingStudent(false);

    if (!existingUser) {
      setError('No GradeFlow account found with that email yet. They need to sign up first, then you can add them.');
      return;
    }
    if (existingUser.role !== 'student') {
      setError('That email belongs to a teacher account, not a student.');
      return;
    }

    const { error: insertError } = await supabase
      .from('enrollments')
      .insert({ class_id: classId, student_id: existingUser.id });

    if (insertError) {
      setError(insertError.code === '23505' ? 'That student is already in this class.' : insertError.message);
      return;
    }

    setStudentEmail('');
    setNotice('Student added.');
    load();
  }

  async function handleRemoveStudent(enrollmentId) {
    if (!confirm('Remove this student from the class?')) return;
    await supabase.from('enrollments').delete().eq('id', enrollmentId);
    load();
  }

  async function handleAddTeacher(e) {
    e.preventDefault();
    setAddingTeacher(true);
    setError('');
    setNotice('');

    const { data: existingUser } = await supabase
      .from('users')
      .select('id, role')
      .eq('email', teacherEmail.trim())
      .maybeSingle();

    setAddingTeacher(false);

    if (!existingUser) {
      setError('No GradeFlow account found with that email yet. They need to sign up first, then you can add them.');
      return;
    }
    if (existingUser.role !== 'teacher') {
      setError('That email belongs to a student account, not a teacher.');
      return;
    }
    if (existingUser.id === klass.teacher_id) {
      setError('That person already owns this class.');
      return;
    }

    const { error: insertError } = await supabase
      .from('class_teachers')
      .insert({ class_id: classId, teacher_id: existingUser.id });

    if (insertError) {
      setError(insertError.code === '23505' ? 'That teacher is already added to this class.' : insertError.message);
      return;
    }

    setTeacherEmail('');
    setNotice('Co-teacher added.');
    load();
  }

  async function handleRemoveTeacher(coTeacherRowId) {
    if (!confirm('Remove this co-teacher from the class?')) return;
    await supabase.from('class_teachers').delete().eq('id', coTeacherRowId);
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
      <div className="appbar" style={{ margin: '-24px -24px 24px -24px' }}>
        <div className="appbar-left">
          <button
            type="button"
            className="btn-secondary"
            style={{ width: 'auto', margin: 0, padding: '8px 14px' }}
            onClick={() => router.push(`/class/${classId}`)}
          >
            ← {klass?.name}
          </button>
        </div>
      </div>

      <h1>People</h1>
      <p className="subtitle">Manage who teaches and who is enrolled in this class.</p>

      {error && <p className="error-text">{error}</p>}
      {notice && <p className="subtitle" style={{ color: '#137333' }}>{notice}</p>}

      <div className="surface">
        <p className="section-heading">Teachers</p>
        {teachers.map((t) => (
          <div
            key={t.id}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '8px 0',
              borderBottom: '1px solid #f1f3f4',
            }}
          >
            <div>
              <p style={{ margin: 0, fontWeight: 500 }}>{t.name}</p>
              <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>{t.email}</p>
            </div>
            {t.isOwner ? (
              <span className="tag">Owner</span>
            ) : (
              <button
                type="button"
                className="btn-danger"
                style={{ width: 'auto', margin: 0, padding: '6px 12px', fontSize: 12 }}
                onClick={() => handleRemoveTeacher(t.id)}
              >
                Remove
              </button>
            )}
          </div>
        ))}
        <form onSubmit={handleAddTeacher} style={{ marginTop: 12 }}>
          <label>Add a co-teacher by email</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="email"
              value={teacherEmail}
              onChange={(e) => setTeacherEmail(e.target.value)}
              placeholder="teacher@school.edu"
              required
            />
            <button type="submit" disabled={addingTeacher} style={{ width: 'auto', marginTop: 0 }}>
              {addingTeacher ? 'Adding...' : 'Add'}
            </button>
          </div>
        </form>
      </div>

      <div className="surface">
        <p className="section-heading">Students ({students.length})</p>
        {students.length === 0 && <p className="subtitle">No students enrolled yet.</p>}
        {students.map((s) => (
          <div
            key={s.id}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '8px 0',
              borderBottom: '1px solid #f1f3f4',
            }}
          >
            <div>
              <p style={{ margin: 0, fontWeight: 500 }}>{s.users?.name}</p>
              <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>{s.users?.email}</p>
            </div>
            <button
              type="button"
              className="btn-danger"
              style={{ width: 'auto', margin: 0, padding: '6px 12px', fontSize: 12 }}
              onClick={() => handleRemoveStudent(s.id)}
            >
              Remove
            </button>
          </div>
        ))}
        <form onSubmit={handleAddStudent} style={{ marginTop: 12 }}>
          <label>Add a student by email</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="email"
              value={studentEmail}
              onChange={(e) => setStudentEmail(e.target.value)}
              placeholder="student@school.edu"
              required
            />
            <button type="submit" disabled={addingStudent} style={{ width: 'auto', marginTop: 0 }}>
              {addingStudent ? 'Adding...' : 'Add'}
            </button>
          </div>
        </form>
        <p className="subtitle" style={{ marginTop: 10, marginBottom: 0 }}>
          Or share the join code from the class page - students can join themselves without you adding them.
        </p>
      </div>
    </div>
  );
}
