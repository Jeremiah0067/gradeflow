import { createClient } from '@supabase/supabase-js';
import { getValidAccessToken, classroomFetch } from '../../../../lib/googleClassroom';

function getSupabaseForRequest(req) {
  const authHeader = req.headers.get('authorization') || '';
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
}

export async function GET(req) {
  try {
    const supabase = getSupabaseForRequest(req);

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return Response.json({ error: 'Not authenticated.' }, { status: 401 });
    }

    const accessToken = await getValidAccessToken(supabase, user.id);

    const data = await classroomFetch(accessToken, '/courses?teacherId=me&courseStates=ACTIVE');

    return Response.json({ courses: data.courses || [] });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
