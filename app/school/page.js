'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../../lib/supabaseClient';

async function schoolFetch(method, body) {
  const { data } = await supabase.auth.getSession();
  const res = await fetch('/api/school', {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data?.session?.access_token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status}).`);
  return json;
}

const REASON = { top_up: 'Credits added', adjustment: 'Adjustment', script_marked: 'Script marked' };
const LOW_CREDITS = 50;

export default function SchoolPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [info, setInfo] = useState(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function init() {
    const { data: sessionData } = await supabase.auth.getSession();
    const session = sessionData?.session;
    if (!session) {
      router.push('/login');
      return;
    }
    const { data: profile } = await supabase.from('users').select('role').eq('id', session.user.id).maybeSingle();
    if (profile?.role !== 'school_admin') {
      router.push('/dashboard');
      return;
    }
    setReady(true);
    await load();
  }

  async function load() {
    try {
      setInfo(await schoolFetch('GET'));
    } catch (err) {
      setError(err.message);
    }
  }

  async function addTeacher(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await schoolFetch('POST', { action: 'addTeacher', email });
      setNotice(`${res.name} was added to your school.`);
      setEmail('');
      await load();
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  async function removeTeacher(teacher) {
    if (!confirm(`Remove ${teacher.name || teacher.email} from your school? They will no longer be able to mark scripts with your credits.`)) return;
    setError('');
    setNotice('');
    try {
      await schoolFetch('POST', { action: 'removeTeacher', userId: teacher.id });
      setNotice(`${teacher.name || teacher.email} was removed.`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!ready || !info) {
    return (
      <div className="page-wide">
        {error ? <p className="alert alert-error" role="alert">{error}</p> : <p>Loading...</p>}
      </div>
    );
  }

  const balance = info.school.credit_balance;
  const low = balance <= LOW_CREDITS;

  return (
    <div className="page-wide">
      <div className="page-head">
        <div>
          <h1>{info.school.name}</h1>
          <div className="meta">
            <span className="num">{info.teachers.length} {info.teachers.length === 1 ? 'teacher' : 'teachers'}</span>
            <span className="num">{info.totalScripts} scripts marked</span>
          </div>
        </div>
      </div>

      {error && <p className="alert alert-error" role="alert">{error}</p>}
      {notice && <p className="alert alert-ok" role="status">{notice}</p>}

      <div
        className="surface"
        style={{ borderLeft: `6px solid ${balance <= 0 ? 'var(--red)' : low ? '#b9770e' : 'var(--green)'}` }}
      >
        <p className="section-note" style={{ margin: 0 }}>Marking credits left</p>
        <p style={{ margin: '4px 0', fontSize: '2.5rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{balance}</p>
        <p className="section-note" style={{ margin: 0 }}>
          One credit marks one script. {balance <= 0
            ? 'Marking is paused for all your teachers until credits are added.'
            : low
            ? 'Running low. Contact GradeFlow to buy more before your next exam.'
            : 'To buy more credits, contact GradeFlow.'}
        </p>
      </div>

      <div className="surface" style={{ marginTop: 'var(--s-4)' }}>
        <p className="section-heading" style={{ marginBottom: 4 }}>Teachers</p>
        <p className="section-note" style={{ margin: '0 0 12px 0' }}>
          A teacher must sign up first, choosing &quot;teacher&quot;. Then add them here with the same email.
        </p>

        {info.teachers.length === 0 && <p className="subtitle">No teachers yet.</p>}
        {info.teachers.map((t) => (
          <div
            key={t.id}
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--rule)', flexWrap: 'wrap' }}
          >
            <div style={{ minWidth: 0 }}>
              <strong>{t.name || 'Unnamed'}</strong>
              <div className="section-note" style={{ margin: 0, overflowWrap: 'anywhere' }}>{t.email}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="num">{t.scripts} scripts</span>
              <button type="button" className="btn-quiet btn-sm" onClick={() => removeTeacher(t)}>Remove</button>
            </div>
          </div>
        ))}

        <form onSubmit={addTeacher} style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 240px' }}>
            <label htmlFor="teacher-email">Add a teacher by email</label>
            <input id="teacher-email" type="email" required value={email} placeholder="teacher@example.com" onChange={(e) => setEmail(e.target.value)} />
          </div>
          <button type="submit" className="btn-primary" style={{ width: 'auto', marginTop: 0 }} disabled={busy || !email.trim()}>
            {busy ? 'Adding...' : 'Add teacher'}
          </button>
        </form>
      </div>

      {info.byExam.length > 0 && (
        <div className="surface" style={{ marginTop: 'var(--s-4)' }}>
          <p className="section-heading">Scripts marked by exam</p>
          {info.byExam.map((e) => (
            <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--rule)' }}>
              <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                <strong>{e.title}</strong>
                <span className="section-note" style={{ margin: 0 }}>{[e.subject, e.teacher].filter(Boolean).map((x) => ` · ${x}`)}</span>
              </span>
              <span className="num" style={{ whiteSpace: 'nowrap' }}>{e.scripts}</span>
            </div>
          ))}
        </div>
      )}

      {info.recent.length > 0 && (
        <div className="surface" style={{ marginTop: 'var(--s-4)' }}>
          <p className="section-heading">Recent credit activity</p>
          {info.recent.map((r) => (
            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--rule)', fontSize: '0.875rem' }}>
              <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                {REASON[r.reason] || r.reason}
                {r.title && ` · ${r.title}`}
                {r.note && ` · ${r.note}`}
                <span className="section-note" style={{ margin: 0 }}> · {new Date(r.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
              </span>
              <strong className="num" style={{ color: r.delta > 0 ? 'var(--green)' : 'inherit' }}>{r.delta > 0 ? `+${r.delta}` : r.delta}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
