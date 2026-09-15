-- Delib Tool - Full Supabase Schema (v2)
-- Run this on a fresh database. For existing databases, run migration_v2.sql instead.

-- ============================================================
-- CORE CONTEXT
-- ============================================================

create table if not exists recruitment_cycles (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null,          -- e.g. "FA2024"
  status                  text not null default 'active',   -- active | ended
  accepting_applications  boolean not null default false,
  created_at              timestamptz default now()
);

-- ============================================================
-- PEOPLE & ACCESS
-- ============================================================

-- Replaces authorized_emails — adds role column
create table if not exists authorized_users (
  id        uuid primary key default gen_random_uuid(),
  email     text not null unique,
  role      text not null default 'grader',   -- grader | leadership | admin
  added_by  text,
  added_at  timestamptz default now()
);

-- ============================================================
-- APPLICATION DATA
-- ============================================================

create table if not exists essay_prompts (
  id               uuid primary key default gen_random_uuid(),
  cycle_id         uuid references recruitment_cycles(id) on delete cascade,
  question_number  int not null,       -- 1, 2, 3
  prompt           text not null,
  description      text,
  unique(cycle_id, question_number)
);

create table if not exists applicants (
  id               uuid primary key default gen_random_uuid(),
  cycle_id         uuid references recruitment_cycles(id) on delete cascade,
  first_name       text not null,
  last_name        text not null,
  year             text,               -- graduation year e.g. "2027"
  major            text,
  gender           text,
  race             jsonb,              -- array of strings
  email            text,
  phone            text,
  desired_roles    text,
  linkedin         text,
  website          text,
  time_commitment  text,
  resume_url       text,              -- Supabase Storage URL (not base64)
  created_at       timestamptz default now()
);

create table if not exists essay_responses (
  id            uuid primary key default gen_random_uuid(),
  applicant_id  uuid references applicants(id) on delete cascade,
  prompt_id     uuid references essay_prompts(id) on delete cascade,
  response      text not null,
  unique(applicant_id, prompt_id)
);

-- ============================================================
-- ROUNDS
-- ============================================================

create table if not exists rounds (
  id            uuid primary key default gen_random_uuid(),
  cycle_id      uuid references recruitment_cycles(id) on delete cascade,
  name          text not null,         -- e.g. "Application Review", "Technical Interview"
  order_index   int not null,          -- 1, 2, 3 — controls sequence
  grading_type  text,                  -- rubric | interview | null (delib-only)
  status        text not null default 'pending',  -- pending | grading | deliberating | ended
  created_at    timestamptz default now()
);

-- ============================================================
-- GRADING
-- ============================================================

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
-- DELIBERATION (original delib tool tables, extended)
-- ============================================================

create table if not exists sessions (
  id          text primary key,                                          -- 6-char code e.g. "A3KF9Z"
  round_id    uuid references rounds(id) on delete set null,            -- NEW
  name        text not null,
  created_at  timestamptz default now(),
  status      text not null default 'active',                           -- active | ended
  created_by  text not null,
  anonymous   boolean not null default false
);

create table if not exists candidates (
  id            uuid primary key default gen_random_uuid(),
  session_id    text references sessions(id) on delete cascade,
  applicant_id  uuid references applicants(id) on delete set null,      -- NEW
  name          text not null,
  data          jsonb default '{}',
  status        text not null default 'pending',                        -- pending | accepted | rejected | hold
  created_at    timestamptz default now()
);

create table if not exists votes (
  id            uuid primary key default gen_random_uuid(),
  candidate_id  uuid references candidates(id) on delete cascade,
  voter_name    text not null,
  vote_type     text not null,   -- vouch | anti_vouch | red_flag
  created_at    timestamptz default now(),
  unique(candidate_id, voter_name, vote_type)
);

create table if not exists candidate_notes (
  id            uuid primary key default gen_random_uuid(),
  candidate_id  uuid references candidates(id) on delete cascade,
  author        text not null,
  content       text not null,
  created_at    timestamptz default now(),
  type          text not null default 'note'   -- note | red_flag
);

create table if not exists session_members (
  session_id  text references sessions(id) on delete cascade,
  user_email  text not null,
  joined_at   timestamptz default now(),
  primary key (session_id, user_email)
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table recruitment_cycles  enable row level security;
alter table authorized_users    enable row level security;
alter table essay_prompts       enable row level security;
alter table applicants          enable row level security;
alter table essay_responses     enable row level security;
alter table rounds              enable row level security;
alter table grader_assignments  enable row level security;
alter table reviews             enable row level security;
alter table sessions            enable row level security;
alter table candidates          enable row level security;
alter table votes               enable row level security;
alter table candidate_notes     enable row level security;
alter table session_members     enable row level security;

-- Permissive for now — tighten per-role once app is stable
create policy "Allow all" on recruitment_cycles  for all using (true) with check (true);
create policy "Allow all" on authorized_users    for all using (true) with check (true);
create policy "Allow all" on essay_prompts       for all using (true) with check (true);
create policy "Allow all" on applicants          for all using (true) with check (true);
create policy "Allow all" on essay_responses     for all using (true) with check (true);
create policy "Allow all" on rounds              for all using (true) with check (true);
create policy "Allow all" on grader_assignments  for all using (true) with check (true);
create policy "Allow all" on reviews             for all using (true) with check (true);
create policy "Allow all" on sessions            for all using (true) with check (true);
create policy "Allow all" on candidates          for all using (true) with check (true);
create policy "Allow all" on votes               for all using (true) with check (true);
create policy "Allow all" on candidate_notes     for all using (true) with check (true);
create policy "Allow all" on session_members     for all using (true) with check (true);

-- ============================================================
-- REALTIME
-- ============================================================

alter publication supabase_realtime add table sessions;
alter publication supabase_realtime add table candidates;
alter publication supabase_realtime add table votes;
alter publication supabase_realtime add table session_members;
alter publication supabase_realtime add table reviews;          -- live grading progress
alter publication supabase_realtime add table grader_assignments;
alter publication supabase_realtime add table rounds;

-- ============================================================
-- STORAGE
-- ============================================================

-- Run in Supabase dashboard > Storage > New bucket:
--   Name: resumes
--   Public: false
--   Allowed MIME types: application/pdf
