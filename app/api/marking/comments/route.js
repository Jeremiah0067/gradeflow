import { createClient } from '@supabase/supabase-js';
import { callGemini, logUsage } from '../../../../lib/gradeExamPaper';
import { parseAiJson } from '../../../../lib/examGrading';
import { resolveModels } from '../../../../lib/gradingModels';
import { checkCredits } from '../../../../lib/credits';
import { cleanStudents, buildCommentPrompt, sanitizeComments } from '../../../../lib/commentPrompt';

export const maxDuration = 30;

// Drafts the "class teacher's remark" for up to 12 students in one cheap call.
// Only numbers go to the AI (results and position). Names never do.
export async function POST(req) {
  try {
    const { examId, students: rawStudents } = await req.json();
    const students = cleanStudents(rawStudents);
    if (!examId || students.length === 0) {
      return Response.json({ error: 'Nothing to write comments for.' }, { status: 400 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!serviceKey || !geminiKey) {
      return Response.json({ error: 'Server is missing SUPABASE_SERVICE_ROLE_KEY or GEMINI_API_KEY.' }, { status: 500 });
    }

    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: req.headers.get('authorization') || '' } },
    });
    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();
    if (userError || !user) return Response.json({ error: 'Not authenticated.' }, { status: 401 });

    // Goes through the security rules, so it only returns a row if the teacher owns this exam.
    const { data: owned } = await userClient.from('exams').select('id').eq('id', examId).maybeSingle();
    if (!owned) return Response.json({ error: 'Marking job not found.' }, { status: 404 });

    const service = createClient(url, serviceKey);
    const credits = await checkCredits(service, user.id);
    if (!credits.ok) return Response.json({ ok: false, budgetReached: true, error: credits.message });

    const model = resolveModels('economy', process.env).primary;
    const result = await callGemini(geminiKey, model, [{ text: buildCommentPrompt(students) }], { maxOutputTokens: 1500 });

    // The cost is recorded against the marking job (no single script is involved).
    await logUsage(service, { examId, paperId: null, model, usage: result.usage, pageCount: 0 });

    const comments = sanitizeComments(parseAiJson(result.text), students.map((s) => s.i));
    if (Object.keys(comments).length === 0) {
      return Response.json({ error: 'The AI gave no comments. Please try again.' }, { status: 502 });
    }
    return Response.json({ ok: true, comments });
  } catch (err) {
    if (err.rateLimited) {
      return Response.json({ error: 'The AI service is busy right now. Please wait a minute and try again.', rateLimited: true }, { status: 429 });
    }
    return Response.json({ error: err.message || 'Something went wrong.' }, { status: 500 });
  }
}
