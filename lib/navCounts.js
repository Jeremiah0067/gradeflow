// The two numbers shown as badges in the navigation:
//   inbox:   classroom submissions waiting for the teacher's approval
//   marking: marking-mode scripts that are graded and waiting for review
// The inbox count uses the same class rules as the dashboard (owned and co-taught classes).

export async function loadNavCounts(supabase, userId) {
  const [{ data: owned }, { data: coRows }, { count: marking }] = await Promise.all([
    supabase.from('classes').select('id').eq('teacher_id', userId),
    supabase.from('class_teachers').select('class_id').eq('teacher_id', userId),
    supabase.from('exam_papers').select('id', { count: 'exact', head: true }).in('status', ['needs_review', 'flagged']),
  ]);

  const classIds = [...new Set([...(owned || []).map((c) => c.id), ...(coRows || []).map((r) => r.class_id)])];

  let inbox = 0;
  if (classIds.length > 0) {
    const { data: assignments } = await supabase.from('assignments').select('id').in('class_id', classIds);
    const assignmentIds = (assignments || []).map((a) => a.id);
    if (assignmentIds.length > 0) {
      const { count } = await supabase
        .from('submissions')
        .select('id', { count: 'exact', head: true })
        .in('assignment_id', assignmentIds)
        .eq('status', 'needs_teacher_approval');
      inbox = count || 0;
    }
  }

  return { inbox, marking: marking || 0 };
}
