import { createClient } from '@supabase/supabase-js';
import { getValidAccessToken, classroomFetch } from '../../../../lib/googleClassroom';

function getSupabaseForRequest(req) {
  const authHeader = req.headers.get('authorization') || '';
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
}

export async function POST(req) {
  try {
    const { googleCourseId } = await req.json();
    if (!googleCourseId) {
      return Response.json({ error: 'googleCourseId is required.' }, { status: 400 });
    }

    const supabase = getSupabaseForRequest(req);

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return Response.json({ error: 'Not authenticated.' }, { status: 401 });
    }

    const accessToken = await getValidAccessToken(supabase, user.id);

    const course = await classroomFetch(accessToken, `/courses/${googleCourseId}`);

    const { data: existingClass } = await supabase
      .from('classes')
      .select('*')
      .eq('google_course_id', googleCourseId)
      .maybeSingle();

    let klass = existingClass;
    if (!klass) {
      const { data: newClass, error: classError } = await supabase
        .from('classes')
        .insert({
          name: course.name,
          subject: course.section || null,
          teacher_id: user.id,
          join_code: `gc-${googleCourseId.slice(-6)}`,
          google_course_id: googleCourseId,
        })
        .select()
        .single();

      if (classError) {
        return Response.json({ error: classError.message }, { status: 500 });
      }
      klass = newClass;
    }

    const rosterData = await classroomFetch(accessToken, `/courses/${googleCourseId}/students`);
    const students = rosterData.students || [];

    const enrolledByGoogleId = {};
    for (const s of students) {
      const email = s.profile?.emailAddress;
      const googleUserId = s.userId;
      if (!email) continue;

      const { data: existingUser } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
      if (!existingUser) continue;

      const { data: existingEnrollment } = await supabase
        .from('enrollments')
        .select('id')
        .eq('class_id', klass.id)
        .eq('student_id', existingUser.id)
        .maybeSingle();

      if (!existingEnrollment) {
        await supabase.from('enrollments').insert({
          class_id: klass.id,
          student_id: existingUser.id,
          google_user_id: googleUserId,
        });
      } else {
        await supabase.from('enrollments').update({ google_user_id: googleUserId }).eq('id', existingEnrollment.id);
      }

      enrolledByGoogleId[googleUserId] = existingUser.id;
    }

    const courseWorkData = await classroomFetch(accessToken, `/courses/${googleCourseId}/courseWork`);
    const courseWorkItems = courseWorkData.courseWork || [];

    let importedAssignments = 0;
    let importedGrades = 0;

    for (const cw of courseWorkItems) {
      const { data: existingAssignment } = await supabase
        .from('assignments')
        .select('*')
        .eq('google_coursework_id', cw.id)
        .maybeSingle();

      let assignment = existingAssignment;
      if (!assignment) {
        const { data: newAssignment, error: aError } = await supabase
          .from('assignments')
          .insert({
            class_id: klass.id,
            title: cw.title,
            instructions: cw.description || null,
            type: 'typed',
            max_points: cw.maxPoints || 0,
            due_date: cw.dueDate
              ? new Date(cw.dueDate.year, cw.dueDate.month - 1, cw.dueDate.day).toISOString()
              : null,
            google_coursework_id: cw.id,
          })
          .select()
          .single();

        if (aError) continue;
        assignment = newAssignment;
        importedAssignments++;

        await supabase.from('rubric_criteria').insert({
          assignment_id: assignment.id,
          label: 'Imported grade',
          max_points: cw.maxPoints || 0,
          sort_order: 0,
        });
      }

      const submissionsData = await classroomFetch(
        accessToken,
        `/courses/${googleCourseId}/courseWork/${cw.id}/studentSubmissions`
      );

      for (const sub of submissionsData.studentSubmissions || []) {
        const studentId = enrolledByGoogleId[sub.userId];
        if (!studentId || sub.assignedGrade === undefined || sub.assignedGrade === null) continue;

        const { data: existingSubmission } = await supabase
          .from('submissions')
          .select('id')
          .eq('assignment_id', assignment.id)
          .eq('student_id', studentId)
          .maybeSingle();

        if (existingSubmission) continue;

        const { data: newSubmission, error: sError } = await supabase
          .from('submissions')
          .insert({
            assignment_id: assignment.id,
            student_id: studentId,
            status: 'published',
            raw_content: { note: 'Imported from Google Classroom' },
          })
          .select()
          .single();

        if (sError) continue;

        const { data: criterion } = await supabase
          .from('rubric_criteria')
          .select('id')
          .eq('assignment_id', assignment.id)
          .limit(1)
          .single();

        if (criterion) {
          await supabase.from('rubric_scores').insert({
            submission_id: newSubmission.id,
            criterion_id: criterion.id,
            ai_awarded_points: sub.assignedGrade,
            ai_reasoning: 'Imported from Google Classroom',
          });
        }

        importedGrades++;
      }
    }

    return Response.json({
      class: klass,
      importedStudentCount: Object.keys(enrolledByGoogleId).length,
      importedAssignments,
      importedGrades,
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
