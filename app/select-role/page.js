'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../../lib/supabaseClient';

export default function SelectRolePage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [role, setRole] = useState('student');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    checkExistingProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function checkExistingProfile() {
    const { data: sessionData } = await supabase.auth.getSession();
    const session = sessionData?.session;

    if (!session) {
      router.replace('/login');
      return;
    }

    const { data: profile } = await supabase.from('users').select('id').eq('id', session.user.id).maybeSingle();

    if (profile) {
      // Already set up - nothing to do here
      router.replace('/dashboard');
      return;
    }

    setChecking(false);
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');

    const { data: sessionData } = await supabase.auth.getSession();
    const session = sessionData.session;
    const user = session.user;

    const name = user.user_metadata?.full_name || user.user_metadata?.name || user.email;

    const { error: insertError } = await supabase.from('users').insert({
      id: user.id,
      name,
      email: user.email,
      role,
    });

    setSaving(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    router.push('/dashboard');
  }

  if (checking) {
    return (
      <div className="page">
        <p className="subtitle">Loading...</p>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>One more step</h1>
      <p className="subtitle">Tell us how you&apos;ll be using GradeFlow.</p>

      <form onSubmit={handleSave}>
        <label htmlFor="role">I am a...</label>
        <select id="role" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="student">Student</option>
          <option value="teacher">Teacher</option>
        </select>

        {error && <p className="error-text">{error}</p>}

        <button type="submit" disabled={saving}>
          {saving ? 'Saving...' : 'Continue'}
        </button>
      </form>
    </div>
  );
}
