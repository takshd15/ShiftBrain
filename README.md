# ShiftBrain

Autonomous factory shift command center demo.

ShiftBrain shows an end-to-end operations workflow: a shift starts clean, live factory events appear over time, the agent connects evidence across safety, maintenance, quality, inventory, and production, then creates workflow actions and generates a shift handoff report.

## What Is Included

- `demo.html` - interactive product demo UI.
- `server.js` - Express backend for Supabase state and model-backed agent runs.
- `schema.sql` - full Supabase schema for a fresh database.
- `migration.sql` - additive migration for an existing database.
- `automentic-landing.html` - related landing page artifact.

Large local training videos and generated dependencies are intentionally ignored.

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev
```

Open:

```text
http://localhost:3001/demo.html
```

The static demo can also be opened directly in a browser, but the API-backed features need the Express server.

## Environment

Create `.env` from `.env.example`:

```text
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_KEY=
DATABASE_URL=
GEMINI_API_KEY=
VLLM_URL=
VLLM_KEY=
VLLM_MODEL=
PORT=3001
```

Do not commit `.env`. The service key, database URL, and model keys are server-only secrets.

## Database Setup

For a fresh Supabase database, run `schema.sql` in the Supabase SQL Editor.

For an existing database, run `migration.sql` instead. It uses additive `alter table ... add column if not exists` statements where possible.

If you use Supabase Storage for visual evidence, create a `factory-frames` bucket and upload only a small curated demo set, such as:

- `frames/ppe_missing_vest_001.jpg`
- `frames/forklift_zone_001.jpg`
- `frames/worker_near_forklift_001.jpg`
- `frames/spill_floor_001.jpg`
- `frames/fire_smoke_001.jpg`
- `frames/factory_line_001.jpg`

## GitHub Safety Check

Before pushing:

```bash
npm run check
```

This validates `server.js` syntax and scans publishable files for obvious leaked credentials.

The repository ignores:

- `.env` and other local env files
- `node_modules/`
- `.claude/settings.local.json`
- `sop-sample-training-data/`
- large video files
- build/cache/log output

## Demo Flow

The Command Center page demonstrates:

1. Clean shift baseline.
2. Events detected over time.
3. Evidence chain and likely root cause.
4. Workflow actions with system IDs.
5. Generated shift handoff report.

This is designed to show that ShiftBrain does more than display alerts: it owns the shift workflow from detection through handoff.
