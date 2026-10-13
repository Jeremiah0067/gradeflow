import { getCallerFromRequest, isAdminUser } from '../../../../lib/adminAuth';
import { serviceClient, fetchIn, fetchAll } from '../../../../lib/credits';

async function requireAdmin(req) {
  const user = await getCallerFromRequest(req);
  if (!user) return { error: Response.json({ error: 'Not authenticated.' }, { status: 401 }) };
  if (!(await isAdminUser(user.id))) return { error: Response.json({ error: 'Admins only.' }, { status: 403 }) };
  return { user };
}

// Every school with its balance, usage, real AI cost and cost per script.
export async function GET(req) {
  try {
    const { error } = await requireAdmin(req);
    if (error) return error;
    const db = serviceClient();

    const { data: schools } = await db.from('schools').select('*').order('created_at', { ascending: false });
    const { data: members } = await db.from('users').select('id, name, email, role, school_id').not('school_id', 'is', null);

    // Each marked script is one ledger row that names the script, so cost can be matched exactly.
    const charges = await fetchAll(() =>
      db.from('school_credits').select('id, school_id, paper_id').eq('reason', 'script_marked').order('id')
    );
    const papersBySchool = {};
    charges.forEach((c) => {
      if (!c.paper_id) return;
      (papersBySchool[c.school_id] ||= []).push(c.paper_id);
    });

    const result = [];
    for (const s of schools || []) {
      const paperIds = papersBySchool[s.id] || [];
      const usage = await fetchIn(db, 'exam_ai_usage', 'est_cost_usd', 'paper_id', paperIds);
      const costUsd = usage.reduce((sum, u) => sum + (Number(u.est_cost_usd) || 0), 0);
      const people = (members || []).filter((m) => m.school_id === s.id);
      result.push({
        id: s.id,
        name: s.name,
        credit_balance: s.credit_balance,
        teachers: people.filter((m) => m.role === 'teacher').length,
        admins: people.filter((m) => m.role === 'school_admin').map((m) => m.name || m.email),
        scripts: charges.filter((c) => c.school_id === s.id).length,
        cost_usd: costUsd,
        cost_per_script_usd: paperIds.length > 0 ? costUsd / paperIds.length : null,
      });
    }
    return Response.json({ schools: result });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { error, user } = await requireAdmin(req);
    if (error) return error;
    const db = serviceClient();
    const body = await req.json();

    if (body.action === 'createSchool') {
      const name = String(body.name || '').trim();
      if (!name) return Response.json({ error: 'Type the school name.' }, { status: 400 });
      const { data, error: insErr } = await db.from('schools').insert({ name }).select('id').single();
      if (insErr) return Response.json({ error: insErr.message }, { status: 500 });
      return Response.json({ ok: true, id: data.id });
    }

    if (body.action === 'assignAdmin') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!body.schoolId || !email) return Response.json({ error: 'Choose a school and type an email.' }, { status: 400 });
      const { data: found } = await db
        .from('users')
        .select('id, name, email, role, school_id')
        .ilike('email', email.replace(/[%_\\]/g, '\\$&'))
        .maybeSingle();
      if (!found) return Response.json({ error: 'No account with that email. They need to sign up first.' }, { status: 404 });
      if (!['teacher', 'school_admin'].includes(found.role)) {
        return Response.json({ error: 'That account cannot become a school admin. Ask them to sign up as a teacher first.' }, { status: 400 });
      }
      if (found.school_id && found.school_id !== body.schoolId) {
        return Response.json({ error: 'That person already belongs to a different school.' }, { status: 400 });
      }
      const { error: updErr } = await db.from('users').update({ role: 'school_admin', school_id: body.schoolId }).eq('id', found.id);
      if (updErr) return Response.json({ error: updErr.message }, { status: 500 });
      return Response.json({ ok: true, name: found.name || found.email });
    }

    if (body.action === 'topUp') {
      const credits = Math.trunc(Number(body.credits));
      if (!body.schoolId || !Number.isFinite(credits) || credits === 0) {
        return Response.json({ error: 'Type a whole number of credits. Use a minus number to take credits away.' }, { status: 400 });
      }
      if (Math.abs(credits) > 1000000) return Response.json({ error: 'That number is too large.' }, { status: 400 });
      const note = String(body.note || '').trim().slice(0, 200) || null;
      const { error: insErr } = await db.from('school_credits').insert({
        school_id: body.schoolId,
        delta: credits,
        reason: credits > 0 ? 'top_up' : 'adjustment',
        note,
        created_by: user.id,
      });
      if (insErr) return Response.json({ error: insErr.message }, { status: 500 });
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'Unknown action.' }, { status: 400 });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
