-- ============================================================
-- GradeFlow: Marking Mode (teacher-snapped handwritten papers)
-- Run in Supabase -> SQL Editor, AFTER schema.sql and
-- schema_google_sync.sql. Safe to re-run.
-- ============================================================

-- One row per test / assignment / exam the teacher marks
create table if not exists exams (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references users(id) on delete cascade,
  title text not null,
  subject text,
  class_label text,
  paper_type text not null default 'exam' check (paper_type in ('test', 'assignment', 'exam')),
  extra_instructions text,
  total_marks numeric not null default 0,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz default now()
);
create index if not exists exams_teacher_idx on exams(teacher_id);

-- The questions and marking scheme for an exam
create table if not exists exam_questions (
  id uuid primary key default gen_random_uuid(),
  exam_id uuid not null references exams(id) on delete cascade,
  position int not null,
  label text not null,
  question_text text not null,
  max_marks numeric not null check (max_marks > 0),
  question_type text not null default 'written' check (question_type in ('written', 'objective')),
  marking_guide text,
  answer_key text,
  unique (exam_id, position)
);

-- The roster (from the teacher's CSV): who wrote this paper
create table if not exists exam_students (
  id uuid primary key default gen_random_uuid(),
  exam_id uuid not null references exams(id) on delete cascade,
  reg_no text not null,
  full_name text not null,
  unique (exam_id, reg_no)
);
create index if not exists exam_students_exam_idx on exam_students(exam_id);

-- One row per student's script
create table if not exists exam_papers (
  id uuid primary key default gen_random_uuid(),
  exam_id uuid not null references exams(id) on delete cascade,
  student_id uuid references exam_students(id) on delete set null,
  status text not null default 'uploaded'
    check (status in ('uploaded', 'queued', 'grading', 'needs_review', 'approved', 'flagged', 'failed')),
  detected_name text,
  detected_reg_no text,
  match_confidence numeric,
  ai_total numeric,
  final_total numeric,
  ai_confidence numeric,
  teacher_comment text,
  grading_attempts int not null default 0,
  last_error text,
  created_at timestamptz default now(),
  graded_at timestamptz,
  approved_at timestamptz
);
create index if not exists exam_papers_exam_idx on exam_papers(exam_id);
-- A student can only have one script per exam, so the final CSV never has duplicates
create unique index if not exists exam_papers_one_per_student
  on exam_papers(exam_id, student_id) where student_id is not null;

-- The photographed pages of a script
create table if not exists exam_paper_pages (
  id uuid primary key default gen_random_uuid(),
  paper_id uuid not null references exam_papers(id) on delete cascade,
  page_no int not null,
  storage_path text not null,
  mime_type text not null default 'image/jpeg',
  unique (paper_id, page_no)
);

-- Per-question scores: what the AI gave, and what the teacher finally decided
create table if not exists exam_scores (
  id uuid primary key default gen_random_uuid(),
  paper_id uuid not null references exam_papers(id) on delete cascade,
  question_id uuid not null references exam_questions(id) on delete cascade,
  ai_marks numeric,
  final_marks numeric,
  reasoning text,
  evidence text,
  confidence numeric,
  overridden boolean not null default false,
  unique (paper_id, question_id)
);

-- Every AI call is logged so we can see the real cost per paper
create table if not exists exam_ai_usage (
  id uuid primary key default gen_random_uuid(),
  exam_id uuid not null references exams(id) on delete cascade,
  paper_id uuid references exam_papers(id) on delete set null,
  model text not null,
  service_tier text not null default 'standard',
  input_tokens int,
  output_tokens int,
  thought_tokens int,
  est_cost_usd numeric,
  created_at timestamptz default now()
);
create index if not exists exam_ai_usage_exam_idx on exam_ai_usage(exam_id);

-- ---------- Row Level Security: a teacher only sees their own exams ----------
alter table exams enable row level security;
alter table exam_questions enable row level security;
alter table exam_students enable row level security;
alter table exam_papers enable row level security;
alter table exam_paper_pages enable row level security;
alter table exam_scores enable row level security;
alter table exam_ai_usage enable row level security;

drop policy if exists "exams_owner_all" on exams;
create policy "exams_owner_all" on exams for all
  using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());

drop policy if exists "exam_questions_owner_all" on exam_questions;
create policy "exam_questions_owner_all" on exam_questions for all
  using (exists (select 1 from exams e where e.id = exam_questions.exam_id and e.teacher_id = auth.uid()))
  with check (exists (select 1 from exams e where e.id = exam_questions.exam_id and e.teacher_id = auth.uid()));

drop policy if exists "exam_students_owner_all" on exam_students;
create policy "exam_students_owner_all" on exam_students for all
  using (exists (select 1 from exams e where e.id = exam_students.exam_id and e.teacher_id = auth.uid()))
  with check (exists (select 1 from exams e where e.id = exam_students.exam_id and e.teacher_id = auth.uid()));

drop policy if exists "exam_papers_owner_all" on exam_papers;
create policy "exam_papers_owner_all" on exam_papers for all
  using (exists (select 1 from exams e where e.id = exam_papers.exam_id and e.teacher_id = auth.uid()))
  with check (exists (select 1 from exams e where e.id = exam_papers.exam_id and e.teacher_id = auth.uid()));

drop policy if exists "exam_paper_pages_owner_all" on exam_paper_pages;
create policy "exam_paper_pages_owner_all" on exam_paper_pages for all
  using (exists (select 1 from exam_papers p join exams e on e.id = p.exam_id
                 where p.id = exam_paper_pages.paper_id and e.teacher_id = auth.uid()))
  with check (exists (select 1 from exam_papers p join exams e on e.id = p.exam_id
                      where p.id = exam_paper_pages.paper_id and e.teacher_id = auth.uid()));

drop policy if exists "exam_scores_owner_all" on exam_scores;
create policy "exam_scores_owner_all" on exam_scores for all
  using (exists (select 1 from exam_papers p join exams e on e.id = p.exam_id
                 where p.id = exam_scores.paper_id and e.teacher_id = auth.uid()))
  with check (exists (select 1 from exam_papers p join exams e on e.id = p.exam_id
                      where p.id = exam_scores.paper_id and e.teacher_id = auth.uid()));

-- Usage rows are written by the server (service role); teachers can only read them
drop policy if exists "exam_ai_usage_owner_read" on exam_ai_usage;
create policy "exam_ai_usage_owner_read" on exam_ai_usage for select
  using (exists (select 1 from exams e where e.id = exam_ai_usage.exam_id and e.teacher_id = auth.uid()));

-- ---------- Private storage bucket for the photographed pages ----------
-- Files are stored under  <teacher_id>/<exam_id>/<paper_id>/<page>.jpg
insert into storage.buckets (id, name, public)
values ('exam-papers', 'exam-papers', false)
on conflict (id) do nothing;

drop policy if exists "exam_papers_storage_insert" on storage.objects;
create policy "exam_papers_storage_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'exam-papers' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "exam_papers_storage_select" on storage.objects;
create policy "exam_papers_storage_select" on storage.objects for select to authenticated
  using (bucket_id = 'exam-papers' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "exam_papers_storage_delete" on storage.objects;
create policy "exam_papers_storage_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'exam-papers' and (storage.foldername(name))[1] = auth.uid()::text);
