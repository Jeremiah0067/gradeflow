import { randomBytes } from 'crypto';
import { getCallerFromRequest } from '../../../../lib/adminAuth';
import { serviceClient, fetchAll } from '../../../../lib/credits';
import { loadMarkingReportData } from '../../../../lib/serverData';
import { buildMarkingReports, buildSnapshot } from '../../../../lib/markingReports';

export const maxDuration = 60;

const MAX_EXAMS = 30;
const MAX_STUDENTS = 1500;

const clip = (text, n) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, n);

// Branding comes from the browser, so it is cleaned before it is stored and shown to parents.
function cleanBranding(b = {}) {
  const accent = /^#[0-9a-fA-F]{6}$/.test(b.accent || '') ? b.accent : '#2340b4';
  const logo =
    typeof b.logo === 'string' && b.logo.length <= 250000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(b.logo) ? b.logo : '';
  return { school: clip(b.school, 100), term: clip(b.term, 60), accent, logo };
}

// A link nobody can guess: 144 random bits.
const newToken = () => randomBytes(18).toString('base64url');

async function requireTeacher(req, db) {
  const user = await getCallerFromRequest(req);
  if (!user) return { error: Response.json({ error: 'Not authenticated.' }, { status: 401 }) };
  const { data: profile } = await db.from('users').select('name, role, school_id').eq('id', user.id).maybeSingle();
  if (profile?.role !== 'teacher') return { error: Response.json({ error: 'Teachers only.' }, { status: 403 }) };
  return { user, profile };
}

export async function POST(req) {
  try {
    const db = serviceClient();
    const { error, user, profile } = await requireTeacher(req, db);
    if (error) return error;
    const body = await req.json();

    if (body.action === 'revoke') {
      const { error: updErr } = await db
        .from('report_batches')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', body.batchId)
        .eq('teacher_id', user.id);
      if (updErr) return Response.json({ error: updErr.message }, { status: 500 });
      return Response.json({ ok: true });
    }

    if (body.action !== 'publish') return Response.json({ error: 'Unknown action.' }, { status: 400 });

    const examIds = Array.isArray(body.examIds) ? [...new Set(body.examIds.filter((x) => typeof x === 'string'))] : [];
    if (examIds.length === 0 || examIds.length > MAX_EXAMS) {
      return Response.json({ error: `Choose between 1 and ${MAX_EXAMS} marking jobs.` }, { status: 400 });
    }

    // Every job must belong to this teacher. The report is rebuilt here from the database,
    // so nothing a browser sends can change a student's marks.
    const { data: owned } = await db.from('exams').select('id').in('id', examIds).eq('teacher_id', user.id);
    if ((owned || []).length !== examIds.length) {
      return Response.json({ error: 'One of those marking jobs is not yours.' }, { status: 403 });
    }

    const raw = await loadMarkingReportData(db, examIds);
    const report = buildMarkingReports(raw);
    if (report.students.length === 0) {
      return Response.json({ error: 'There are no approved scripts in these jobs yet.' }, { status: 400 });
    }
    if (report.students.length > MAX_STUDENTS) {
      return Response.json({ error: `Too many students at once (limit ${MAX_STUDENTS}). Choose fewer jobs.` }, { status: 400 });
    }

    const comments = {};
    Object.entries(body.comments && typeof body.comments === 'object' ? body.comments : {}).forEach(([k, v]) => {
      if (typeof k === 'string' && k.length <= 200 && typeof v === 'string') comments[k] = clip(v, 600);
    });

    const branding = cleanBranding(body.branding);
    const showPosition = body.showPosition !== false;

    const { data: batch, error: batchErr } = await db
      .from('report_batches')
      .insert({
        teacher_id: user.id,
        school_id: profile.school_id || null,
        label: clip(body.label, 120) || 'Report cards',
        branding,
      })
      .select('id')
      .single();
    if (batchErr) return Response.json({ error: batchErr.message }, { status: 500 });

    const rows = report.students.map((s) => ({
      batch_id: batch.id,
      token: newToken(),
      student_key: s.key,
      student_name: clip(s.name, 120),
      snapshot: buildSnapshot(s, { showPosition, comment: comments[s.key] || '', teacherName: profile.name || '' }),
    }));
    for (let i = 0; i < rows.length; i += 200) {
      const { error: insErr } = await db.from('report_shares').insert(rows.slice(i, i + 200));
      if (insErr) {
        await db.from('report_batches').delete().eq('id', batch.id); // do not leave a half-made batch
        return Response.json({ error: insErr.message }, { status: 500 });
      }
    }
    return Response.json({ ok: true, batchId: batch.id, count: rows.length });
  } catch (err) {
    return Response.json({ error: err.message || 'Something went wrong.' }, { status: 500 });
  }
}

export async function GET(req) {
  try {
    const db = serviceClient();
    const { error, user } = await requireTeacher(req, db);
    if (error) return error;
    const batchId = new URL(req.url).searchParams.get('batch');

    if (batchId) {
      const { data: batch } = await db
        .from('report_batches')
        .select('id, label, created_at, revoked_at')
        .eq('id', batchId)
        .eq('teacher_id', user.id)
        .maybeSingle();
      if (!batch) return Response.json({ error: 'Batch not found.' }, { status: 404 });
      const shares = await fetchAll(() =>
        db
          .from('report_shares')
          .select('id, token, student_name, student_key, view_count, first_viewed_at, expires_at')
          .eq('batch_id', batchId)
          .order('student_name')
          .order('id')
      );
      return Response.json({ batch, shares });
    }

    const { data: batches } = await db
      .from('report_batches')
      .select('id, label, created_at, revoked_at')
      .eq('teacher_id', user.id)
      .order('created_at', { ascending: false })
      .limit(30);
    const out = [];
    for (const b of batches || []) {
      const shares = await fetchAll(() => db.from('report_shares').select('id, view_count').eq('batch_id', b.id).order('id'));
      out.push({ ...b, total: shares.length, opened: shares.filter((s) => s.view_count > 0).length });
    }
    return Response.json({ batches: out });
  } catch (err) {
    return Response.json({ error: err.message || 'Something went wrong.' }, { status: 500 });
  }
}
