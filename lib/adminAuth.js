// Server-side helpers for the admin role. Only import this from API routes.
// Cost and pricing information belongs to administrators; teachers never receive it.

import { createClient } from '@supabase/supabase-js';

export const BUDGET_TEACHER_MESSAGE =
  'Grading is paused because this job has reached the spending limit set by your administrator. Please contact them to continue.';

// Reads the caller's role with the service key, so it cannot be spoofed from the browser.
export async function isAdminUser(userId) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey || !userId) return false;
  const service = createClient(url, serviceKey);
  const { data } = await service.from('users').select('role').eq('id', userId).maybeSingle();
  return data?.role === 'admin';
}

// Resolves the signed-in user from the request's bearer token.
export async function getCallerFromRequest(req) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: req.headers.get('authorization') || '' } },
  });
  const {
    data: { user },
    error,
  } = await userClient.auth.getUser();
  if (error || !user) return null;
  return user;
}
