'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { supabase } from '../../../../lib/supabaseClient';

function scoreFor(submission) {
  if (!submission) return null;
  const total = (submission.rubric_scores || []).reduce(
    (sum, s) => sum + Number(s.teacher_override_points ?? s.ai_awarded_points ?? 0),
    0
  );
  return total;
}

function cellLabel(submission) {
  if (!submission) return { text: '—', className: '' };
  switch (submission.status) {
    case 'published':
      return { text: null, className: '' };
    case 'needs_teacher_approval':
      return { text: 'Pending', className: 'badge-flagged' };
    case 'pending_ai_review':
      return { text: 'Grading…', className: 'badge-flagged' };
    case 'flagged':
      return { text: 'Flagged', className: 'badge-flagged' };
    case 'needs_revision':
      return { text: 'Revision', className: 'badge-flagged' };
    default:
      return { text: submission.status, className: 'badge-flagged' };
  }
}

export default function GradebookPage() {
  const router = useRouter();
  const { classId } = useParams();

  const [klass, setKlass] = useState(null);
  const [assignments, setAssignments] = useState([]);
  const [students, setStudents] = useState([]);
  const [submissionsByKey, setSubmissionsByKey] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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
      router.push(`/class/${classId}`);
      return;
    }

    const { data: classData, error: classErr } = await supabase.from('classes').select('*').eq('id', classId).single();
    if (classErr) {
      setError(classErr.message);
      setLoading(false);
      return;
    }
    setKlass(classData);

    const { data: assignmentData } = await supabase
      .from('assignments')
      .select('id, title, max_points, type')
      .eq('class_id', classId)
      .order('created_at', { ascending: true });
    setAssignments(assignmentData || []);

    const { data: enrollments } = await supabase
      .from('enrollments')
      .select('student_id, users(name, email)')
      .eq('class_id', classId);
    const studentList = (enrollments || [])
      .map((e) => ({ id: e.student_id, name: e.users?.name, email: e.users?.email }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    setStudents(studentList);

    const assignmentIds = (assignmentData || []).map((a) => a.id);
    if (assignmentIds.length > 0) {
      const { data: submissions } = await supabase
        .from('submissions')
        .select('*, rubric_scores(*)')
        .in('assignment_id', assignmentIds);

      const byKey = {};
      (submissions || []).forEach((s) => {
        byKey[`${s.student_id}:${s.assignment_id}`] = s;
      });
      setSubmissionsByKey(byKey);
    }

    setLoading(false);
  }

  if (loading) {
    return (
      <div className="page-wide">
        <p>Loading...</p>
      </div>
    );
  }

  const totalPossible = assignments.reduce((sum, a) => sum + (a.max_points || 0), 0);

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
          <button type="button" className="sidebar-link" onClick={() => router.push('/inbox')}>
            <span className="sidebar-link-left">📥 Inbox</span>
          </button>
        </nav>
      </aside>

      <div className="main-content" style={{ maxWidth: 'none' }}>
        <p className="breadcrumb">
          <a onClick={() => router.push('/dashboard')}>Classes</a> ›{' '}
          <a onClick={() => router.push(`/class/${classId}`)}>{klass?.name}</a> › Gradebook
        </p>

        <div className="main-header">
          <div>
            <h1>Gradebook</h1>
            <p className="subtitle" style={{ marginBottom: 0 }}>
              {students.length} students · {assignments.length} assignments · {totalPossible} points possible
            </p>
          </div>
          <button
            type="button"
            className="btn-secondary"
            style={{ width: 'auto', marginTop: 0 }}
            onClick={() => router.push(`/class/${classId}/people`)}
          >
            Manage people
          </button>
        </div>

        {error && <p className="error-text">{error}</p>}

        {students.length === 0 || assignments.length === 0 ? (
          <p className="subtitle">
            {students.length === 0
              ? 'No students enrolled yet - add some from People.'
              : 'No assignments yet - create one from the class page.'}
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 600, background: 'white', borderRadius: 8, overflow: 'hidden' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--gf-border)' }}>
                  <th style={{ textAlign: 'left', padding: '12px 16px', fontSize: 13, color: 'var(--gf-text-secondary)', position: 'sticky', left: 0, background: 'white' }}>
                    Student
                  </th>
                  {assignments.map((a) => (
                    <th key={a.id} style={{ textAlign: 'center', padding: '12px 12px', fontSize: 12, minWidth: 110 }}>
                      <div
                        style={{ cursor: 'pointer', color: 'var(--gf-blue)' }}
                        onClick={() => router.push(`/class/${classId}/assignments/${a.id}`)}
                      >
                        {a.title}
                      </div>
                      <div style={{ color: 'var(--gf-text-secondary)', fontWeight: 400 }}>{a.max_points} pts</div>
                    </th>
                  ))}
                  <th style={{ textAlign: 'center', padding: '12px 16px', fontSize: 13, color: 'var(--gf-text-secondary)' }}>
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {students.map((student, i) => {
                  let studentTotal = 0;
                  let studentGradedCount = 0;

                  return (
                    <tr key={student.id} style={{ borderBottom: '1px solid var(--gf-border)', background: i % 2 === 0 ? 'white' : '#fafbfc' }}>
                      <td style={{ padding: '10px 16px', fontSize: 14, fontWeight: 500, position: 'sticky', left: 0, background: i % 2 === 0 ? 'white' : '#fafbfc' }}>
                        {student.name}
                      </td>
                      {assignments.map((a) => {
                        const submission = submissionsByKey[`${student.id}:${a.id}`];
                        const label = cellLabel(submission);
                        const score = submission?.status === 'published' ? scoreFor(submission) : null;
                        if (typeof score === 'number') {
                          studentTotal += score;
                          studentGradedCount += 1;
                        }
                        return (
                          <td
                            key={a.id}
                            style={{ textAlign: 'center', padding: '10px 12px', fontSize: 13, cursor: submission ? 'pointer' : 'default' }}
                            onClick={() => submission && router.push(`/class/${classId}/assignments/${a.id}`)}
                          >
                            {typeof score === 'number' ? (
                              <span style={{ fontWeight: 600 }}>
                                {score}/{a.max_points}
                              </span>
                            ) : (
                              <span className={`badge ${label.className}`} style={{ fontSize: 11 }}>
                                {label.text}
                              </span>
                            )}
                          </td>
                        );
                      })}
                      <td style={{ textAlign: 'center', padding: '10px 16px', fontSize: 14, fontWeight: 700 }}>
                        {studentGradedCount > 0 ? `${studentTotal} pts` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
