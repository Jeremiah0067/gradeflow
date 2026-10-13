// Marking credits. Server-side only: import this from API routes, never from pages.
// One credit pays for one marked script. A script is charged once, even if re-graded.

import { createClient } from '@supabase/supabase-js';

export const CREDITS_PAUSED_MESSAGE =
  'Marking is paused because your school has no marking credits left. Please ask your school administrator to top up.';
export const NO_SCHOOL_MESSAGE =
  'Your account is not linked to a school yet. Please ask your school administrator to add you.';

export function serviceClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Before grading: may this teacher mark another script?
// Teachers who are not in a school yet keep working as before, unless you set
// REQUIRE_SCHOOL_CREDITS=true in your environment to make every teacher belong to a school.
export async function checkCredits(service, userId) {
  const { data: profile } = await service.from('users').select('role, school_id').eq('id', userId).maybeSingle();
  if (!profile?.school_id) {
    if (process.env.REQUIRE_SCHOOL_CREDITS === 'true') return { ok: false, message: NO_SCHOOL_MESSAGE };
    return { ok: true, schoolId: null };
  }
  const { data: school } = await service.from('schools').select('credit_balance').eq('id', profile.school_id).maybeSingle();
  if (!school || school.credit_balance <= 0) return { ok: false, message: CREDITS_PAUSED_MESSAGE };
  return { ok: true, schoolId: profile.school_id };
}

// After a script has been marked: take one credit. The database allows only one charge per script.
export async function chargeScript(service, { schoolId, paperId, examId, userId }) {
  if (!schoolId || !paperId) return;
  const { error } = await service.from('school_credits').insert({
    school_id: schoolId,
    delta: -1,
    reason: 'script_marked',
    paper_id: paperId,
    exam_id: examId || null,
    created_by: userId || null,
  });
  // 23505 means this script was already charged, which is fine.
  if (error && error.code !== '23505') console.error('Could not record credit charge:', error.message);
}

// Reads rows for a long list of ids without making the web address too long.
export async function fetchIn(db, table, select, column, ids, size = 100) {
  const rows = [];
  for (let i = 0; i < ids.length; i += size) {
    const { data } = await db.from(table).select(select).in(column, ids.slice(i, i + size));
    if (data) rows.push(...data);
  }
  return rows;
}

// Reads every row of a query, a page at a time (Supabase returns at most 1000 per request).
export async function fetchAll(buildQuery) {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await buildQuery().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}
