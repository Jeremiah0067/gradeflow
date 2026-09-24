import { createClient } from '@supabase/supabase-js';

function getSupabaseForRequest(req) {
  const authHeader = req.headers.get('authorization') || '';
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
}

export async function POST(req) {
  try {
    const { joinCode } = await req.json();

    if (!joinCode) {
      return Response.json({ error: 'A join code is required.' }, { status: 400 });
    }

    const supabase = getSupabaseForRequest(req);

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return Response.json({ error: 'Not authenticated.' }, { status: 401 });
    }

    const { data: klass, error: classError } = await supabase
      .from('classes')
      .select('id, name')
      .eq('join_code', joinCode.trim().toLowerCase())
      .maybeSingle();

    if (classError) {
      return Response.json({ error: classError.message }, { status: 500 });
    }
    if (!klass) {
      return Response.json({ error: 'No class found with that code.' }, { status: 404 });
    }

    const { error: enrollError } = await supabase
      .from('enrollments')
      .insert({ class_id: klass.id, student_id: user.id });

    if (enrollError) {
      if (enrollError.code === '23505') {
        return Response.json({ error: 'You are already in this class.' }, { status: 409 });
      }
      return Response.json({ error: enrollError.message }, { status: 500 });
    }

    return Response.json({ class: klass });
  } catch (err) {
    return Response.json({ error: `Server error: ${err.message}` }, { status: 500 });
  }
}
