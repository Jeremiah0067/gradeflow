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

    return Response.json({
      class: klass,
      importedStudentCount: students.length,
      students: students.map((s) => ({
        googleUserId: s.userId,
        name: s.profile?.name?.fullName,
        email: s.profile?.emailAddress,
      })),
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
