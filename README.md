# GradeFlow

An assignment-focused classroom app: teachers create classes and assignments,
students join by code and submit work, and typed answers are graded
automatically against a rubric using Gemini.

## What's working in this starter

- Signup / login (teacher or student role) via Supabase Auth
- Teachers: create a class, get a join code, create assignments with a rubric
- Students: join a class by code, submit a **typed** answer, see it auto-graded
- Teachers: see all submissions per assignment with AI-given scores + reasoning

## What's NOT built yet (next steps)

- Rubric builder UI (right now rubric_criteria rows need to be inserted
  manually via Supabase's table editor, or you can add a form for it)
- Handwritten photo upload + transcription step
- Quiz type grading
- Teacher score overrides (the `teacher_override_points` column exists in the
  DB but there's no UI to set it yet)
- Gradebook view

## Setup

### 1. Supabase

1. Create a project at supabase.com
2. In the SQL Editor, run `schema.sql`
3. In Authentication → Providers, make sure Email is enabled
4. In Project Settings → API, copy your Project URL and anon public key

### 2. Environment variables

Copy `.env.local.example` to `.env.local` and fill in:
