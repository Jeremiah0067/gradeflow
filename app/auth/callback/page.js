'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../../../lib/supabaseClient';

export default function AuthCallbackPage() {
  const router = useRouter();

  useEffect(() => {
    // supabase-js automatically detects the ?code=... in the URL and
    // completes the PKCE exchange when the session is requested here.
    supabase.auth.getSession().then(({ data }) => {
      if (data?.session) {
        // We don't yet know if this user has picked a role (first-time
        // Google sign-in won't have one). /select-role checks for us and
        // redirects straight to /dashboard if a profile already exists.
        router.replace('/select-role');
      } else {
        router.replace('/login');
      }
    });
  }, [router]);

  return (
    <div className="page">
      <p className="subtitle">Signing you in...</p>
    </div>
  );
}
