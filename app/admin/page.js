'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../../lib/supabaseClient';
import { formatUsd } from '../../lib/estimateCost';
import { GRADING_MODES } from '../../lib/gradingModels';

async function adminFetch(method, body, path = '/api/admin/jobs') {
  const { data } = await supabase.auth.getSession();
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data?.session?.access_token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status}).`);
  return json;
}

function SchoolsSection() {
  const [schools, setSchools] = useState([]);
  const [name, setName] = useState('');
  const [forms, setForms] = useState({}); // per school: { credits, note, email }
  const [price, setPrice] = useState(''); // your price per script, in naira
  const [rate, setRate] = useState(''); // naira per 1 US dollar
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      const { schools: rows } = await adminFetch('GET', undefined, '/api/admin/schools');
      setSchools(rows);
    } catch (err) {
      setError(err.message);
    }
  }

  async function act(body, message) {
    setError('');
    setNotice('');
    try {
      await adminFetch('POST', body, '/api/admin/schools');
      setNotice(message);
      await load();
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  }

  const setForm = (id, patch) => setForms((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const priceN = Number(price);
  const rateN = Number(rate);
  const canMargin = priceN > 0 && rateN > 0;

  return (
    <div style={{ marginBottom: 'var(--s-6)' }}>
      <h2 style={{ marginBottom: 4 }}>Schools and credits</h2>
      <p className="section-note" style={{ marginTop: 0 }}>
        One credit marks one script. Add credits after a school pays you. Cost figures are estimates from your AI usage log.
      </p>

      {error && <p className="alert alert-error" role="alert">{error}</p>}
      {notice && <p className="alert alert-ok" role="status">{notice}</p>}

      <div className="surface" style={{ marginTop: 'var(--s-3)' }}>
        <p className="section-heading" style={{ marginBottom: 8 }}>Margin calculator</p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <label htmlFor="price">Your price per script (naira)</label>
            <input id="price" type="number" min="0" step="1" value={price} onChange={(e) => setPrice(e.target.value)} style={{ maxWidth: 200 }} />
          </div>
          <div>
            <label htmlFor="rate">Naira per 1 US dollar</label>
            <input id="rate" type="number" min="0" step="1" value={rate} onChange={(e) => setRate(e.target.value)} style={{ maxWidth: 200 }} />
          </div>
        </div>
        <p className="section-note" style={{ margin: '8px 0 0 0' }}>
          Type both and each school below shows your margin. Check the exchange rate often, because your AI cost is in dollars.
        </p>
      </div>

      <form
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 'var(--s-4)' }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (await act({ action: 'createSchool', name }, `School "${name}" created.`)) setName('');
        }}
      >
        <div style={{ flex: '1 1 240px' }}>
          <label htmlFor="new-school">New school</label>
          <input id="new-school" value={name} placeholder="School name" onChange={(e) => setName(e.target.value)} />
        </div>
        <button type="submit" className="btn-primary" style={{ width: 'auto', marginTop: 0 }} disabled={!name.trim()}>
          Create school
        </button>
      </form>

      {schools.length === 0 && <p className="subtitle">No schools yet.</p>}

      {schools.map((s) => {
        const f = forms[s.id] || {};
        const costNaira = s.cost_per_script_usd !== null && rateN > 0 ? s.cost_per_script_usd * rateN : null;
        const margin = canMargin && costNaira !== null ? ((priceN - costNaira) / priceN) * 100 : null;
        return (
          <div key={s.id} className="surface" style={{ marginTop: 'var(--s-4)' }}>
            <p className="section-heading" style={{ marginBottom: 2 }}>{s.name}</p>
            <p className="section-note" style={{ margin: '0 0 12px 0' }}>
              <span className="num">{s.credit_balance}</span> credits left · <span className="num">{s.teachers}</span> teachers ·{' '}
              <span className="num">{s.scripts}</span> scripts marked
              {s.admins.length > 0 ? ` · Admin: ${s.admins.join(', ')}` : ' · No school admin yet'}
            </p>
            <p className="section-note" style={{ margin: '0 0 12px 0' }}>
              AI cost <span className="num">{formatUsd(s.cost_usd)}</span>
              {s.cost_per_script_usd !== null && (
                <> · <span className="num">{formatUsd(s.cost_per_script_usd)}</span> per script</>
              )}
              {margin !== null && (
                <> · margin <strong className="num">{Math.round(margin)}%</strong></>
              )}
            </p>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div>
                <label htmlFor={`cr-${s.id}`}>Credits (minus to remove)</label>
                <input id={`cr-${s.id}`} type="number" step="1" value={f.credits || ''} onChange={(e) => setForm(s.id, { credits: e.target.value })} style={{ maxWidth: 160 }} />
              </div>
              <div style={{ flex: '1 1 180px' }}>
                <label htmlFor={`note-${s.id}`}>Note (optional)</label>
                <input id={`note-${s.id}`} value={f.note || ''} placeholder="e.g. Transfer 14 Oct" onChange={(e) => setForm(s.id, { note: e.target.value })} />
              </div>
              <button
                type="button"
                className="btn-primary"
                style={{ width: 'auto', marginTop: 0 }}
                disabled={!f.credits}
                onClick={async () => {
                  if (await act({ action: 'topUp', schoolId: s.id, credits: f.credits, note: f.note }, `Credits updated for ${s.name}.`)) {
                    setForm(s.id, { credits: '', note: '' });
                  }
                }}
              >
                Update credits
              </button>
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 12 }}>
              <div style={{ flex: '1 1 240px' }}>
                <label htmlFor={`adm-${s.id}`}>Make someone the school admin (by email)</label>
                <input id={`adm-${s.id}`} type="email" value={f.email || ''} placeholder="They must have signed up as a teacher" onChange={(e) => setForm(s.id, { email: e.target.value })} />
              </div>
              <button
                type="button"
                className="btn-secondary"
                style={{ width: 'auto', marginTop: 0 }}
                disabled={!f.email}
                onClick={async () => {
                  if (await act({ action: 'assignAdmin', schoolId: s.id, email: f.email }, `School admin set for ${s.name}.`)) {
                    setForm(s.id, { email: '' });
                  }
                }}
              >
                Set school admin
              </button>
            </div>
          </div>
        );
      })}

      <h2 style={{ margin: 'var(--s-6) 0 4px 0' }}>Marking jobs</h2>
    </div>
  );
}

export default function AdminPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [drafts, setDrafts] = useState({}); // spending limit text being typed, by job id
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
    if (profile?.role !== 'admin') {
      router.push('/dashboard');
      return;
    }
    setReady(true);
    await load();
  }

  async function load() {
    try {
      const { jobs: rows } = await adminFetch('GET');
      setJobs(rows);
    } catch (err) {
      setError(err.message);
    }
  }

  async function save(job, patch, message) {
    setError('');
    setNotice('');
    try {
      await adminFetch('PATCH', { examId: job.id, ...patch });
      setNotice(message);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[job.id];
        return next;
      });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  function handleBudgetBlur(job) {
    if (!(job.id in drafts)) return;
    const raw = String(drafts[job.id]).trim();
    const value = raw === '' ? null : Number(raw);
    if (value === job.budget_usd) {
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[job.id];
        return next;
      });
      return;
    }
    save(
      job,
      { budget_usd: value },
      value === null ? `Spending limit removed for "${job.title}".` : `Spending limit for "${job.title}" set to ${formatUsd(value)}.`
    );
  }

  if (!ready) {
    return (
      <div className="page-wide">
        <p>Loading...</p>
      </div>
    );
  }

  const totalSpent = jobs.reduce((sum, j) => sum + j.spent_usd, 0);

  return (
    <div className="page-wide">
      <div className="page-head">
        <div>
          <h1>Admin</h1>
          <div className="meta">
            <span className="num">{jobs.length} marking {jobs.length === 1 ? 'job' : 'jobs'}</span>
            <span className="num">{formatUsd(totalSpent)} spent in total</span>
          </div>
        </div>
      </div>

      {error && <p className="alert alert-error" role="alert">{error}</p>}
      {notice && <p className="alert alert-ok" role="status">{notice}</p>}

      <p className="section-note">
        Teachers do not see any cost, grading mode or spending limit. Set them here. Amounts are estimates, so check
        Google&apos;s billing page for the exact figure.
      </p>

      <SchoolsSection />

      {jobs.length === 0 && <p className="subtitle">No marking jobs yet.</p>}

      {jobs.map((job) => {
        const draft = job.id in drafts ? drafts[job.id] : job.budget_usd === null ? '' : String(job.budget_usd);
        return (
          <div key={job.id} className="surface" style={{ marginTop: 'var(--s-4)' }}>
            <p className="section-heading" style={{ marginBottom: 2 }}>{job.title}</p>
            <p className="section-note" style={{ margin: '0 0 12px 0' }}>
              {job.teacher} · <span className="num">{formatUsd(job.spent_usd)}</span> spent
              {job.budget_usd !== null && <> of <span className="num">{formatUsd(job.budget_usd)}</span></>} ·{' '}
              <span className="num">{job.calls}</span> AI {job.calls === 1 ? 'call' : 'calls'}
            </p>

            <label htmlFor={`mode-${job.id}`}>Quality and cost</label>
            <select
              id={`mode-${job.id}`}
              value={job.grading_mode}
              onChange={(e) => save(job, { grading_mode: e.target.value }, `Grading mode for "${job.title}" updated.`)}
            >
              {GRADING_MODES.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            <p className="section-note" style={{ margin: '6px 0 0 0' }}>
              {GRADING_MODES.find((m) => m.id === job.grading_mode)?.blurb}
            </p>

            <label htmlFor={`budget-${job.id}`}>Spending limit (US dollars, optional)</label>
            <input
              id={`budget-${job.id}`}
              type="number"
              min="0"
              step="0.01"
              placeholder="No limit"
              value={draft}
              onChange={(e) => setDrafts((prev) => ({ ...prev, [job.id]: e.target.value }))}
              onBlur={() => handleBudgetBlur(job)}
              style={{ maxWidth: 220 }}
            />
          </div>
        );
      })}
    </div>
  );
}
