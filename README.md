# GradeFlow

An assignment-focused classroom app: teachers create classes and assignments,
students join by code and submit work, and typed answers are graded
automatically against a rubric using Gemini.

## What's working in this starter

- Signup / login (teacher or student role) via Supabase Auth
- Teachers: create a class, get a join code, create assignments with a rubric
- Students: join a class by code, submit a **typed** answer, see it auto-graded
- Teachers: see all submissions per assignment with AI-given scores + reasoning
- Google Classroom sync (backend routes only, no UI yet):
  - Teacher connects their Google account via OAuth
  - Import an existing Google Classroom course + roster as a GradeFlow class
  - Push a graded submission's score back into that class's Google gradebook
    as a draft grade

## What's NOT built yet (next steps)

- Rubric builder UI (right now rubric_criteria rows need to be inserted
  manually via Supabase's table editor, or you can add a form for it)
- Handwritten photo upload + transcription step
- Quiz type grading
- Teacher score overrides (the `teacher_override_points` column exists in the
  DB but there's no UI to set it yet)
- Gradebook view
- Frontend UI for the Google Classroom sync routes (connect button, course
  picker, push-grade button)
- Creating the actual courseWork item in Google Classroom when an assignment
  is made in GradeFlow (currently one-directional: import only)

## Setup

### 1. Supabase

1. Create a project at supabase.com
2. In the SQL Editor, run `schema.sql`, then run `schema_google_sync.sql`
3. In Authentication → Providers, make sure Email is enabled
4. In Project Settings → API, copy your Project URL, anon public key, and
   service_role key (the last one only needed for Google sync — see below)

### 2. Environment variables

Copy `.env.local.example` to `.env.local` and fill in:

NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
GEMINI_API_KEY=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3000/api/google/callback
SUPABASE_SERVICE_ROLE_KEY=...


Get the Gemini key from https://aistudio.google.com/apikey

Get the Google OAuth credentials from Google Cloud Console → APIs & Services
→ enable the Google Classroom API → Google Auth Platform → set up Branding,
Audience (add yourself as a test user), Data access (add the three Classroom
scopes), then Clients → Create client → Web application → add
`http://localhost:3000/api/google/callback` as an authorized redirect URI.

### 3. Install and run locally

```bash
npm install
npm run dev
```

Visit http://localhost:3000 — it redirects to /login.

### 4. Try the flow

1. Sign up as a teacher → create a class → note the join code
2. Sign up as a student (different email) → join the class with that code
3. As the teacher, create an assignment with type "typed" and add a couple
   of rows to `rubric_criteria` in Supabase's table editor for that
   assignment's id
4. As the student, open the assignment and submit a typed answer
5. It should auto-grade and show scores; the teacher's submissions view
   will show the same

### 5. Deploy

This is a standard Next.js app, so it deploys cleanly on either Vercel or
Netlify. If using Netlify, add a `netlify.toml` with:

```toml
[build]
  command = "npm run build"
  publish = ".next"

[[plugins]]
  package = "@netlify/plugin-nextjs"
```

Set the same environment variables in your hosting provider's dashboard
(Site settings → Environment variables on Netlify, or Project Settings →
Environment Variables on Vercel) — including the Google/Supabase service
role ones if you've added the Classroom sync routes. Also add your
production callback URL (e.g. `https://yoursite.com/api/google/callback`)
as an additional authorized redirect URI in Google Cloud Console.
