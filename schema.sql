-- ShiftBrain Supabase Schema — QA-audited
-- Safe to re-run: drops all tables first, then recreates.
-- Columns satisfy both internal server.js code AND QA Phase 2 requirements.

drop table if exists public.shift_reports      cascade;
drop table if exists public.approval_requests  cascade;
drop table if exists public.agent_actions      cascade;
drop table if exists public.messages           cascade;
drop table if exists public.camera_events      cascade;
drop table if exists public.work_orders        cascade;
drop table if exists public.workers            cascade;
drop table if exists public.machine_logs       cascade;
drop table if exists public.machines           cascade;
drop table if exists public.shifts             cascade;

-- ── shifts ───────────────────────────────────────────────────────────────────
create table public.shifts (
  id              uuid primary key default gen_random_uuid(),
  name            text,                                        -- QA: shifts.name
  status          text not null default 'active',
  autonomy_score  int  not null default 92,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  summary         text,                                        -- QA: shifts.summary
  facility        text not null default 'Main Plant',
  line            text not null default 'Line 3',
  operator_name   text,
  created_at      timestamptz not null default now()
);

-- ── machines ─────────────────────────────────────────────────────────────────
create table public.machines (
  id                  uuid primary key default gen_random_uuid(),
  shift_id            uuid not null references public.shifts(id) on delete cascade,
  name                text not null,
  line                text,                                    -- QA: machines.line
  status              text not null default 'running',
  temperature         numeric(5,1),
  vibration           numeric(5,2),
  output_rate         numeric(5,1),
  last_maintenance_at timestamptz,                            -- QA: machines.last_maintenance_at
  created_at          timestamptz not null default now()
);

-- ── machine_logs ─────────────────────────────────────────────────────────────
create table public.machine_logs (
  id              uuid primary key default gen_random_uuid(),
  shift_id        uuid not null references public.shifts(id) on delete cascade,
  machine_id      uuid references public.machines(id) on delete set null,
  timestamp       timestamptz not null default now(),          -- QA: machine_logs.timestamp
  log_text        text,                                        -- QA: machine_logs.log_text
  sensor_snapshot jsonb,                                       -- QA: machine_logs.sensor_snapshot
  event_type      text not null default 'reading',
  value           numeric,
  unit            text,
  notes           text,
  recorded_at     timestamptz not null default now()
);

-- ── workers ──────────────────────────────────────────────────────────────────
create table public.workers (
  id           uuid primary key default gen_random_uuid(),
  shift_id     uuid not null references public.shifts(id) on delete cascade,
  name         text not null,
  role         text not null,
  availability text not null default 'available',              -- QA: workers.availability
  skills       text[],                                         -- QA: workers.skills
  zone         text,
  status       text not null default 'on_floor',
  current_task text,
  created_at   timestamptz not null default now()
);

-- ── work_orders ──────────────────────────────────────────────────────────────
create table public.work_orders (
  id                 uuid primary key default gen_random_uuid(),
  shift_id           uuid not null references public.shifts(id) on delete cascade,
  machine_id         uuid references public.machines(id) on delete set null,
  title              text,                                     -- QA: work_orders.title
  description        text not null,
  assigned_worker_id uuid references public.workers(id) on delete set null, -- QA
  assigned_to        text,
  created_by         text not null default 'ShiftBrain',       -- QA: work_orders.created_by
  reason             text,                                     -- QA: work_orders.reason
  type               text not null default 'maintenance',
  priority           text not null default 'medium',
  status             text not null default 'open',
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ── camera_events ─────────────────────────────────────────────────────────────
create table public.camera_events (
  id              uuid primary key default gen_random_uuid(),
  shift_id        uuid not null references public.shifts(id) on delete cascade,
  machine_id      uuid references public.machines(id) on delete set null, -- QA
  zone            text not null,
  event_type      text not null,
  description     text not null,
  vlm_observation text,                                        -- QA: camera_events.vlm_observation
  severity        text not null default 'info',
  image_url       text,
  timestamp       timestamptz not null default now(),          -- QA: camera_events.timestamp
  detected_at     timestamptz not null default now()
);

-- ── messages ─────────────────────────────────────────────────────────────────
create table public.messages (
  id         uuid primary key default gen_random_uuid(),
  shift_id   uuid not null references public.shifts(id) on delete cascade,
  sender     text not null default 'ShiftBrain',               -- QA: messages.sender
  recipient  text not null,                                    -- QA: messages.recipient
  message    text not null,                                    -- QA: messages.message
  from_agent text not null default 'ShiftBrain',
  to_role    text not null,
  content    text not null,
  read       boolean not null default false,
  created_at timestamptz not null default now()
);

-- ── agent_actions ─────────────────────────────────────────────────────────────
create table public.agent_actions (
  id                     uuid primary key default gen_random_uuid(),
  shift_id               uuid not null references public.shifts(id) on delete cascade,
  cycle_number           int  not null default 1,
  action_type            text,                                 -- QA: agent_actions.action_type
  action_summary         text,                                 -- QA: agent_actions.action_summary
  reasoning              text not null,
  confidence             numeric(4,2),                         -- QA: agent_actions.confidence
  risk_level             text,                                 -- QA: agent_actions.risk_level
  human_approval_required boolean not null default false,      -- QA: agent_actions.human_approval_required
  actions_taken          jsonb not null default '[]',
  executed_at            timestamptz not null default now(),   -- QA: agent_actions.executed_at
  created_at             timestamptz not null default now()
);

-- ── approval_requests ─────────────────────────────────────────────────────────
create table public.approval_requests (
  id              uuid primary key default gen_random_uuid(),
  shift_id        uuid not null references public.shifts(id) on delete cascade,
  proposed_action text,                                        -- QA: approval_requests.proposed_action
  risk_level      text,                                        -- QA: approval_requests.risk_level
  reasoning       text,                                        -- QA: approval_requests.reasoning
  type            text not null,
  description     text not null,
  requested_by    text not null default 'ShiftBrain',
  status          text not null default 'pending',
  resolved_by     text,
  resolved_at     timestamptz,
  created_at      timestamptz not null default now()
);

-- ── shift_reports ─────────────────────────────────────────────────────────────
create table public.shift_reports (
  id          uuid primary key default gen_random_uuid(),
  shift_id    uuid not null references public.shifts(id) on delete cascade,
  report_text text,                                            -- QA: shift_reports.report_text
  summary     text not null,
  content     jsonb not null default '{}',
  metrics     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
create index idx_machines_shift          on public.machines(shift_id);
create index idx_machine_logs_shift      on public.machine_logs(shift_id);
create index idx_workers_shift           on public.workers(shift_id);
create index idx_work_orders_shift       on public.work_orders(shift_id);
create index idx_camera_events_shift     on public.camera_events(shift_id);
create index idx_messages_shift          on public.messages(shift_id);
create index idx_agent_actions_shift     on public.agent_actions(shift_id);
create index idx_approval_requests_shift on public.approval_requests(shift_id);
create index idx_shift_reports_shift     on public.shift_reports(shift_id);

-- ── Row Level Security ────────────────────────────────────────────────────────
alter table public.shifts             enable row level security;
alter table public.machines           enable row level security;
alter table public.machine_logs       enable row level security;
alter table public.workers            enable row level security;
alter table public.work_orders        enable row level security;
alter table public.camera_events      enable row level security;
alter table public.messages           enable row level security;
alter table public.agent_actions      enable row level security;
alter table public.approval_requests  enable row level security;
alter table public.shift_reports      enable row level security;
