-- ============================================================
-- GradeFlow Marking Mode, Phase 4 additions
-- Run in Supabase -> SQL Editor AFTER exam_schema.sql. Safe to re-run.
-- ============================================================

alter table exam_papers add column if not exists grading_started_at timestamptz;
alter table exam_papers add column if not exists ai_model text;
alter table exam_papers add column if not exists page_issues text;
alter table exam_papers add column if not exists match_note text;

-- For objective questions: what the student actually wrote (e.g. "B")
alter table exam_scores add column if not exists student_answer text;
