const { pool } = require('../db');

// TODO(creds): TP_COOKIE env var = full Cookie header from a logged-in browser session.
// TP cookies expire — when this 401s, refresh manually from Bitwarden → Vercel env vars.
// Athlete ID 422351.

const ATHLETE_ID = '422351';

async function fetchDailyMetrics(date) {
  // TODO: implement TP API calls for sleep / HRV / RHR / steps / body battery / stress.
  // Endpoint shape to confirm — TP cookie auth, JSON response.
  throw new Error('trainingpeaks.fetchDailyMetrics not yet implemented');
}

async function fetchFitnessLoad(date) {
  // TODO: PMC values (CTL/ATL/TSB) for the date.
  throw new Error('trainingpeaks.fetchFitnessLoad not yet implemented');
}

async function fetchBodyComposition(date) {
  // TODO: weight + waist/chest/shoulders measurements.
  throw new Error('trainingpeaks.fetchBodyComposition not yet implemented');
}

async function syncDay(date) {
  const [metrics, load, body] = await Promise.allSettled([
    fetchDailyMetrics(date),
    fetchFitnessLoad(date),
    fetchBodyComposition(date)
  ]);

  let rowsWritten = 0;

  if (metrics.status === 'fulfilled' && metrics.value) {
    const m = metrics.value;
    await pool.query(
      `INSERT INTO daily_metrics (date, sleep_hours, sleep_score, hrv_ms, resting_hr, steps, body_battery, stress_score, source, raw, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'trainingpeaks',$9,NOW())
       ON CONFLICT (date) DO UPDATE SET
         sleep_hours = EXCLUDED.sleep_hours,
         sleep_score = EXCLUDED.sleep_score,
         hrv_ms = EXCLUDED.hrv_ms,
         resting_hr = EXCLUDED.resting_hr,
         steps = EXCLUDED.steps,
         body_battery = EXCLUDED.body_battery,
         stress_score = EXCLUDED.stress_score,
         raw = EXCLUDED.raw,
         updated_at = NOW()`,
      [date, m.sleep_hours, m.sleep_score, m.hrv_ms, m.resting_hr, m.steps, m.body_battery, m.stress_score, m.raw || null]
    );
    rowsWritten++;
  }

  if (load.status === 'fulfilled' && load.value) {
    const l = load.value;
    await pool.query(
      `INSERT INTO fitness_load (date, ctl, atl, tsb)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (date) DO UPDATE SET ctl=EXCLUDED.ctl, atl=EXCLUDED.atl, tsb=EXCLUDED.tsb`,
      [date, l.ctl, l.atl, l.tsb]
    );
    rowsWritten++;
  }

  if (body.status === 'fulfilled' && body.value) {
    const b = body.value;
    await pool.query(
      `INSERT INTO body_composition (date, weight_kg, body_fat_pct, lean_mass_lbs, waist_cm, chest_cm, shoulders_cm, source, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'trainingpeaks',$8)
       ON CONFLICT (date, source) DO NOTHING`,
      [date, b.weight_kg, b.body_fat_pct, b.lean_mass_lbs, b.waist_cm, b.chest_cm, b.shoulders_cm, b.raw || null]
    );
    rowsWritten++;
  }

  return rowsWritten;
}

module.exports = { syncDay, ATHLETE_ID };
