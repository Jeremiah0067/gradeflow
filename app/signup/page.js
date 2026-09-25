'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '../../lib/supabaseClient';

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('student');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSignup(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    // 1. Create the auth user via Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
    });

    if (authError) {
      setError(authError.message);
      setLoading(false);
      return;
    }

    const userId = authData.user?.id;
    if (!userId) {
      setError('Signup succeeded but no user id was returned. Check your Supabase email confirmation settings.');
      setLoading(false);
      return;
    }

    // 2. Insert the matching profile row with role + name
    const { error: profileError } = await supabase.from('users').insert({
      id: userId,
      name,
      email,
      role,
    });

    if (profileError) {
      setError(profileError.message);
      setLoading(false);
      return;
    }

    setLoading(false);
    router.push('/dashboard');
  }

  async function handleGoogleSignup() {
    setError('');
    const { error: googleError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (googleError) setError(googleError.message);
  }

  return (
    <div className="page">
      <h1>Create your account</h1>
      <p className="subtitle">Sign up as a teacher or a student.</p>

      <button type="button" onClick={handleGoogleSignup} style={{ background: 'white', color: '#1f2937', border: '1px solid #d1d5db' }}>
        Continue with Google
      </button>

      <p className="subtitle" style={{ textAlign: 'center', margin: '16px 0' }}>or</p>

      <form onSubmit={handleSignup}>
        <label htmlFor="name">Full name</label>
        <input id="name" value={name} onChange={(e) => setName(e.target.value)} required />

        <label htmlFor="email">Email</label>
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={6}
          required
        />

        <label htmlFor="role">I am a...</label>
        <select id="role" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="student">Student</option>
          <option value="teacher">Teacher</option>
        </select>

        {error && <p className="error-text">{error}</p>}

        <button type="submit" disabled={loading}>
          {loading ? 'Creating account...' : 'Sign up'}
        </button>
      </form>

      <p className="link-row">
        Already have an account? <Link href="/login">Log in</Link>
      </p>
    </div>
  );
}
