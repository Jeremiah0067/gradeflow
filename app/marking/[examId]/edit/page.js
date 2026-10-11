'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '../../../../lib/supabaseClient';
import QuestionsEditor from '../../../../components/marking/QuestionsEditor';
import {
  rowsToQuestions,
  validateQuestions,
  totalMarks,
  questionToColumns,
  describeChanges,
} from '../../../../lib/questionForm';

export default function EditMarkingJobPage() {
  const router = useRouter();
  const { examId } = useParams();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);

  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [classLabel, setClassLabel] = useState('');
  const [paperType, setPaperType] = useState('exam');
  const [extraInstructions, setExtraInstructions] = useState('');
  const [questions, setQuestions] = useState([]);
  const [original, setOriginal] = useState([]); // the questions as saved, to work out what the teacher changed
  const [gradedCount, setGradedCount] = useState(0);

  useEffect(() => {
    (async () => {
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

      const { data: exam } = await supabase.from('exams').select('*').eq('id', examId).maybeSingle();
      if (!exam) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      const { data: rows } = await supabase.from('exam_questions').select('*').eq('exam_id', examId).order('position');
      const { count } = await supabase
        .from('exam_papers')
        .select('id', { count: 'exact', head: true })
        .eq('exam_id', examId)
        .in('status', ['needs_review', 'flagged', 'approved']);

      setTitle(exam.title || '');
      setSubject(exam.subject || '');
      setClassLabel(exam.class_label || '');
      setPaperType(exam.paper_type || 'exam');
      setExtraInstructions(exam.extra_instructions || '');
      const cards = rowsToQuestions(rows || []);
      setQuestions(cards);
      setOriginal(cards.map((c) => ({ ...c })));
      setGradedCount(count || 0);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId]);

  async function handleSave(e) {
    e.preventDefault();
    setError('');

    if (!title.trim()) {
      setError('Give this marking job a title.');
      return;
    }
    const problem = validateQuestions(questions);
    if (problem) {
      setError(problem);
      return;
    }

    const { removed, added, changedScoring } = describeChanges(original, questions);

    if (gradedCount > 0 && (removed.length > 0 || changedScoring.length > 0)) {
      const lines = [`${gradedCount} script${gradedCount === 1 ? ' is' : 's are'} already graded.`, ''];
      if (changedScoring.length > 0) lines.push(`You changed ${changedScoring.length} question${changedScoring.length === 1 ? '' : 's'} in a way that affects marking.`);
      if (removed.length > 0) lines.push(`You removed ${removed.length} question${removed.length === 1 ? '' : 's'}, so the marks already given for ${removed.length === 1 ? 'it' : 'them'} will be deleted.`);
      lines.push('', 'Scripts that are already graded will NOT change by themselves. Open a script in Review and use "Grade again with AI" to mark it with the new questions.', '', 'Save these changes?');
      if (!confirm(lines.join('\n'))) return;
    }

    setSaving(true);
    try {
      // 1. Remove deleted questions (the marks given for them are removed with them)
      if (removed.length > 0) {
        const { error: delErr } = await supabase
          .from('exam_questions')
          .delete()
          .in('id', removed.map((q) => q.id));
        if (delErr) throw new Error(delErr.message);
      }

      const indexed = questions.map((q, i) => ({ q, i }));
      const kept = indexed.filter(({ q }) => q.id);
      const fresh = indexed.filter(({ q }) => !q.id);

      // 2. Each question must have its own position within the job. To reorder safely, first park the
      //    kept questions at positions far above any in use, then give them their final positions.
      if (kept.length > 0) {
        const { data: top } = await supabase
          .from('exam_questions')
          .select('position')
          .eq('exam_id', examId)
          .order('position', { ascending: false })
          .limit(1);
        const parking = (top?.[0]?.position || 0) + 1000;
        const parked = await Promise.all(
          kept.map(({ q, i }) => supabase.from('exam_questions').update({ position: parking + i }).eq('id', q.id))
        );
        const parkErr = parked.find((r) => r.error);
        if (parkErr) throw new Error(parkErr.error.message);

        // 3. Final values and positions for the kept questions
        const written = await Promise.all(
          kept.map(({ q, i }) =>
            supabase.from('exam_questions').update({ ...questionToColumns(q), position: i + 1 }).eq('id', q.id)
          )
        );
        const writeErr = written.find((r) => r.error);
        if (writeErr) throw new Error(writeErr.error.message);
      }

      // 4. New questions
      if (fresh.length > 0) {
        const { error: insErr } = await supabase
          .from('exam_questions')
          .insert(fresh.map(({ q, i }) => ({ ...questionToColumns(q), exam_id: examId, position: i + 1 })));
        if (insErr) throw new Error(insErr.message);
      }

      // 5. The job's own details
      const { error: examErr } = await supabase
        .from('exams')
        .update({
          title: title.trim(),
          subject: subject.trim() || null,
          class_label: classLabel.trim() || null,
          paper_type: paperType,
          extra_instructions: extraInstructions.trim() || null,
          total_marks: totalMarks(questions),
        })
        .eq('id', examId);
      if (examErr) throw new Error(examErr.message);

      router.push(`/marking/${examId}`);
    } catch (err) {
      setError(`Could not save everything: ${err.message}. Your edits are still on this page. Try saving again.`);
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="page-wide">
        <p>Loading...</p>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="page-wide">
        <div className="breadcrumb">
          <Link href="/marking">Marking</Link>
        </div>
        <p className="error-text">This marking job was not found.</p>
      </div>
    );
  }

  return (
    <div className="page-narrow">
      <div className="breadcrumb">
        <Link href="/marking">Marking</Link> / <Link href={`/marking/${examId}`}>{title || 'Marking job'}</Link> / Edit
      </div>
      <div className="page-head">
        <div>
          <h1>Edit questions and marking guide</h1>
          <p className="subtitle">
            {gradedCount > 0
              ? `${gradedCount} ${gradedCount === 1 ? 'script is' : 'scripts are'} already graded. Changes do not alter them by themselves. After you save, use "Grade again with AI" on a script.`
              : 'Nothing has been graded yet, so you can change anything safely.'}
          </p>
        </div>
      </div>

      <form onSubmit={handleSave}>
        <div className="surface">
          <h2>Details</h2>

          <label htmlFor="e-title">Title</label>
          <input id="e-title" value={title} onChange={(e) => setTitle(e.target.value)} />

          <div className="form-grid-3">
            <div>
              <label htmlFor="e-subject">Subject</label>
              <input id="e-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Optional" />
            </div>
            <div>
              <label htmlFor="e-class">Class or level</label>
              <input id="e-class" value={classLabel} onChange={(e) => setClassLabel(e.target.value)} placeholder="Optional" />
            </div>
            <div>
              <label htmlFor="e-type">Type</label>
              <select id="e-type" value={paperType} onChange={(e) => setPaperType(e.target.value)}>
                <option value="test">Test</option>
                <option value="assignment">Assignment</option>
                <option value="exam">Exam</option>
              </select>
            </div>
          </div>

          <label htmlFor="e-extra">
            Extra marking instructions <span className="hint" style={{ display: 'inline' }}>(optional)</span>
          </label>
          <textarea
            id="e-extra"
            rows={3}
            value={extraInstructions}
            onChange={(e) => setExtraInstructions(e.target.value)}
            placeholder="e.g. Award method marks even if the final answer is wrong. Ignore spelling mistakes."
          />
        </div>

        <QuestionsEditor questions={questions} setQuestions={setQuestions} examId={examId} />

        {error && <p className="alert alert-error" role="alert">{error}</p>}

        <div style={{ display: 'flex', gap: 'var(--s-3)', flexWrap: 'wrap' }}>
          <button type="submit" className="btn-lg" style={{ marginTop: 0 }} disabled={saving}>
            {saving ? 'Saving...' : 'Save changes'}
          </button>
          <button type="button" className="btn-secondary btn-lg" disabled={saving} onClick={() => router.push(`/marking/${examId}`)}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
