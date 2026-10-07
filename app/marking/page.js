'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '../../lib/supabaseClient';

const TYPE_LABEL = { test: 'Test', assignment: 'Assignment', exam: 'Exam' };

export default function MarkingHubPage() {
  const router = useRouter();
  const [exams, setExams] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setLoading(true);
    setError('');

    const { data: sessionData } = await supabase.auth.getSession();
    const session = sessionData?.session;
    if (!session) {
      router.push('/login');
      return;
    }

    const { data: profile } = await supabase.from('users').select('role').eq('id', session.user.id).maybeSingle();
    if (!profile) {
      router.push('/select-role');
      return;
    }
    if (profile.role !== 'teacher') {
      router.push('/dashboard');
      return;
    }

    const { data: examRows, error: examErr } = await supabase
      .from('exams')
      .select('*')
      .eq('teacher_id', session.user.id)
      .neq('status', 'archived')
      .order('created_at', { ascending: false });

    if (examErr) {
      setError(examErr.message);
      setLoading(false);
      return;
    }

    setExams(examRows || []);

    // Count students and papers for each exam (head:true means "just count, don't download rows")
    const entries = await Promise.all(
      (examRows || []).map(async (exam) => {
        const [{ count: students }, { count: papers }, { count: toReview }] = await Promise.all([
          supabase.from('exam_students').select('id', { count: 'exact', head: true }).eq('exam_id', exam.id),
          supabase.from('exam_papers').select('id', { count: 'exact', head: true }).eq('exam_id', exam.id),
          supabase
            .from('exam_papers')
            .select('id', { count: 'exact', head: true })
            .eq('exam_id', exam.id)
            .eq('status', 'needs_review'),
        ]);
        return [exam.id, { students: students || 0, papers: papers || 0, toReview: toReview || 0 }];
      })
    );
    setCounts(Object.fromEntries(entries));
    setLoading(false);
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
      <div className="breadcrumb">
        <Link href="/dashboard">Dashboard</Link> / Marking
      </div>

      <div className="main-header" style={{ padding: 0, marginBottom: 20 }}>
        <div>
          <h1>Marking</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            Photograph handwritten tests, assignments and exams. The AI grades them in one batch, then you approve.
          </p>
        </div>
        <button type="button" style={{ width: 'auto', marginTop: 0 }} onClick={() => router.push('/marking/new')}>
          + New marking job
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {exams.length === 0 ? (
        <div className="surface" style={{ textAlign: 'center', padding: 40 }}>
          <p style={{ fontSize: 32, margin: '0 0 8px 0' }}>✍️</p>
          <p className="assignment-row-title">No marking jobs yet</p>
          <p className="subtitle">
            Create one with your questions, a marking scheme and a CSV of the students who wrote it.
          </p>
          <button type="button" style={{ width: 'auto' }} onClick={() => router.push('/marking/new')}>
            Create your first marking job
          </button>
        </div>
      ) : (
        exams.map((exam) => {
          const c = counts[exam.id] || { students: 0, papers: 0, toReview: 0 };
          return (
            <div
              key={exam.id}
              className="assignment-row"
              onClick={() => router.push(`/marking/${exam.id}`)}
            >
              <div className="assignment-icon">📝</div>
              <div style={{ flex: 1 }}>
                <p className="assignment-row-title">
                  {exam.title}
                  <span className="tag">{TYPE_LABEL[exam.paper_type] || 'Exam'}</span>
                </p>
                <p className="assignment-row-meta">
                  {[exam.subject, exam.class_label].filter(Boolean).join(' · ') || 'No subject set'} · {exam.total_marks}{' '}
                  marks · {c.papers} of {c.students} papers uploaded
                </p>
              </div>
              {c.toReview > 0 && <span className="badge badge-flagged">{c.toReview} to review</span>}
            </div>
          );
        })
      )}
    </div>
  );
}
