'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '../../../lib/supabaseClient';
import { csvCell } from '../../../lib/markingReports';

async function api(method, { query = '', body } = {}) {
  const { data } = await supabase.auth.getSession();
  const res = await fetch(`/api/marking/share${query}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data?.session?.access_token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status}).`);
  return json;
}

const dateText = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function SharesInner() {
  const router = useRouter();
  const batchId = useSearchParams().get('batch');
  const [ready, setReady] = useState(false);
  const [batches, setBatches] = useState([]);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [origin, setOrigin] = useState('');

  useEffect(() => {
    setOrigin(window.location.origin);
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId]);

  async function init() {
    const { data: sessionData } = await supabase.auth.getSession();
    const session = sessionData?.session;
    if (!session) {
      router.push('/login');
      return;
    }
    const { data: profile } = await supabase.from('users').select('role').eq('id', session.user.id).maybeSingle();
    if (profile?.role !== 'teacher') {
      router.push('/dashboard');
      return;
    }
    await load();
    setReady(true);
  }

  async function load() {
    setError('');
    try {
      if (batchId) setDetail(await api('GET', { query: `?batch=${encodeURIComponent(batchId)}` }));
      else setBatches((await api('GET')).batches);
    } catch (err) {
      setError(err.message);
    }
  }

  const linkFor = (token) => `${origin}/r/${token}`;

  async function copy(token) {
    try {
      await navigator.clipboard.writeText(linkFor(token));
      setNotice('Link copied.');
    } catch {
      setError('Could not copy. Press and hold the link to copy it.');
    }
  }

  function whatsapp(share) {
    const text = `Dear Parent, the report card for ${share.student_name} is ready. Please open it here: ${linkFor(share.token)}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  }

  function downloadCsv() {
    const lines = [['Student', 'Link', 'Opened']].concat(
      detail.shares.map((s) => [s.student_name, linkFor(s.token), s.view_count > 0 ? 'Yes' : 'No'])
    );
    const csv = '\uFEFF' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'parent-links.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function revoke() {
    if (!confirm('Switch off ALL links in this set? Parents who open them will see that the link is not active.')) return;
    try {
      await api('POST', { body: { action: 'revoke', batchId } });
      setNotice('All links in this set are switched off.');
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!ready) return <div className="page-wide">{error ? <p className="alert alert-error" role="alert">{error}</p> : <p>Loading...</p>}</div>;

  if (!batchId) {
    return (
      <div className="page-wide">
        <p className="breadcrumb"><a onClick={() => router.push('/marking')}>Marking</a> › Parent links</p>
        <div className="page-head"><div><h1>Parent links</h1><p className="subtitle">Private report links you have created. Open a set to share the links.</p></div></div>
        {error && <p className="alert alert-error" role="alert">{error}</p>}
        {batches.length === 0 && <p className="subtitle">No links yet. Build reports on the Report cards page, then choose Create parent links.</p>}
        {batches.map((b) => (
          <div key={b.id} className="surface" style={{ marginTop: 'var(--s-3)', cursor: 'pointer' }} onClick={() => router.push(`/marking/shares?batch=${b.id}`)}>
            <p className="section-heading" style={{ marginBottom: 2 }}>{b.label}</p>
            <p className="section-note" style={{ margin: 0 }}>
              {dateText(b.created_at)} · <span className="num">{b.opened}</span> of <span className="num">{b.total}</span> opened
              {b.revoked_at ? ' · Switched off' : ''}
            </p>
          </div>
        ))}
      </div>
    );
  }

  const shares = detail?.shares || [];
  const opened = shares.filter((s) => s.view_count > 0).length;
  const off = !!detail?.batch?.revoked_at;

  return (
    <div className="page-wide">
      <p className="breadcrumb">
        <a onClick={() => router.push('/marking')}>Marking</a> › <a onClick={() => router.push('/marking/shares')}>Parent links</a> › {detail?.batch?.label}
      </p>
      <div className="page-head">
        <div>
          <h1>{detail?.batch?.label || 'Parent links'}</h1>
          <div className="meta">
            <span className="num">{opened} of {shares.length} opened</span>
            {off && <span>Switched off</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn-secondary" style={{ width: 'auto', marginTop: 0 }} onClick={downloadCsv}>Download links (CSV)</button>
          {!off && <button type="button" className="btn-quiet" style={{ width: 'auto', marginTop: 0 }} onClick={revoke}>Switch off all links</button>}
        </div>
      </div>

      {error && <p className="alert alert-error" role="alert">{error}</p>}
      {notice && <p className="alert alert-ok" role="status">{notice}</p>}

      <p className="section-note">
        Each link opens one student&apos;s report, with no sign-in. Send it only to that student&apos;s parent or guardian.
        &quot;Opened&quot; can miss a parent who read it in a chat preview, and counts a visit each time the page is opened.
      </p>

      {shares.map((s) => (
        <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--rule)', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <strong>{s.student_name}</strong>
            <div className="section-note" style={{ margin: 0 }}>
              {s.view_count > 0 ? `Opened ${s.view_count} ${s.view_count === 1 ? 'time' : 'times'}` : 'Not opened yet'} · expires {dateText(s.expires_at)}
            </div>
          </div>
          {!off && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn-secondary btn-sm" style={{ width: 'auto', marginTop: 0 }} onClick={() => copy(s.token)}>Copy link</button>
              <button type="button" className="btn-primary btn-sm" style={{ width: 'auto', marginTop: 0 }} onClick={() => whatsapp(s)}>WhatsApp</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function SharesPage() {
  return (
    <Suspense fallback={<div className="page-wide"><p>Loading...</p></div>}>
      <SharesInner />
    </Suspense>
  );
}
