import { createClient } from '@supabase/supabase-js';
import { gradeSubmission } from '../../../lib/gradeSubmission';

function getServiceSupabase() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export async function POST(req) {
  const supabase = getServiceSupabase();
  const apiKey = process.env.GEMINI_API_KEY;

  try {
    const payload = await req.json();
    const submissionId = payload.record?.id;

    if (!submissionId) {
      return Response.json({ error: 'No submission id provided.' }, { status: 400 });
    }

    // Always re-fetch fresh from the DB rather than trusting the payload -
    // this matters for the manual "Regrade" button, which calls this same
    // route on a submission that may have changed since the client last saw it.
    const { data: submission, error: fetchError } = await supabase
      .from('submissions')
      .select('*')
      .eq('id', submissionId)
      .single();

    if (fetchError || !submission) {
      return Response.json({ error: 'Submission not found.' }, { status: 404 });
    }

    if (!['pending_ai_review', 'flagged'].includes(submission.status)) {
      return Response.json({ skipped: true, reason: `Status is ${submission.status}, not gradable.` });
    }

    const result = await gradeSubmission(supabase, apiKey, submission);
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
