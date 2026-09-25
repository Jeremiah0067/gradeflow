import { createClient } from '@supabase/supabase-js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CLASSROOM_API_BASE = 'https://classroom.googleapis.com/v1';

async function refreshAccessToken(refreshToken) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Failed to refresh Google token: ${data.error_description || data.error}`);
  }
  return data;
}

export async function getValidAccessToken(supabase, teacherId) {
  const { data: account, error } = await supabase
    .from('google_accounts')
    .select('*')
    .eq('teacher_id', teacherId)
    .single();

  if (error || !account) {
    throw new Error('No Google account connected for this teacher.');
  }

  const expiry = new Date(account.token_expiry).getTime();
  const now = Date.now();

  if (now < expiry - 60_000) {
    return account.access_token;
  }

  const refreshed = await refreshAccessToken(account.refresh_token);
  const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();

  await supabase
    .from('google_accounts')
    .update({ access_token: refreshed.access_token, token_expiry: newExpiry })
    .eq('teacher_id', teacherId);

  return refreshed.access_token;
}

export async function classroomFetch(accessToken, path, options = {}) {
  const res = await fetch(`${CLASSROOM_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Classroom API error (${res.status}): ${data?.error?.message || res.statusText}`);
  }
  return data;
}
