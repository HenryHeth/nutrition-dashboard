// TrainingPeaks source — Node port of the working Python scraper in
// /workspace-matthew/get_tp_full.py + get_weight_sleep equivalents.
//
// Auth model: cookie → access token via /users/v3/token, then Bearer-auth API calls.
// Cookies expire — when 401 starts coming back, refresh TP_COOKIE in Vercel env vars.
//
// Required env vars: TP_COOKIE, TP_ATHLETE_ID (defaults to 422351 from Matthew's notes).

const { pool } = require('../db');

const BASE = 'https://tpapi.trainingpeaks.com';
const ATHLETE_ID = process.env.TP_ATHLETE_ID || '422351';

async function getAccessToken() {
  if (!process.env.TP_COOKIE) throw new Error('TP_COOKIE env var not set');
  const res = await fetch(`${BASE}/users/v3/token`, {
    headers: {
      'Cookie': `Production_tpAuth=${process.env.TP_COOKIE}`,
      'Accept': 'application/json'
    }
  });
  if (!res.ok) throw new Error(`TP token exchange failed: ${res.status} (cookie likely expired)`);
  const j = await res.json();
  const token = j.token?.access_token;
  if (!token) throw new Error('TP token response missing access_token');
  return token;
}

async function tpGet(token, path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`TP GET ${path} → ${res.status}`);
  return res.json();
}

async function tpPost(token, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`TP POST ${path} → ${res.status}`);
  return res.json();
}

// Sync a window ending on `date` so the daily cron also backfills the prior 6 days
// (cheap, lets late-arriving data and edits land).
const WINDOW_DAYS = 7;

function ymd(d) { return d.toISOString().split('T')[0]; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

async function syncDay(date) {
  const token = await getAccessToken();
  const end = new Date(date);
  const start = addDays(end, -WINDOW_DAYS);

  // 1) PMC fitness load (CTL/ATL/TSB)
  const fitnessRaw = await tpPost(
    token,
    `/fitness/v1/athletes/${ATHLETE_ID}/reporting/performancedata/${ymd(start)}/${ymd(end)}`,
    { atlConstant: 7, atlStart: 0, ctlConstant: 42, ctlStart: 0, workoutTypes: [] }
  );

  let rowsWritten = 0;
  if (Array.isArray(fitnessRaw)) {
    for (const e of fitnessRaw) {
      const day = (e.workoutDay || '').slice(0, 10);
      if (!day) continue;
      await pool.query(
        `INSERT INTO fitness_load (date, ctl, atl, tsb)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (date) DO UPDATE SET ctl=EXCLUDED.ctl, atl=EXCLUDED.atl, tsb=EXCLUDED.tsb`,
        [day, +e.ctl || 0, +e.atl || 0, +e.tsb || 0]
      );
      rowsWritten++;
    }
  }

  // 2) Consolidated metrics — sleep, HRV, RHR, weight, body measurements
  const metricsRaw = await tpGet(
    token,
    `/metrics/v3/athletes/${ATHLETE_ID}/consolidatedtimedmetrics/${ymd(start)}/${ymd(end)}`
  );

  // Response shape varies — handle both flat array and {metrics:[...]}
  const metrics = Array.isArray(metricsRaw) ? metricsRaw : (metricsRaw.metrics || []);
  for (const m of metrics) {
    const day = (m.timeStamp || m.date || '').slice(0, 10);
    if (!day) continue;

    // daily_metrics: sleep / HRV / RHR (TP exposes these as nested fields — varies by athlete config)
    const sleep_hours = m.sleepHours ?? m.sleep ?? null;
    const hrv = m.hrv ?? null;
    const resting_hr = m.restingHeartRate ?? m.restingHr ?? null;
    if (sleep_hours != null || hrv != null || resting_hr != null) {
      await pool.query(
        `INSERT INTO daily_metrics (date, sleep_hours, hrv_ms, resting_hr, source, raw, updated_at)
         VALUES ($1, $2, $3, $4, 'trainingpeaks', $5, NOW())
         ON CONFLICT (date) DO UPDATE SET
           sleep_hours = COALESCE(EXCLUDED.sleep_hours, daily_metrics.sleep_hours),
           hrv_ms      = COALESCE(EXCLUDED.hrv_ms,      daily_metrics.hrv_ms),
           resting_hr  = COALESCE(EXCLUDED.resting_hr,  daily_metrics.resting_hr),
           updated_at  = NOW()`,
        [day, sleep_hours, hrv, resting_hr, m]
      );
      rowsWritten++;
    }

    // body_composition: weight + measurements
    const weight_kg = m.weight ?? null;
    const body_fat_pct = m.bodyFat ?? null;
    const waist_cm = m.waist ?? null;
    const chest_cm = m.chest ?? null;
    const shoulders_cm = m.shoulders ?? null;
    if (weight_kg != null || body_fat_pct != null || waist_cm != null) {
      await pool.query(
        `INSERT INTO body_composition (date, weight_kg, body_fat_pct, waist_cm, chest_cm, shoulders_cm, source, raw)
         VALUES ($1, $2, $3, $4, $5, $6, 'trainingpeaks', $7)
         ON CONFLICT (date, source) DO UPDATE SET
           weight_kg    = COALESCE(EXCLUDED.weight_kg,    body_composition.weight_kg),
           body_fat_pct = COALESCE(EXCLUDED.body_fat_pct, body_composition.body_fat_pct),
           waist_cm     = COALESCE(EXCLUDED.waist_cm,     body_composition.waist_cm),
           chest_cm     = COALESCE(EXCLUDED.chest_cm,     body_composition.chest_cm),
           shoulders_cm = COALESCE(EXCLUDED.shoulders_cm, body_composition.shoulders_cm)`,
        [day, weight_kg, body_fat_pct, waist_cm, chest_cm, shoulders_cm, m]
      );
      rowsWritten++;
    }
  }

  return rowsWritten;
}

module.exports = { syncDay, ATHLETE_ID };
