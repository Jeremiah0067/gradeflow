import { createClient } from '@supabase/supabase-js';
import { generateJoinCode } from '../../../lib/joinCode';

function getSupabaseForRequest(req) {
  const authHeader = req.headers.get('authorization') || '';
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
}

export async function POST(req) {
  try {
    const { name, subject } = await req.json();

    if (!name) {
      return Response.json({ error: 'Class name is required.' }, { status: 400 });
    }

    const supabase = getSupabaseForRequest(req);

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return Response.json({ error: 'Not authenticated.' }, { status: 401 });
    }

    let joinCode = generateJoinCode();
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: existing } = await supabase.from('classes').select('id').eq('join_code', joinCode).maybeSingle();
      if (!existing) break;
      joinCode = generateJoinCode();
    }

    const { data, error } = await supabase
      .from('classes')
      .insert({ name, subject, teacher_id: user.id, join_code: joinCode })
      .select()
      .single();

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ class: data });
  } catch (err) {
    return Response.json({ error: `Server error: ${err.message}` }, { status: 500 });
  }
}
