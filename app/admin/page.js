'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../../lib/supabaseClient';
import { formatUsd } from '../../lib/estimateCost';
import { GRADING_MODES } from '../../lib/gradingModels';

async function adminFetch(method, body) {
  const { data } = await supabase.auth.getSession();
  const res = await fetch('/api/admin/jobs', {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data?.session?.access_token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status}).`);
  return json;
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
          <h1>Admin: grading cost</h1>
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
