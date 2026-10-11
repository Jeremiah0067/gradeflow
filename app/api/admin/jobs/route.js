import { createClient } from '@supabase/supabase-js';
import { getCallerFromRequest, isAdminUser } from '../../../../lib/adminAuth';

const VALID_MODES = ['standard', 'smart', 'economy'];

function serviceClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function requireAdmin(req) {
  const user = await getCallerFromRequest(req);
  if (!user) return { error: Response.json({ error: 'Not authenticated.' }, { status: 401 }) };
  if (!(await isAdminUser(user.id))) return { error: Response.json({ error: 'Admins only.' }, { status: 403 }) };
  return { user };
}

// All marking jobs with their cost so far.
export async function GET(req) {
  const { error } = await requireAdmin(req);
  if (error) return error;

  const db = serviceClient();
  const { data: exams, error: examErr } = await db
    .from('exams')
    .select('*')
    .order('created_at', { ascending: false });
  if (examErr) return Response.json({ error: examErr.message }, { status: 500 });

  // Total the logged cost per job (paged, because Supabase returns at most 1000 rows per request)
  const spent = {};
  const calls = {};
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error: uErr } = await db
      .from('exam_ai_usage')
      .select('exam_id, est_cost_usd')
      .order('id')
      .range(from, from + PAGE - 1);
    if (uErr) return Response.json({ error: uErr.message }, { status: 500 });
    for (const r of data) {
      spent[r.exam_id] = (spent[r.exam_id] || 0) + (Number(r.est_cost_usd) || 0);
      calls[r.exam_id] = (calls[r.exam_id] || 0) + 1;
    }
    if (data.length < PAGE) break;
  }

  const teacherIds = [...new Set((exams || []).map((e) => e.teacher_id).filter(Boolean))];
  const names = {};
  if (teacherIds.length > 0) {
    const { data: users } = await db.from('users').select('id, name, email').in('id', teacherIds);
    (users || []).forEach((u) => {
      names[u.id] = u.name || u.email;
    });
  }

  const jobs = (exams || []).map((e) => ({
    id: e.id,
    title: e.title,
    teacher: names[e.teacher_id] || 'Unknown',
    grading_mode: e.grading_mode || 'standard',
    budget_usd: e.budget_usd === null || e.budget_usd === undefined ? null : Number(e.budget_usd),
    spent_usd: spent[e.id] || 0,
    calls: calls[e.id] || 0,
    created_at: e.created_at,
  }));
  return Response.json({ jobs });
}

// Change a job's grading mode and/or spending limit.
export async function PATCH(req) {
  const { error } = await requireAdmin(req);
  if (error) return error;

  const body = await req.json();
  const { examId } = body;
  if (!examId) return Response.json({ error: 'No job id provided.' }, { status: 400 });

  const update = {};
  if ('grading_mode' in body) {
    if (!VALID_MODES.includes(body.grading_mode)) {
      return Response.json({ error: 'Unknown grading mode.' }, { status: 400 });
    }
    update.grading_mode = body.grading_mode;
  }
  if ('budget_usd' in body) {
    const value = body.budget_usd === null || body.budget_usd === '' ? null : Number(body.budget_usd);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      return Response.json({ error: 'The spending limit must be a number, zero or more, or empty for no limit.' }, { status: 400 });
    }
    update.budget_usd = value;
  }
  if (Object.keys(update).length === 0) {
    return Response.json({ error: 'Nothing to update.' }, { status: 400 });
  }

  const { error: updErr } = await serviceClient().from('exams').update(update).eq('id', examId);
  if (updErr) return Response.json({ error: updErr.message }, { status: 500 });
  return Response.json({ ok: true });
}
