-- Migration v2: Expand existing delib tool DB for consolidated app
-- Run this in Supabase SQL editor against your existing database.
-- Safe to run multiple times (uses IF NOT EXISTS / IF EXISTS guards).

-- ============================================================
-- NEW TABLES
-- ============================================================

create table if not exists recruitment_cycles (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null,
  status                  text not null default 'active',
  accepting_applications  boolean not null default false,
  created_at              timestamptz default now()
);

create table if not exists authorized_users (
  id        uuid primary key default gen_random_uuid(),
  email     text not null unique,
  role      text not null default 'grader',   -- grader | leadership | admin
  added_by  text,
  added_at  timestamptz default now()
);

-- Migrate existing authorized_emails into authorized_users (preserves data)
insert into authorized_users (email, added_by, added_at)
select email, added_by, added_at
from authorized_emails
on conflict (email) do nothing;

create table if not exists essay_prompts (
  id               uuid primary key default gen_random_uuid(),
  cycle_id         uuid references recruitment_cycles(id) on delete cascade,
  question_number  int not null,
  prompt           text not null,
  description      text,
  unique(cycle_id, question_number)
);

create table if not exists applicants (
  id               uuid primary key default gen_random_uuid(),
  cycle_id         uuid references recruitment_cycles(id) on delete cascade,
  first_name       text not null,
  last_name        text not null,
  year             text,
  major            text,
  gender           text,
  race             jsonb,
  desired_roles    text,
  linkedin         text,
  website          text,
  time_commitment  text,
  resume_url       text,
  created_at       timestamptz default now()
);

create table if not exists essay_responses (
  id            uuid primary key default gen_random_uuid(),
  applicant_id  uuid references applicants(id) on delete cascade,
  prompt_id     uuid references essay_prompts(id) on delete cascade,
  response      text not null,
  unique(applicant_id, prompt_id)
);

create table if not exists rounds (
  id            uuid primary key default gen_random_uuid(),
  cycle_id      uuid references recruitment_cycles(id) on delete cascade,
  name          text not null,
  order_index   int not null,
  grading_type  text,
  status        text not null default 'pending',
  created_at    timestamptz default now()
);

create table if not exists grader_assignments (
  id            uuid primary key default gen_random_uuid(),
  round_id      uuid references rounds(id) on delete cascade,
  applicant_id  uuid references applicants(id) on delete cascade,
  grader_email  text not null,
  assigned_at   timestamptz default now(),
  unique(round_id, applicant_id, grader_email)
);

create table if not exists reviews (
  id            uuid primary key default gen_random_uuid(),
  round_id      uuid references rounds(id) on delete cascade,
  applicant_id  uuid references applicants(id) on delete cascade,
  grader_email  text not null,
  r0  numeric, r1  numeric, r2  numeric, r3  numeric, r4  numeric,
  r5  numeric, r6  numeric, r7  numeric, r8  numeric, r9  numeric,
  comment0  text, comment1  text, comment2  text, comment3  text, comment4  text,
  submitted_at  timestamptz default now(),
  unique(round_id, applicant_id, grader_email)
);

-- ============================================================
-- ALTER EXISTING TABLES
-- ============================================================

-- sessions: link to a round
alter table sessions
  add column if not exists round_id uuid references rounds(id) on delete set null;

-- candidates: link back to source applicant
alter table candidates
  add column if not exists applicant_id uuid references applicants(id) on delete set null;

-- applicants: add contact fields missing from initial schema
alter table applicants add column if not exists email text;
alter table applicants add column if not exists phone text;

-- ============================================================
-- RLS ON NEW TABLES
-- ============================================================

alter table recruitment_cycles  enable row level security;
alter table authorized_users    enable row level security;
alter table essay_prompts       enable row level security;
alter table applicants          enable row level security;
alter table essay_responses     enable row level security;
alter table rounds              enable row level security;
alter table grader_assignments  enable row level security;
alter table reviews             enable row level security;

drop policy if exists "Allow all" on recruitment_cycles;
drop policy if exists "Allow all" on authorized_users;
drop policy if exists "Allow all" on essay_prompts;
drop policy if exists "Allow all" on applicants;
drop policy if exists "Allow all" on essay_responses;
drop policy if exists "Allow all" on rounds;
drop policy if exists "Allow all" on grader_assignments;
drop policy if exists "Allow all" on reviews;

create policy "Allow all" on recruitment_cycles  for all using (true) with check (true);
create policy "Allow all" on authorized_users    for all using (true) with check (true);
create policy "Allow all" on essay_prompts       for all using (true) with check (true);
create policy "Allow all" on applicants          for all using (true) with check (true);
create policy "Allow all" on essay_responses     for all using (true) with check (true);
create policy "Allow all" on rounds              for all using (true) with check (true);
create policy "Allow all" on grader_assignments  for all using (true) with check (true);
create policy "Allow all" on reviews             for all using (true) with check (true);

-- ============================================================
-- REALTIME ON NEW TABLES
-- ============================================================

do $$ begin
  alter publication supabase_realtime add table reviews;
exception when others then null; end $$;
do $$ begin
  alter publication supabase_realtime add table grader_assignments;
exception when others then null; end $$;
do $$ begin
  alter publication supabase_realtime add table rounds;
exception when others then null; end $$;

-- ============================================================
-- STORAGE (do this in Supabase dashboard > Storage)
-- ============================================================
-- Create a new bucket:
--   Name:              resumes
--   Public:            false
--   Allowed MIME types: application/pdf
