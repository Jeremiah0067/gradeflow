import { createClient } from '@supabase/supabase-js';

function getServiceSupabase() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const teacherId = searchParams.get('state');

  if (!code || !teacherId) {
    return Response.json({ error: 'Missing code or state from Google redirect.' }, { status: 400 });
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  const tokenData = await tokenRes.json();

  if (!tokenRes.ok) {
    return Response.json({ error: tokenData.error_description || 'Token exchange failed.' }, { status: 500 });
  }

  const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const profile = await profileRes.json();

  const supabase = getServiceSupabase();
  const tokenExpiry = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();

  const { error } = await supabase.from('google_accounts').upsert(
    {
      teacher_id: teacherId,
      google_user_id: profile.id,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      token_expiry: tokenExpiry,
    },
    { onConflict: 'teacher_id' }
  );

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.redirect(new URL('/dashboard?google_connected=1', req.url));
}
