'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { supabase } from '../lib/supabaseClient';
import { loadNavCounts } from '../lib/navCounts';
import { Icon } from './icons';

// Pages that are shown without the navigation (signing in, choosing a role)
const BARE = ['/', '/login', '/signup', '/select-role'];
const isBare = (path) => BARE.includes(path) || path.startsWith('/auth');

function itemsFor(role) {
  if (role === 'student') {
    return [{ key: 'home', label: 'Home', href: '/dashboard', icon: 'home' }];
  }
  return [
    { key: 'home', label: 'Home', href: '/dashboard', icon: 'home' },
    { key: 'classes', label: 'Classes', href: '/dashboard#your-classes', icon: 'book' },
    { key: 'inbox', label: 'Inbox', href: '/inbox', icon: 'inbox' },
    { key: 'marking', label: 'Marking', href: '/marking', icon: 'pen' },
  ];
}

function activeKey(path) {
  if (path.startsWith('/marking')) return 'marking';
  if (path.startsWith('/inbox')) return 'inbox';
  if (path.startsWith('/class')) return 'classes';
  return 'home';
}

export default function AppShell({ children }) {
  const pathname = usePathname() || '/';
  const router = useRouter();
  const [profile, setProfile] = useState(null);
  const [counts, setCounts] = useState({ inbox: 0, marking: 0 });
  const lastCounted = useRef(0);

  const bare = isBare(pathname);

  // Who is signed in (once)
  useEffect(() => {
    if (bare) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getSession();
      const session = data?.session;
      if (!session) return;
      const { data: row } = await supabase.from('users').select('name, role').eq('id', session.user.id).maybeSingle();
      if (!cancelled && row) setProfile({ ...row, id: session.user.id });
    })();
    return () => {
      cancelled = true;
    };
  }, [bare]);

  // Badge numbers, refreshed when you move around (but not more than every 15 seconds)
  useEffect(() => {
    if (bare || profile?.role !== 'teacher') return;
    if (Date.now() - lastCounted.current < 15000) return;
    lastCounted.current = Date.now();
    let cancelled = false;
    loadNavCounts(supabase, profile.id)
      .then((c) => {
        if (!cancelled) setCounts(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bare, profile, pathname]);

  async function handleLogout() {
    await supabase.auth.signOut();
    setProfile(null);
    router.push('/login');
  }

  if (bare) return children;

  const items = itemsFor(profile?.role);
  const current = activeKey(pathname);
  const badge = (key) => (key === 'inbox' ? counts.inbox : key === 'marking' ? counts.marking : 0);
  const initial = profile?.name?.[0]?.toUpperCase() || '';

  const renderItem = (it) => (
    <li key={it.key}>
      <Link
        href={it.href}
        className="navlink"
        aria-current={current === it.key ? 'page' : undefined}
      >
        <Icon name={it.icon} />
        <span>{it.label}</span>
        {badge(it.key) > 0 && (
          <span className="navcount" aria-label={`${badge(it.key)} waiting`}>
            {badge(it.key)}
          </span>
        )}
      </Link>
    </li>
  );

  return (
    <div className="shell">
      <aside className="shell-nav">
        <Link href="/dashboard" className="brand">
          <span className="brand-mark">G</span>
          GradeFlow
        </Link>

        <nav aria-label="Main">
          <ul className="navlist">{items.map(renderItem)}</ul>
        </nav>

        <div className="shell-user">
          <div className="avatar" aria-hidden="true">{initial}</div>
          <div className="shell-user-info">
            <p className="shell-user-name">{profile?.name || ' '}</p>
            <p className="shell-user-role">{profile ? (profile.role === 'teacher' ? 'Teacher' : 'Student') : ' '}</p>
          </div>
          <button type="button" className="btn-quiet btn-sm" onClick={handleLogout} aria-label="Log out" title="Log out" style={{ padding: 0, width: 36, minHeight: 36 }}>
            <Icon name="logout" size={18} />
          </button>
        </div>
      </aside>

      <div className="shell-main">
        <header className="mobilebar">
          <Link href="/dashboard" className="brand" style={{ padding: 0 }}>
            <span className="brand-mark">G</span>
            GradeFlow
          </Link>
          <button type="button" className="btn-quiet btn-sm" onClick={handleLogout} aria-label="Log out">
            <Icon name="logout" size={18} />
            Log out
          </button>
        </header>

        <main id="main">{children}</main>
      </div>

      <nav className="bottomnav" aria-label="Main">
        {items.map((it) => (
          <Link
            key={it.key}
            href={it.href}
            className="navlink"
            aria-current={current === it.key ? 'page' : undefined}
          >
            <Icon name={it.icon} size={22} />
            <span>{it.label}</span>
            {badge(it.key) > 0 && <span className="navcount">{badge(it.key)}</span>}
          </Link>
        ))}
      </nav>
    </div>
  );
}
