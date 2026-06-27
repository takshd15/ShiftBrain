-- ShiftBrain migration — adds QA-required columns to existing tables.
-- Safe to run on a live database: uses ADD COLUMN IF NOT EXISTS, no data loss.
-- Run this in Supabase SQL Editor if you already have data and don't want to
-- drop and recreate. If starting fresh, use schema.sql instead.

alter table public.shifts
  add column if not exists name    text,
  add column if not exists summary text;

alter table public.machines
  add column if not exists line                text,
  add column if not exists last_maintenance_at timestamptz;

alter table public.machine_logs
  add column if not exists timestamp       timestamptz default now(),
  add column if not exists log_text        text,
  add column if not exists sensor_snapshot jsonb;

alter table public.workers
  add column if not exists availability text default 'available',
  add column if not exists skills       text[];

alter table public.work_orders
  add column if not exists title              text,
  add column if not exists assigned_worker_id uuid,
  add column if not exists created_by         text default 'ShiftBrain',
  add column if not exists reason             text;

alter table public.camera_events
  add column if not exists machine_id     uuid,
  add column if not exists vlm_observation text,
  add column if not exists timestamp      timestamptz default now();

alter table public.messages
  add column if not exists sender    text default 'ShiftBrain',
  add column if not exists recipient text,
  add column if not exists message   text;

-- Back-fill recipient/message from existing rows
update public.messages set recipient = to_role    where recipient is null;
update public.messages set message   = content    where message   is null;
update public.messages set sender    = from_agent where sender    is null;

alter table public.messages
  alter column recipient set not null,
  alter column message   set not null,
  alter column sender    set not null;

alter table public.agent_actions
  add column if not exists action_type             text,
  add column if not exists action_summary          text,
  add column if not exists confidence              numeric(4,2),
  add column if not exists risk_level              text,
  add column if not exists human_approval_required boolean default false,
  add column if not exists executed_at             timestamptz default now();

alter table public.approval_requests
  add column if not exists proposed_action text,
  add column if not exists risk_level      text,
  add column if not exists reasoning       text;

alter table public.shift_reports
  add column if not exists report_text text;
