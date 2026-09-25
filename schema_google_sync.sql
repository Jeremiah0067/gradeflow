-- ============================================
-- GradeFlow: Google Classroom sync additions
-- Run this after the original schema.sql
-- ============================================

-- Stores each teacher's Google OAuth tokens for Classroom API access
create table google_accounts (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references users(id) on delete cascade,
  google_user_id text not null,
  access_token text not null,
  refresh_token text not null,
  token_expiry timestamptz not null,
  created_at timestamptz default now(),
  unique (teacher_id)
);

-- Link a GradeFlow class to the Google Classroom course it was imported from
alter table classes
  add column google_course_id text unique;

-- Link a GradeFlow assignment to its Google Classroom courseWork item
alter table assignments
  add column google_coursework_id text unique;

-- Store each student's Google user id per class, so we know whose grade to push
alter table enrollments
  add column google_user_id text;
