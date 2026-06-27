import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));   // serves demo.html, favicon, etc.

// ── Startup env validation ────────────────────────────────────────────────────
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'GEMINI_API_KEY'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
  console.error(`[ShiftBrain] STARTUP BLOCKED — missing env vars: ${missingEnv.join(', ')}`);
  console.error('Copy .env.example → .env and fill in all values.');
  console.warn('Static demo can still run. API routes will return 503 until env vars are configured.');
}

// ── Clients ───────────────────────────────────────────────────────────────────

const hasSupabaseEnv = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
const supabase = hasSupabaseEnv
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;
const GEMINI_MODEL = 'gemini-2.5-flash';

// ── Schema capability detection ───────────────────────────────────────────────
// Probed once at startup. Inserts spread new columns only when they exist so
// the server starts cleanly before migration.sql is applied.
const schemaHas = {
  shifts_name:    false,   // shifts: name, summary
  machines_line:  false,   // machines: line, last_maintenance_at
  logs_text:      false,   // machine_logs: log_text, sensor_snapshot, timestamp
  workers_skills: false,   // workers: availability, skills
  wo_title:       false,   // work_orders: title, assigned_worker_id, created_by, reason
  cam_vlm:        false,   // camera_events: vlm_observation, machine_id, timestamp
  msg_sender:     false,   // messages: sender, recipient, message
  aa_risk:        false,   // agent_actions: action_type, action_summary, confidence, risk_level, executed_at
  ar_proposed:    false,   // approval_requests: proposed_action, risk_level, reasoning
  sr_text:        false,   // shift_reports: report_text
};
(async () => {
  if (!supabase) {
    console.warn('[ShiftBrain] Schema probe skipped because Supabase env is not configured.');
    return;
  }

  const probe = async (table, col) => {
    const { error } = await supabase.from(table).select(col).limit(1);
    return !error;
  };
  schemaHas.shifts_name    = await probe('shifts',            'name');
  schemaHas.machines_line  = await probe('machines',          'line');
  schemaHas.logs_text      = await probe('machine_logs',      'log_text');
  schemaHas.workers_skills = await probe('workers',           'availability');
  schemaHas.wo_title       = await probe('work_orders',       'title');
  schemaHas.cam_vlm        = await probe('camera_events',     'vlm_observation');
  schemaHas.msg_sender     = await probe('messages',          'sender');
  schemaHas.aa_risk        = await probe('agent_actions',     'risk_level');
  schemaHas.ar_proposed    = await probe('approval_requests', 'proposed_action');
  schemaHas.sr_text        = await probe('shift_reports',     'report_text');
  const migrated = Object.values(schemaHas).every(Boolean);
  console.log(`[ShiftBrain] Schema: ${migrated ? 'FULL (migration applied)' : 'PARTIAL — run migration.sql to unlock all columns'}`, schemaHas);
})();

// ── Helpers ───────────────────────────────────────────────────────────────────

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

function requireSupabase(_req, res, next) {
  if (!supabase) {
    return fail(res, 503, 'Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_KEY.');
  }
  return next();
}

async function gemini(systemInstruction, userPrompt) {
  if (!ai) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    config: { systemInstruction },
    contents: userPrompt,
  });
  return response.text;
}

function extractJson(raw) {
  const match = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
  return JSON.parse(match ? match[1] : raw);
}

async function fetchShiftContext(shiftId) {
  const [
    { data: shift },
    { data: machines },
    { data: machine_logs },
    { data: workers },
    { data: work_orders },
    { data: camera_events },
    { data: messages },
    { data: agent_actions },
    { data: approval_requests },
    { data: shift_reports },
  ] = await Promise.all([
    supabase.from('shifts').select('*').eq('id', shiftId).single(),
    supabase.from('machines').select('*').eq('shift_id', shiftId),
    supabase.from('machine_logs').select('*').eq('shift_id', shiftId).order('recorded_at', { ascending: false }).limit(50),
    supabase.from('workers').select('*').eq('shift_id', shiftId),
    supabase.from('work_orders').select('*').eq('shift_id', shiftId),
    supabase.from('camera_events').select('*').eq('shift_id', shiftId).order('detected_at', { ascending: false }).limit(20),
    supabase.from('messages').select('*').eq('shift_id', shiftId).order('created_at', { ascending: false }).limit(20),
    supabase.from('agent_actions').select('*').eq('shift_id', shiftId).order('created_at', { ascending: false }).limit(10),
    supabase.from('approval_requests').select('*').eq('shift_id', shiftId),
    supabase.from('shift_reports').select('*').eq('shift_id', shiftId),
  ]);

  return { shift, machines, machine_logs, workers, work_orders, camera_events, messages, agent_actions, approval_requests, shift_reports };
}

// ── Route 0: GET /api/config ──────────────────────────────────────────────────

app.get('/api/config', (_req, res) => {
  res.json({
    supabase_url: process.env.SUPABASE_URL,
    supabase_anon_key: process.env.SUPABASE_ANON_KEY,
  });
});

app.use('/api', requireSupabase);

// ── Route 1: POST /api/shifts/start ──────────────────────────────────────────

app.post('/api/shifts/start', async (req, res) => {
  const { facility = 'Main Plant', line = 'Line 3', operator_name } = req.body;
  const shiftName = `${facility} — ${line} — ${new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;

  const shiftRow = {
    status: 'active', started_at: new Date().toISOString(),
    autonomy_score: 92, facility, line, operator_name: operator_name ?? null,
    ...(schemaHas.shifts_name && { name: shiftName, summary: null }),
  };

  const { data: shift, error } = await supabase
    .from('shifts')
    .insert(shiftRow)
    .select()
    .single();

  if (error) return fail(res, 500, error.message);

  await supabase.from('machines').insert([
    { shift_id: shift.id, name: 'Conveyor B',        status: 'warning', temperature: 84, vibration: 2.1, output_rate: 68,
      ...(schemaHas.machines_line && { line: 'Line 2', last_maintenance_at: new Date(Date.now() - 14 * 86400000).toISOString() }) },
    { shift_id: shift.id, name: 'Press Machine A',   status: 'running', temperature: 68, vibration: 0.3, output_rate: 99,
      ...(schemaHas.machines_line && { line: 'Line 1' }) },
    { shift_id: shift.id, name: 'Packaging Robot C', status: 'warning', temperature: 71, vibration: 0.5, output_rate: 81,
      ...(schemaHas.machines_line && { line: 'Line 3' }) },
  ]);

  await supabase.from('workers').insert([
    { shift_id: shift.id, name: 'Ava',  role: 'Operator',               zone: 'Line 2',          status: 'on_floor',
      ...(schemaHas.workers_skills && { availability: 'available', skills: ['conveyor','packaging'] }) },
    { shift_id: shift.id, name: 'Leo',  role: 'Maintenance Technician', zone: 'Maintenance Bay', status: 'on_floor',
      ...(schemaHas.workers_skills && { availability: 'available', skills: ['belts','motors','conveyor'] }) },
    { shift_id: shift.id, name: 'Mina', role: 'Safety Lead',            zone: 'Zone A3',         status: 'on_floor',
      ...(schemaHas.workers_skills && { availability: 'busy',      skills: ['safety','compliance'] }) },
    { shift_id: shift.id, name: 'Raj',  role: 'Supervisor',             zone: 'Control Room',    status: 'on_floor',
      ...(schemaHas.workers_skills && { availability: 'available', skills: ['escalation','shift coordination'] }) },
  ]);

  res.json({ shift_id: shift.id, shift });
});

// ── Route 2: GET /api/shifts/:id/state ───────────────────────────────────────

app.get('/api/shifts/:id/state', async (req, res) => {
  const ctx = await fetchShiftContext(req.params.id);
  if (!ctx.shift) return fail(res, 404, 'Shift not found');
  res.json(ctx);
});

// ── Route 3: POST /api/agent/run ─────────────────────────────────────────────
// One autonomous reasoning cycle powered by Gemini 2.5 Flash.

// ── Tool execution allowlist ───────────────────────────────────────────────────
// Only these action types may be executed. Unknown types are logged and skipped.
const ALLOWED_ACTIONS = new Set([
  'create_work_order',
  'update_work_order',
  'assign_worker',
  'send_message',
  'log_shift_note',
  'request_human_approval',
  'continue_monitoring',
  'generate_shift_report',
]);

// These action types always route through the approval queue, regardless of
// what the LLM says. The backend never stops a line autonomously.
const HIGH_RISK_ACTIONS = new Set([
  'stop_production_line',
  'emergency_shutdown',
  'halt_line',
  'scrap_batch',
  'fire_worker',
]);

const SYSTEM_PROMPT = `You are ShiftBrain, an autonomous AI shift lead for a manufacturing floor.

Your job is to run the shift end-to-end with minimal human involvement. You observe connected factory tools including machine logs, work orders, worker availability, camera observations, messages, and previous shift notes.

You must reason adaptively from the provided context. Do not rely on fixed thresholds or hardcoded rules. Consider the whole situation before deciding.

You can take these actions:
- create_work_order
- update_work_order
- assign_worker
- send_message
- log_shift_note
- request_human_approval
- generate_shift_report
- continue_monitoring

Most routine actions should be handled autonomously. Only request human approval for high-risk actions such as stopping a production line, safety-critical uncertainty, or expensive repair decisions.

Return only valid JSON.`;

app.post('/api/agent/run', async (req, res) => {
  const { shift_id } = req.body;
  if (!shift_id) return fail(res, 400, 'shift_id is required');

  const ctx = await fetchShiftContext(shift_id);
  if (!ctx.shift) return fail(res, 404, 'Shift not found');
  if (ctx.shift.status !== 'active') return fail(res, 400, 'Shift is not active');

  const cycleNumber = (ctx.agent_actions?.length ?? 0) + 1;

  const userPrompt = `Current shift context:

Machines:
${JSON.stringify(ctx.machines, null, 2)}

Machine logs:
${JSON.stringify(ctx.machine_logs, null, 2)}

Open work orders:
${JSON.stringify(ctx.work_orders?.filter(wo => wo.status !== 'completed'), null, 2)}

Workers:
${JSON.stringify(ctx.workers, null, 2)}

Camera observations:
${JSON.stringify(ctx.camera_events, null, 2)}

Recent messages:
${JSON.stringify(ctx.messages, null, 2)}

Previous agent actions:
${JSON.stringify(ctx.agent_actions, null, 2)}

Decide what ShiftBrain should do next as the autonomous shift lead.

Respond with this exact JSON shape:
{
  "situation_summary": "string",
  "reasoning": ["string"],
  "risk_level": "low | medium | high | critical",
  "confidence": 0.0,
  "actions": [
    {
      "type": "create_work_order | update_work_order | assign_worker | send_message | log_shift_note | request_human_approval | continue_monitoring | generate_shift_report",
      "title": "string",
      "priority": "low | medium | high | critical",
      "machine_name": "string",
      "assigned_to": "string",
      "recipient": "string",
      "message": "string",
      "reason": "string"
    }
  ],
  "human_approval_required": true
}`;

  let raw;
  try {
    raw = await gemini(SYSTEM_PROMPT, userPrompt);
  } catch (err) {
    // LLM unavailable — preserve last known state rather than erroring.
    await supabase.from('agent_actions').insert({
      shift_id, cycle_number: cycleNumber,
      reasoning: `[LLM_UNAVAILABLE] ${err.message}`,
      actions_taken: [],
    });
    const fallbackCtx = await fetchShiftContext(shift_id);
    return res.json({
      cycle: cycleNumber,
      llm_error: true,
      error_message: 'Agent temporarily unable to reason. Last known shift state preserved.',
      state: fallbackCtx,
    });
  }

  let parsed;
  try {
    parsed = extractJson(raw);
  } catch {
    // Unparseable response — still graceful.
    await supabase.from('agent_actions').insert({
      shift_id, cycle_number: cycleNumber,
      reasoning: `[PARSE_ERROR] Raw: ${raw?.slice(0, 500)}`,
      actions_taken: [],
    });
    const fallbackCtx = await fetchShiftContext(shift_id);
    return res.json({
      cycle: cycleNumber,
      llm_error: true,
      error_message: 'Agent temporarily unable to reason. Last known shift state preserved.',
      raw_response: raw,
      state: fallbackCtx,
    });
  }

  const { situation_summary, reasoning, risk_level, confidence, actions = [], human_approval_required } = parsed;

  const reasoningText = situation_summary + '\n\n' + (Array.isArray(reasoning) ? reasoning.join('\n') : reasoning);
  const actionSummary = actions.length
    ? actions.map(a => `${a.type}: ${a.title || a.message || a.reason || '—'}`).join(' | ')
    : 'continue_monitoring';

  const { data: actionRecord } = await supabase
    .from('agent_actions')
    .insert({
      shift_id,
      cycle_number:  cycleNumber,
      reasoning:     reasoningText,
      actions_taken: actions,
      ...(schemaHas.aa_risk && {
        action_type:             actions[0]?.type ?? 'continue_monitoring',
        action_summary:          actionSummary,
        confidence:              confidence ?? null,
        risk_level:              risk_level ?? 'low',
        human_approval_required: human_approval_required ?? false,
        executed_at:             new Date().toISOString(),
      }),
    })
    .select()
    .single();

  const executed = [];
  for (const action of actions) {
    // Gate 1: reject unknown action types entirely.
    if (!ALLOWED_ACTIONS.has(action.type) && !HIGH_RISK_ACTIONS.has(action.type)) {
      executed.push({ action, skipped: true, reason: `Unknown action type: ${action.type}` });
      continue;
    }

    // Gate 2: high-risk actions are never executed directly — always routed to approval queue.
    if (HIGH_RISK_ACTIONS.has(action.type)) {
      const { data } = await supabase.from('approval_requests').insert({
        shift_id,
        type: action.type,
        description: `[Auto-gated high-risk action] ${action.reason ?? action.title ?? action.type}`,
        requested_by: 'ShiftBrain',
        status: 'pending',
      }).select().single();
      executed.push({ action, gated: true, reason: 'High-risk action routed to approval queue', approval: data });
      continue;
    }

    // Gate 3: no-op for continue_monitoring.
    if (action.type === 'continue_monitoring') {
      executed.push({ action, result: { note: 'Monitoring — no action taken' }, ok: true });
      continue;
    }

    try {
      const result = await executeAction(shift_id, action, ctx);
      executed.push({ action, result, ok: true });
    } catch (err) {
      executed.push({ action, error: err.message, ok: false });
    }
  }

  const updatedCtx = await fetchShiftContext(shift_id);
  res.json({
    cycle: cycleNumber,
    situation_summary,
    reasoning,
    risk_level,
    confidence,
    human_approval_required,
    executed,
    state: updatedCtx,
  });
});

async function executeAction(shiftId, action, ctx) {
  switch (action.type) {
    case 'create_work_order': {
      const machine = ctx.machines?.find(m => m.name === action.machine_name);
      const worker  = ctx.workers?.find(w => w.name?.toLowerCase().includes((action.assigned_to ?? '').toLowerCase()));
      const { data, error } = await supabase.from('work_orders').insert({
        shift_id:    shiftId,
        machine_id:  machine?.id ?? null,
        description: action.title ?? action.reason ?? 'Work Order',
        assigned_to: action.assigned_to ?? null,
        type:        'maintenance',
        priority:    action.priority ?? 'medium',
        status:      'open',
        ...(schemaHas.wo_title && {
          title:              action.title ?? action.reason ?? 'Work Order',
          assigned_worker_id: worker?.id ?? null,
          created_by:         'ShiftBrain',
          reason:             action.reason ?? null,
        }),
      }).select().single();
      if (error) throw new Error(error.message);
      return data;
    }

    case 'update_work_order': {
      // Fuzzy match: check if any meaningful word from the action title appears in the WO
      const actionWords = (action.title ?? '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const wo = ctx.work_orders?.find(w => {
        const haystack = ((w.title ?? '') + ' ' + (w.description ?? '')).toLowerCase();
        return actionWords.length > 0
          ? actionWords.some(word => haystack.includes(word))
          : haystack.includes((action.machine_name ?? '').toLowerCase());
      }) ?? ctx.work_orders?.[0];   // last resort: update the most recent WO
      if (!wo) throw new Error('No work orders found to update');
      const { data, error } = await supabase
        .from('work_orders')
        .update({
          status:     action.status ?? 'in_progress',
          priority:   action.priority ?? wo.priority,
          notes:      action.reason ?? wo.notes,
          updated_at: new Date().toISOString(),
        })
        .eq('id', wo.id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data;
    }

    case 'assign_worker': {
      const worker = ctx.workers?.find(w =>
        w.name?.toLowerCase().includes((action.assigned_to ?? '').toLowerCase())
      );
      if (!worker) throw new Error(`Worker not found: ${action.assigned_to}`);
      const { data, error } = await supabase
        .from('workers')
        .update({ zone: action.machine_name ?? worker.zone, current_task: action.title ?? action.task ?? action.reason?.slice(0, 100) ?? null, status: 'on_floor' })
        .eq('id', worker.id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data;
    }

    case 'send_message': {
      const msg = action.message ?? action.title;
      const to  = action.recipient ?? 'Supervisor';
      const { data, error } = await supabase.from('messages').insert({
        shift_id:   shiftId,
        from_agent: 'ShiftBrain',
        to_role:    to,
        content:    msg,
        ...(schemaHas.msg_sender && { sender: 'ShiftBrain', recipient: to, message: msg }),
      }).select().single();
      if (error) throw new Error(error.message);
      return data;
    }

    case 'log_shift_note': {
      const msg = action.message ?? action.title ?? action.reason ?? 'Shift note';
      const { data, error } = await supabase.from('messages').insert({
        shift_id:   shiftId,
        from_agent: 'ShiftBrain',
        to_role:    'shift_log',
        content:    msg,
        ...(schemaHas.msg_sender && { sender: 'ShiftBrain', recipient: 'shift_log', message: msg }),
      }).select().single();
      if (error) throw new Error(error.message);
      return data;
    }

    case 'request_human_approval': {
      const desc = action.reason ?? action.message ?? action.title;
      const { data, error } = await supabase.from('approval_requests').insert({
        shift_id:    shiftId,
        type:        action.title ?? 'approval',
        description: desc,
        requested_by:'ShiftBrain',
        status:      'pending',
        ...(schemaHas.ar_proposed && {
          proposed_action: action.title ?? desc,
          risk_level:      action.priority ?? 'high',
          reasoning:       action.reason ?? null,
        }),
      }).select().single();
      if (error) throw new Error(error.message);
      return data;
    }

    case 'generate_shift_report': {
      const reportRes = await fetch(`http://localhost:${process.env.PORT ?? 3001}/api/reports/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shift_id: shiftId }),
      });
      return reportRes.json();
    }

    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }
}

// ── Route 4: POST /api/vision/analyze ────────────────────────────────────────

app.post('/api/vision/analyze', async (req, res) => {
  const { image_url, machine_id, shift_id } = req.body;
  if (!image_url || !machine_id) return fail(res, 400, 'image_url and machine_id are required');

  try {
    const imageResp = await fetch(image_url);
    if (!imageResp.ok) throw new Error(`Could not fetch image: ${imageResp.status}`);
    const buffer = await imageResp.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const mimeType = imageResp.headers.get('content-type') || 'image/jpeg';

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: {
        parts: [
          { inlineData: { mimeType, data: base64 } },
          {
            text: `You are an industrial vision system inspecting Machine ${machine_id}. Describe any visible abnormalities, safety hazards, or equipment issues in 1-2 sentences. Be specific and technical. If everything looks normal, say so.`,
          },
        ],
      },
    });

    const vlm_observation = response.text;

    if (shift_id) {
      await supabase.from('camera_events').insert({
        shift_id,
        zone: `Machine ${machine_id}`,
        event_type: 'vlm_analysis',
        description: vlm_observation,
        severity: 'info',
        image_url,
      });
    }

    res.json({ vlm_observation, source: 'vlm' });
  } catch (err) {
    const { data: fallback } = shift_id
      ? await supabase
          .from('camera_events')
          .select('description')
          .eq('shift_id', shift_id)
          .ilike('zone', `%${machine_id}%`)
          .order('detected_at', { ascending: false })
          .limit(1)
          .single()
      : { data: null };

    const vlm_observation = fallback?.description
      ?? 'The VLM endpoint is integrated as a visual adapter. If it is unavailable, ShiftBrain continues using stored camera observations and other factory systems.';
    res.json({ vlm_observation, source: 'fallback', fallback_reason: err.message });
  }
});

// ── Route 5: POST /api/reports/generate ──────────────────────────────────────

app.post('/api/reports/generate', async (req, res) => {
  const { shift_id } = req.body;
  if (!shift_id) return fail(res, 400, 'shift_id is required');

  const ctx = await fetchShiftContext(shift_id);
  if (!ctx.shift) return fail(res, 404, 'Shift not found');

  const prompt = `You are ShiftBrain generating the final shift report for handoff to the next supervisor.

Based on the following complete shift history, write a structured JSON report.

SHIFT DATA:
${JSON.stringify(ctx, null, 2)}

Respond ONLY with valid JSON in this exact shape:
{
  "summary": "2-3 sentence executive summary of the shift",
  "root_causes": ["list of identified root causes"],
  "actions_taken": ["list of actions ShiftBrain took"],
  "open_items": ["list of items requiring next shift attention"],
  "metrics": {
    "events_detected": 0,
    "work_orders_created": 0,
    "workers_deployed": 0,
    "safety_incidents": 0,
    "output_rate_avg": 0
  },
  "next_shift_instructions": "clear paragraph for the incoming supervisor"
}`;

  let reportJson;
  try {
    const raw = await gemini('You generate concise, structured factory shift reports.', prompt);
    reportJson = extractJson(raw);
  } catch (err) {
    return fail(res, 502, `Report generation failed: ${err.message}`);
  }

  const reportText = [
    reportJson.summary,
    '\n\nActions taken:\n' + (reportJson.actions_taken ?? []).join('\n'),
    '\nOpen items:\n' + (reportJson.open_items ?? []).join('\n'),
    '\nNext shift:\n' + (reportJson.next_shift_instructions ?? ''),
  ].join('');

  const { data: report, error: reportError } = await supabase
    .from('shift_reports')
    .insert({
      shift_id,
      summary: reportJson.summary,
      content: reportJson,
      metrics: reportJson.metrics,
      ...(schemaHas.sr_text && { report_text: reportText }),
    })
    .select()
    .single();

  if (reportError) return fail(res, 500, reportError.message);

  await supabase
    .from('shifts')
    .update({ status: 'completed', ended_at: new Date().toISOString() })
    .eq('id', shift_id);

  res.json({ report, shift_id, status: 'completed' });
});

// ── PATCH /api/approvals/:id ──────────────────────────────────────────────────
// Approve or reject a human approval request.

app.patch('/api/approvals/:id', async (req, res) => {
  const { status, resolved_by = 'Supervisor' } = req.body;
  if (!['approved', 'rejected'].includes(status)) return fail(res, 400, 'status must be approved or rejected');

  const { data, error } = await supabase
    .from('approval_requests')
    .update({ status, resolved_by, resolved_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return fail(res, 500, error.message);
  res.json(data);
});

// ── POST /api/demo/seed ───────────────────────────────────────────────────────
// Phase 3 compliant seed — exact machines, workers, logs, work orders, camera
// events, and messages specified by the QA plan. Safe to re-run: each call
// creates a fresh shift; old demo shifts are NOT deleted (use Supabase UI or
// add a cleanup step if needed).

app.post('/api/demo/seed', async (req, res) => {
  const t = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();

  // 1. Shift
  const { data: shift, error: shiftErr } = await supabase
    .from('shifts')
    .insert({
      status:         'active',
      started_at:     new Date().toISOString(),
      autonomy_score: 92,
      facility:       'Main Plant',
      line:           'Line 2',
      operator_name:  'Demo Operator',
      ...(schemaHas.shifts_name && { name: 'Main Plant — Line 2 — Demo Shift', summary: null }),
    })
    .select().single();
  if (shiftErr) return fail(res, 500, shiftErr.message);
  const sid = shift.id;

  // 2. Machines (Phase 3 spec: Conveyor B / Press Machine A / Packaging Robot C)
  const { data: machines } = await supabase.from('machines').insert([
    { shift_id: sid, name: 'Conveyor B',        status: 'running', temperature: 82, vibration: 0.74, output_rate: 88,
      ...(schemaHas.machines_line && { line: 'Line 2', last_maintenance_at: new Date(Date.now() - 14 * 86400000).toISOString() }) },
    { shift_id: sid, name: 'Press Machine A',   status: 'running', temperature: 67, vibration: 0.28, output_rate: 99,
      ...(schemaHas.machines_line && { line: 'Line 1' }) },
    { shift_id: sid, name: 'Packaging Robot C', status: 'warning', temperature: 70, vibration: 0.42, output_rate: 81,
      ...(schemaHas.machines_line && { line: 'Line 3' }) },
  ]).select();

  const conveyorB = machines?.find(m => m.name === 'Conveyor B');

  // 3. Workers (Phase 3 spec: Ava / Leo / Mina / Raj)
  await supabase.from('workers').insert([
    { shift_id: sid, name: 'Ava',  role: 'Operator',               zone: 'Line 2',          status: 'on_floor',
      ...(schemaHas.workers_skills && { availability: 'available', skills: ['conveyor','packaging'] }) },
    { shift_id: sid, name: 'Leo',  role: 'Maintenance Technician', zone: 'Maintenance Bay', status: 'on_floor',
      ...(schemaHas.workers_skills && { availability: 'available', skills: ['belts','motors','conveyor'] }) },
    { shift_id: sid, name: 'Mina', role: 'Safety Lead',            zone: 'Zone A3',         status: 'on_floor',
      ...(schemaHas.workers_skills && { availability: 'busy',      skills: ['safety','compliance'] }) },
    { shift_id: sid, name: 'Raj',  role: 'Supervisor',             zone: 'Control Room',    status: 'on_floor',
      ...(schemaHas.workers_skills && { availability: 'available', skills: ['escalation','shift coordination'] }) },
  ]);

  // 4. Machine logs — progressive Conveyor B vibration issue (Phase 3 spec)
  await supabase.from('machine_logs').insert([
    {
      shift_id: sid, machine_id: conveyorB?.id,
      event_type: 'normal_operation', value: 0.31, unit: 'mm/s', notes: 'Normal operation', recorded_at: t(60),
      ...(schemaHas.logs_text && { log_text: 'Conveyor B operating within normal parameters.',
        sensor_snapshot: { temperature: 75, vibration: 0.31, throughput: 98, error_count: 0 }, timestamp: t(60) }),
    },
    {
      shift_id: sid, machine_id: conveyorB?.id,
      event_type: 'vibration_reading', value: 0.51, unit: 'mm/s', notes: 'Slight vibration increase', recorded_at: t(45),
      ...(schemaHas.logs_text && { log_text: 'Slight vibration increase detected on Conveyor B.',
        sensor_snapshot: { temperature: 78, vibration: 0.51, throughput: 95, error_count: 1 }, timestamp: t(45) }),
    },
    {
      shift_id: sid, machine_id: conveyorB?.id,
      event_type: 'vibration_reading', value: 0.74, unit: 'mm/s', notes: 'Vibration increased again', recorded_at: t(25),
      ...(schemaHas.logs_text && { log_text: 'Conveyor B vibration increased again. Now at 0.74 mm/s.',
        sensor_snapshot: { temperature: 82, vibration: 0.74, throughput: 88, error_count: 4 }, timestamp: t(25) }),
    },
    {
      shift_id: sid, machine_id: conveyorB?.id,
      event_type: 'operator_report', value: 0.79, unit: 'mm/s', notes: 'Operator reported belt noise', recorded_at: t(15),
      ...(schemaHas.logs_text && { log_text: 'Operator Ava reported unusual belt noise on Conveyor B — light scraping sound.',
        sensor_snapshot: { temperature: 83, vibration: 0.79, throughput: 86, error_count: 5 }, timestamp: t(15) }),
    },
    {
      shift_id: sid, machine_id: conveyorB?.id,
      event_type: 'throughput_drop', value: 84, unit: '%', notes: 'Throughput slightly dropped', recorded_at: t(5),
      ...(schemaHas.logs_text && { log_text: 'Conveyor B throughput dropped slightly — now at 84% of target.',
        sensor_snapshot: { temperature: 84, vibration: 0.82, throughput: 84, error_count: 6 }, timestamp: t(5) }),
    },
  ]);

  // 5. Work order — previous shift noted belt wear (Phase 3 spec)
  await supabase.from('work_orders').insert([
    {
      shift_id:    sid,
      machine_id:  conveyorB?.id,
      description: 'Check Conveyor B belt wear',
      type:        'maintenance',
      priority:    'medium',
      status:      'open',
      assigned_to: 'Leo',
      ...(schemaHas.wo_title && {
        title:      'Check Conveyor B belt wear',
        created_by: 'Previous Shift Lead',
        reason:     'Previous shift noted belt noise and slight misalignment.',
      }),
    },
  ]);

  // 6. Camera event — belt misalignment (Phase 3 spec)
  await supabase.from('camera_events').insert([
    {
      shift_id:    sid,
      zone:        'Line 2 — Conveyor B',
      event_type:  'anomaly',
      description: 'Conveyor B belt area appears slightly misaligned. Worker is close to moving equipment.',
      severity:    'high',
      detected_at: t(18),
      ...(schemaHas.cam_vlm && {
        machine_id:      conveyorB?.id,
        vlm_observation: 'Conveyor B belt edge is tracking off-center by approximately 15mm. A worker is within 0.5m of the moving belt without barrier protection.',
        timestamp:       t(18),
      }),
    },
  ]);

  // 7. Messages — worker reports and supervisor note (Phase 3 spec)
  await supabase.from('messages').insert([
    {
      shift_id:   sid,
      from_agent: 'Ava',
      to_role:    'Supervisor',
      content:    'Conveyor B has been making a light scraping sound since the last cycle.',
      created_at: t(14),
      ...(schemaHas.msg_sender && { sender: 'Ava', recipient: 'Supervisor',
        message: 'Conveyor B has been making a light scraping sound since the last cycle.' }),
    },
    {
      shift_id:   sid,
      from_agent: 'Raj',
      to_role:    'All',
      content:    'Monitor Line 2 closely during this shift.',
      created_at: t(10),
      ...(schemaHas.msg_sender && { sender: 'Raj', recipient: 'All',
        message: 'Monitor Line 2 closely during this shift.' }),
    },
  ]);

  res.json({
    shift_id: sid,
    shift,
    seeded: {
      machines:      3,
      workers:       4,
      machine_logs:  5,
      work_orders:   1,
      camera_events: 1,
      messages:      2,
    },
    message: 'Phase 3 demo shift seeded. Call POST /api/agent/run to start reasoning.',
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3001;
if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`ShiftBrain API running on http://localhost:${PORT}`));
}

export default app;
