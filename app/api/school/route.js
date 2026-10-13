import { getCallerFromRequest } from '../../../lib/adminAuth';
import { serviceClient, fetchIn, fetchAll } from '../../../lib/credits';

// Only a school admin may use this, and only for their own school.
async function requireSchoolAdmin(req, db) {
  const user = await getCallerFromRequest(req);
  if (!user) return { error: Response.json({ error: 'Not authenticated.' }, { status: 401 }) };
  const { data: profile } = await db.from('users').select('role, school_id').eq('id', user.id).maybeSingle();
  if (profile?.role !== 'school_admin' || !profile.school_id) {
    return { error: Response.json({ error: 'School administrators only.' }, { status: 403 }) };
  }
  return { user, schoolId: profile.school_id };
}

export async function GET(req) {
  try {
    const db = serviceClient();
    const { error, schoolId } = await requireSchoolAdmin(req, db);
    if (error) return error;

    const { data: school } = await db.from('schools').select('id, name, credit_balance').eq('id', schoolId).maybeSingle();
    if (!school) return Response.json({ error: 'School not found.' }, { status: 404 });

    const { data: teachers } = await db
      .from('users')
      .select('id, name, email')
      .eq('school_id', schoolId)
      .eq('role', 'teacher')
      .order('name');

    // Every marked script is one ledger row, so counting rows gives usage by exam and by teacher.
    const charges = await fetchAll(() =>
      db.from('school_credits').select('id, exam_id').eq('school_id', schoolId).eq('reason', 'script_marked').order('id')
    );
    const perExamCount = {};
    charges.forEach((c) => {
      if (c.exam_id) perExamCount[c.exam_id] = (perExamCount[c.exam_id] || 0) + 1;
    });

    const { data: recent } = await db
      .from('school_credits')
      .select('id, delta, reason, note, exam_id, created_at')
      .eq('school_id', schoolId)
      .order('created_at', { ascending: false })
      .limit(40);

    const examIds = [...new Set([...Object.keys(perExamCount), ...(recent || []).map((r) => r.exam_id).filter(Boolean)])];
    const exams = await fetchIn(db, 'exams', 'id, title, subject, teacher_id', 'id', examIds);
    const examById = Object.fromEntries(exams.map((e) => [e.id, e]));
    const teacherName = Object.fromEntries((teachers || []).map((t) => [t.id, t.name || t.email]));

    const perTeacher = {};
    Object.entries(perExamCount).forEach(([examId, n]) => {
      const t = examById[examId]?.teacher_id;
      if (t) perTeacher[t] = (perTeacher[t] || 0) + n;
    });

    return Response.json({
      school,
      teachers: (teachers || []).map((t) => ({ ...t, scripts: perTeacher[t.id] || 0 })),
      totalScripts: charges.length,
      byExam: Object.entries(perExamCount)
        .map(([id, scripts]) => ({
          id,
          title: examById[id]?.title || 'Deleted job',
          subject: examById[id]?.subject || '',
          teacher: teacherName[examById[id]?.teacher_id] || '',
          scripts,
        }))
        .sort((a, b) => b.scripts - a.scripts)
        .slice(0, 25),
      recent: (recent || []).map((r) => ({
        id: r.id,
        delta: r.delta,
        reason: r.reason,
        note: r.note,
        title: examById[r.exam_id]?.title || '',
        created_at: r.created_at,
      })),
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const db = serviceClient();
    const { error, schoolId } = await requireSchoolAdmin(req, db);
    if (error) return error;
    const body = await req.json();

    if (body.action === 'addTeacher') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!email) return Response.json({ error: 'Type the teacher\'s email address.' }, { status: 400 });

      const { data: found } = await db
        .from('users')
        .select('id, name, email, role, school_id')
        .ilike('email', email.replace(/[%_\\]/g, '\\$&'))
        .maybeSingle();
      if (!found) {
        return Response.json({ error: 'No account with that email. Ask the teacher to sign up first, then add them here.' }, { status: 404 });
      }
      if (found.role !== 'teacher') {
        return Response.json({ error: 'That account is not a teacher account.' }, { status: 400 });
      }
      if (found.school_id === schoolId) {
        return Response.json({ error: 'That teacher is already in your school.' }, { status: 400 });
      }
      if (found.school_id) {
        return Response.json({ error: 'That teacher already belongs to another school.' }, { status: 400 });
      }
      const { error: updErr } = await db.from('users').update({ school_id: schoolId }).eq('id', found.id);
      if (updErr) return Response.json({ error: updErr.message }, { status: 500 });
      return Response.json({ ok: true, name: found.name || found.email });
    }

    if (body.action === 'removeTeacher') {
      const { error: updErr } = await db
        .from('users')
        .update({ school_id: null })
        .eq('id', body.userId)
        .eq('school_id', schoolId)
        .eq('role', 'teacher');
      if (updErr) return Response.json({ error: updErr.message }, { status: 500 });
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'Unknown action.' }, { status: 400 });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
