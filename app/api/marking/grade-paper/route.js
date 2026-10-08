import { createClient } from '@supabase/supabase-js';
import { gradeExamPaper } from '../../../../lib/gradeExamPaper';

// Grading one script with photos can take a while. Raise this if your Vercel plan allows more.
export const maxDuration = 60;

export async function POST(req) {
  try {
    const { paperId, force } = await req.json();
    if (!paperId) {
      return Response.json({ error: 'No script id provided.' }, { status: 400 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!serviceKey || !geminiKey) {
      return Response.json({ error: 'Server is missing SUPABASE_SERVICE_ROLE_KEY or GEMINI_API_KEY.' }, { status: 500 });
    }

    // 1. Who is calling? Use the teacher's own login token.
    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: req.headers.get('authorization') || '' } },
    });
    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();
    if (userError || !user) {
      return Response.json({ error: 'Not authenticated.' }, { status: 401 });
    }

    // 2. Does this script belong to them? This read goes through the security rules,
    //    so it only returns a row if the teacher owns the exam.
    const { data: owned } = await userClient.from('exam_papers').select('id').eq('id', paperId).maybeSingle();
    if (!owned) {
      return Response.json({ error: 'Script not found.' }, { status: 404 });
    }

    // 3. Only now use the powerful service-role client to do the grading.
    const service = createClient(url, serviceKey);
    const result = await gradeExamPaper(service, geminiKey, paperId, { force: !!force });
    return Response.json(result);
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
