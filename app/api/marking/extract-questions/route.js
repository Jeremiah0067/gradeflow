import { createClient } from '@supabase/supabase-js';
import { extractQuestionsFromFiles } from '../../../../lib/extractQuestions';

export const maxDuration = 60;

export async function POST(req) {
  try {
    const { paperPaths, schemePaths, examId } = await req.json();

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      return Response.json({ error: 'Server is missing GEMINI_API_KEY.' }, { status: 500 });
    }

    // Who is calling? Use the teacher's own login token, so storage and ownership rules apply to them.
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

    // The powerful key is only used to record the cost against an existing marking job
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const serviceClient = examId && serviceKey ? createClient(url, serviceKey) : null;

    const result = await extractQuestionsFromFiles({
      userClient,
      serviceClient,
      apiKey: geminiKey,
      userId: user.id,
      examId: examId || null,
      paperPaths,
      schemePaths: schemePaths || [],
    });
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: err.message || 'Something went wrong while reading the document.' }, { status: 400 });
  }
}
