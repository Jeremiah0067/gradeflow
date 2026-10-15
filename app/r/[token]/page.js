import { createClient } from '@supabase/supabase-js';
import { headers } from 'next/headers';
import PrintButton from './PrintButton';

// A parent's private report link. No sign-in: the long random link is the key.
export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Student report',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

const TOKEN_OK = /^[A-Za-z0-9_-]{16,64}$/;
const BOTS = /whatsapp|facebookexternalhit|facebot|telegrambot|twitterbot|slackbot|discordbot|linkedinbot|googlebot|bingbot|crawler|spider|preview|bot\b/i;

const pct = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : `${Math.round(Number(v))}%`);

const CSS = `
.pr-wrap{max-width:760px;margin:0 auto;padding:16px}
.pr-card{background:#fff;border:1px solid #d9dee8;border-radius:14px;padding:28px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.pr-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding-bottom:14px;border-bottom:3px solid var(--accent);margin-bottom:18px}
.pr-brand{display:flex;align-items:center;gap:12px;min-width:0}
.pr-logo{max-height:52px;max-width:110px;object-fit:contain}
.pr-school{margin:0;font-size:1.3rem;font-weight:800;color:var(--accent);overflow-wrap:anywhere}
.pr-sub{margin:2px 0 0;font-size:.85rem;color:#555}
.pr-date{margin:0;font-size:.8rem;color:#555;white-space:nowrap}
.pr-meta,.pr-sum{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:18px}
.pr-meta span,.pr-sum span,.pr-label{display:block;font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;color:#666;margin-bottom:2px}
.pr-meta strong{font-size:.95rem;overflow-wrap:anywhere}
.pr-sum{background:#f5f7fb;border-radius:10px;padding:12px 14px}
.pr-sum strong{font-size:1.3rem;color:var(--accent);font-variant-numeric:tabular-nums}
.pr-scroll{overflow-x:auto}
.pr-table{width:100%;border-collapse:collapse;font-size:.88rem}
.pr-table th{text-align:left;font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;color:var(--accent);border-bottom:2px solid var(--accent);padding:8px}
.pr-table th:nth-child(n+2){text-align:right}
.pr-table td{padding:9px 8px;border-bottom:1px solid #e2e6ee;vertical-align:top}
.pr-table td.n{text-align:right;white-space:nowrap;font-weight:600;font-variant-numeric:tabular-nums}
.pr-title{display:block;font-size:.75rem;color:#666;font-weight:400}
.pr-block{margin-top:18px}
.pr-block p{margin:4px 0 0;font-size:.92rem;line-height:1.5}
.pr-rec{border-left:4px solid var(--accent);padding:6px 12px;margin-top:8px;background:#fafbfd;border-radius:0 8px 8px 0}
.pr-rec b{font-size:.85rem}
.pr-foot{margin-top:22px;font-size:.78rem;color:#666}
.pr-actions{display:flex;justify-content:flex-end;margin-bottom:12px}
.pr-print{font:inherit;font-weight:600;padding:9px 16px;border-radius:10px;border:1px solid #2340b4;background:#2340b4;color:#fff;cursor:pointer}
.pr-off{max-width:480px;margin:80px auto;padding:24px;text-align:center}
@media print{.pr-actions{display:none}.pr-wrap{padding:0}.pr-card{border:none;padding:0}}
`;

function Inactive() {
  return (
    <main className="pr-off">
      <h1 style={{ fontSize: '1.3rem' }}>This report link is not active</h1>
      <p style={{ color: '#555' }}>It may have expired or been switched off. Please contact your child&apos;s school for a new link.</p>
    </main>
  );
}

export default async function ParentReport({ params }) {
  const token = params?.token || '';
  if (!TOKEN_OK.test(token)) return <Inactive />;

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: share } = await db
    .from('report_shares')
    .select('id, snapshot, expires_at, batch_id')
    .eq('token', token)
    .maybeSingle();
  if (!share || new Date(share.expires_at) < new Date()) return <Inactive />;

  const { data: batch } = await db.from('report_batches').select('branding, revoked_at, created_at').eq('id', share.batch_id).maybeSingle();
  if (!batch || batch.revoked_at) return <Inactive />;

  // Count the visit, but not link-preview robots (WhatsApp fetches a link when it is pasted into a chat).
  const ua = headers().get('user-agent') || '';
  if (!BOTS.test(ua)) await db.rpc('record_share_view', { p_id: share.id });

  const s = share.snapshot || {};
  const b = batch.branding || {};
  const accent = /^#[0-9a-fA-F]{6}$/.test(b.accent || '') ? b.accent : '#2340b4';
  const logo = typeof b.logo === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(b.logo) ? b.logo : '';
  const issued = new Date(batch.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const until = new Date(share.expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const rows = Array.isArray(s.rows) ? s.rows : [];
  const showAvg = rows.some((r) => r.classAvgPct !== null && r.classAvgPct !== undefined);
  const recs = rows.filter((r) => r.recommendation);

  return (
    <main className="pr-wrap" style={{ '--accent': accent }}>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="pr-actions">
        <PrintButton />
      </div>
      <article className="pr-card">
        <header className="pr-head">
          <div className="pr-brand">
            {logo && <img src={logo} alt="" className="pr-logo" />}
            <div>
              <p className="pr-school">{b.school || 'School report'}</p>
              <p className="pr-sub">Student report card{b.term ? ` · ${b.term}` : ''}</p>
            </div>
          </div>
          <p className="pr-date">{issued}</p>
        </header>

        <div className="pr-meta">
          <div><span>Student</span><strong>{s.name || '—'}</strong></div>
          <div><span>Reg. number</span><strong>{s.regNo || '—'}</strong></div>
          <div><span>Class</span><strong>{s.classLabel || '—'}</strong></div>
          <div><span>Teacher</span><strong>{s.teacherName || '—'}</strong></div>
        </div>

        <div className="pr-sum">
          <div><span>Overall</span><strong>{pct(s.overallPct)}</strong></div>
          <div><span>Total marks</span><strong>{s.totalScore} / {s.totalMax}</strong></div>
          {s.positionText ? <div><span>Position in class</span><strong>{s.positionText}</strong></div> : null}
        </div>

        <div className="pr-scroll">
          <table className="pr-table">
            <thead>
              <tr>
                <th>Subject</th>
                <th>Score</th>
                <th>Percent</th>
                {showAvg && <th>Class average</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    {r.subject}
                    {r.title && r.title !== r.subject ? <span className="pr-title">{r.title}</span> : null}
                  </td>
                  <td className="n">{r.score} / {r.total}</td>
                  <td className="n">{pct(r.pct)}</td>
                  {showAvg && <td className="n">{pct(r.classAvgPct)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {s.comment ? (
          <section className="pr-block">
            <span className="pr-label">Teacher&apos;s comment</span>
            <p>{s.comment}</p>
          </section>
        ) : null}

        {recs.length > 0 && (
          <section className="pr-block">
            <span className="pr-label">What to practise next</span>
            {recs.map((r, i) => (
              <div key={i} className="pr-rec">
                <b>{r.subject}</b>
                <p>{r.recommendation}</p>
              </div>
            ))}
          </section>
        )}

        <p className="pr-foot">
          This report is private to your family. Please do not share the link. It stays active until {until}.
        </p>
      </article>
    </main>
  );
}
