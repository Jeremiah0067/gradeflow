import { createClient } from '@supabase/supabase-js';
import { gradeSubmission, MAX_ATTEMPTS } from '../../../lib/gradeSubmission';

function getServiceSupabase() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

const STUCK_AFTER_MS = 3 * 60 * 1000; // 3 minutes

async function handleSweep(req) {
  const authHeader = req.headers.get('authorization') || '';
  const isCron = process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;

  const supabase = getServiceSupabase();

  if (!isCron) {
    const anonClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: userError,
    } = await anonClient.auth.getUser();

    if (userError || !user) {
      return Response.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single();
    if (profile?.role !== 'teacher') {
      return Response.json({ error: 'Unauthorized.' }, { status: 401 });
    }
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const cutoff = new Date(Date.now() - STUCK_AFTER_MS).toISOString();

  const { data: stuckSubmissions, error } = await supabase
    .from('submissions')
    .select('*')
    .eq('status', 'pending_ai_review')
    .lt('submitted_at', cutoff)
    .lt('grading_attempts', MAX_ATTEMPTS);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const results = [];
  for (const submission of stuckSubmissions || []) {
    const result = await gradeSubmission(supabase, apiKey, submission);
    results.push({ submissionId: submission.id, ...result });
  }

  return Response.json({ checked: (stuckSubmissions || []).length, results });
}

export async function GET(req) {
  return handleSweep(req);
}

export async function POST(req) {
  return handleSweep(req);
}
