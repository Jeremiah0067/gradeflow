'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '../../lib/supabaseClient';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleLogin(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    const { error: loginError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setLoading(false);

    if (loginError) {
      setError(loginError.message);
      return;
    }

    router.push('/dashboard');
  }

  async function handleGoogleLogin() {
    setError('');
    const { error: googleError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (googleError) setError(googleError.message);
  }

  return (
    <div className="page">
      <h1>Log in</h1>
      <p className="subtitle">Welcome back to GradeFlow.</p>

      <button type="button" onClick={handleGoogleLogin} style={{ background: 'white', color: '#1f2937', border: '1px solid #d1d5db' }}>
        Continue with Google
      </button>

      <p className="subtitle" style={{ textAlign: 'center', margin: '16px 0' }}>or</p>

      <form onSubmit={handleLogin}>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        {error && <p className="error-text">{error}</p>}

        <button type="submit" disabled={loading}>
          {loading ? 'Logging in...' : 'Log in'}
        </button>
      </form>

      <p className="link-row">
        No account yet? <Link href="/signup">Sign up</Link>
      </p>
    </div>
  );
}
