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
    const { submissionId } = await req.json();
    if (!submissionId) {
      return Response.json({ error: 'submissionId is required.' }, { status: 400 });
    }

    const supabase = getSupabaseForRequest(req);

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return Response.json({ error: 'Not authenticated.' }, { status: 401 });
    }

    const { data: submission, error: subError } = await supabase
      .from('submissions')
      .select('*, assignments(*, classes(*)), rubric_scores(*)')
      .eq('id', submissionId)
      .single();

    if (subError || !submission) {
      return Response.json({ error: subError?.message || 'Submission not found.' }, { status: 404 });
    }

    const assignment = submission.assignments;
    const klass = assignment.classes;

    if (!klass.google_course_id || !assignment.google_coursework_id) {
      return Response.json(
        { error: 'This class or assignment is not linked to Google Classroom.' },
        { status: 400 }
      );
    }

    const { data: enrollment } = await supabase
      .from('enrollments')
      .select('google_user_id')
      .eq('class_id', klass.id)
      .eq('student_id', submission.student_id)
      .single();

    if (!enrollment?.google_user_id) {
      return Response.json({ error: 'No linked Google student id for this submission.' }, { status: 400 });
    }

    const totalPoints = submission.rubric_scores.reduce(
      (sum, s) => sum + Number(s.teacher_override_points ?? s.ai_awarded_points ?? 0),
      0
    );

    const accessToken = await getValidAccessToken(supabase, user.id);

    const subsData = await classroomFetch(
      accessToken,
      `/courses/${klass.google_course_id}/courseWork/${assignment.google_coursework_id}/studentSubmissions?userId=${enrollment.google_user_id}`
    );
    const googleSubmission = (subsData.studentSubmissions || [])[0];

    if (!googleSubmission) {
      return Response.json({ error: 'No matching submission found in Google Classroom.' }, { status: 404 });
    }

    await classroomFetch(
      accessToken,
      `/courses/${klass.google_course_id}/courseWork/${assignment.google_coursework_id}/studentSubmissions/${googleSubmission.id}?updateMask=draftGrade`,
      {
        method: 'PATCH',
        body: JSON.stringify({ draftGrade: totalPoints }),
      }
    );

    return Response.json({ pushed: true, totalPoints });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
