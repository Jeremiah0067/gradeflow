'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '../../lib/supabaseClient';
import { Icon } from '../../components/icons';

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

    // head:true means "just count, don't download the rows"
    const countOf = (table, examId, statuses) => {
      let q = supabase.from(table).select('id', { count: 'exact', head: true }).eq('exam_id', examId);
      if (statuses) q = q.in('status', statuses);
      return q.then((r) => r.count || 0);
    };
    const entries = await Promise.all(
      (examRows || []).map(async (exam) => {
        const [students, papers, toReview, approved] = await Promise.all([
          countOf('exam_students', exam.id),
          countOf('exam_papers', exam.id),
          countOf('exam_papers', exam.id, ['needs_review', 'flagged']),
          countOf('exam_papers', exam.id, ['approved']),
        ]);
        return [exam.id, { students, papers, toReview, approved }];
      })
    );
    setCounts(Object.fromEntries(entries));
    setLoading(false);
  }

  return (
    <div className="page-wide">
      <div className="page-head">
        <div>
          <h1>Marking</h1>
          <p className="subtitle">Photograph handwritten papers, let the AI mark them in one batch, then check and export the scores.</p>
        </div>
        {exams.length > 0 && (
          <button type="button" onClick={() => router.push('/marking/new')}>
            <Icon name="plus" size={18} />
            New marking job
          </button>
        )}
      </div>

      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p className="subtitle">Loading your marking jobs...</p>
      ) : exams.length === 0 ? (
        <div className="surface">
          <div className="empty">
            <span className="empty-icon">
              <Icon name="pen" size={26} />
            </span>
            <h2>Mark a whole stack of scripts in one go</h2>
            <p>
              Set up the questions, photograph the scripts, and review the AI&apos;s marks. You finish with a spreadsheet of scores for
              every student.
            </p>
            <button type="button" className="btn-lg" onClick={() => router.push('/marking/new')}>
              Create your first marking job
            </button>
          </div>
        </div>
      ) : (
        <div className="rows">
          {exams.map((exam) => {
            const c = counts[exam.id] || { students: 0, papers: 0, toReview: 0, approved: 0 };
            const pct = c.students > 0 ? Math.round((c.approved / c.students) * 100) : 0;
            return (
              <Link key={exam.id} href={`/marking/${exam.id}`} className="row row-link">
                <span className="assignment-icon">
                  <Icon name="pen" size={18} />
                </span>
                <div className="row-main">
                  <p className="row-title">{exam.title}</p>
                  <div className="meta">
                    {exam.subject && <span>{exam.subject}</span>}
                    {exam.class_label && <span>{exam.class_label}</span>}
                    <span>{TYPE_LABEL[exam.paper_type] || 'Exam'}</span>
                    <span className="num">{exam.total_marks} marks</span>
                  </div>
                  <div className="progress" style={{ marginTop: 10, maxWidth: 360 }} aria-hidden="true">
                    <span style={{ width: `${pct}%` }} />
                  </div>
                  <p className="row-meta num" style={{ marginTop: 4 }}>
                    {c.approved} of {c.students} approved
                    {c.papers < c.students ? `, ${c.students - c.papers} still to upload` : ''}
                  </p>
                </div>
                <div className="row-actions">
                  {c.toReview > 0 && <span className="chip chip-red">{c.toReview} to review</span>}
                  <Icon name="chevronRight" size={20} />
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
