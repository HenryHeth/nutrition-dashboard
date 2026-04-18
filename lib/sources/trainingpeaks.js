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

// Sync a window ending on `date` so the daily cron also backfills the prior N-1 days
// (cheap, lets late-arriving data and edits land).
const WINDOW_DAYS = parseInt(process.env.TP_WINDOW_DAYS || '60', 10);

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

  // 2) Consolidated metrics — TP returns rows with nested details[]:
  //    {timeStamp, details: [{type, label, value}]}
  // Type codes (discovered via API inspection):
  //    5=Pulse(RHR), 6=Sleep Hours, 9=Weight (kg), 14=BMI, 25=Shoulders cm,
  //    26=Chest cm, 27=Waist cm, 58=Steps, 60=HRV, 62=Stress[arr], 64=BodyBattery[arr]
  const metricsRaw = await tpGet(
    token,
    `/metrics/v3/athletes/${ATHLETE_ID}/consolidatedtimedmetrics/${ymd(start)}/${ymd(end)}`
  );
  const metrics = Array.isArray(metricsRaw) ? metricsRaw : (metricsRaw.metrics || []);

  // uploadClient → device-friendly label
  // FitnessSyncer is Paul's Fitbit→TP relay; treat as 'fitbit'.
  const labelClient = c => {
    if (!c) return null;
    if (/fitnesssyncer/i.test(c)) return 'fitbit';
    if (/garmin/i.test(c))         return 'garmin';
    return c.toLowerCase();
  };

  // Sleep dedup — combines three signals:
  //   1. Garmin's same-day sleep (anchor — Garmin doesn't capture naps so it's main-only)
  //   2. Record size (≤2 hrs is nap-candidate, paul's note)
  //   3. Timestamp gap (small + far from other records → real nap, not duplicate)
  // Algorithm:
  //   - A record is classified "nap" if value ≤ 2 hrs AND time gap from nearest
  //     other record > 3 hrs (otherwise it's a duplicate fragment of a larger
  //     same-night sleep that Fitbit posted twice).
  //   - Remaining records are "main candidates". If only one, that's the main.
  //     If multiple, pick max-or-sum by which is closer to Garmin's anchor
  //     (covers split-sleep nights where Fitbit splits and Garmin sums).
  //   - Total = main_total + sum(nap values).
  const NAP_HRS = 2.0;
  const NAP_GAP_MIN = 3 * 60;
  const minutesOfDay = t => {
    if (!t) return 0;
    const d = new Date(t);
    return isNaN(d) ? 0 : d.getHours() * 60 + d.getMinutes();
  };
  const dedupFitbitSleep = (recs, garminHrs) => {
    if (!recs?.length) return null;
    if (recs.length === 1) return recs[0].value;
    const naps = [], mains = [];
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (r.value <= NAP_HRS) {
        const tNow = minutesOfDay(r.time);
        const minGap = Math.min(
          ...recs.filter((_, j) => j !== i).map(o => Math.abs(minutesOfDay(o.time) - tNow))
        );
        if (minGap > NAP_GAP_MIN) {
          naps.push(r.value);
          continue;
        }
      }
      mains.push(r.value);
    }
    let mainTotal = 0;
    if (mains.length === 1) {
      mainTotal = mains[0];
    } else if (mains.length > 1) {
      if (garminHrs == null) {
        mainTotal = Math.max(...mains);
      } else {
        const sumM = mains.reduce((a,b) => a+b, 0);
        const maxM = Math.max(...mains);
        mainTotal = Math.abs(sumM - garminHrs) < Math.abs(maxM - garminHrs) ? sumM : maxM;
      }
    }
    return mainTotal + naps.reduce((a,b) => a+b, 0);
  };

  for (const m of metrics) {
    const day = (m.timeStamp || m.date || '').slice(0, 10);
    if (!day) continue;

    // Bucket by (type, client) — keep records as {value, time} objects so we can
    // use timestamps for sleep dedup.
    const recsByTypeClient = {}; // type -> { client -> [{value, time}, ...] }
    const firstByType = {};       // type -> first non-null (for arrays / non-summable)
    for (const d of (m.details || [])) {
      if (d.value == null || Array.isArray(d.value)) {
        if (firstByType[d.type] === undefined) firstByType[d.type] = d.value;
        continue;
      }
      const c = labelClient(d.uploadClient) || 'unknown';
      recsByTypeClient[d.type] ||= {};
      recsByTypeClient[d.type][c] ||= [];
      recsByTypeClient[d.type][c].push({ value: d.value, time: d.time });
      if (firstByType[d.type] === undefined) firstByType[d.type] = d.value;
    }

    // Per-metric: aggregate within client bucket (using passed agg fn), then pick
    // preferred client (Fitbit > Garmin > anything else).
    const pickWith = (type, agg) => {
      const buckets = recsByTypeClient[type];
      if (!buckets) return [null, null];
      const order = ['fitbit', 'garmin'];
      for (const c of order) {
        if (buckets[c]) return [agg(buckets[c], c), c];
      }
      const k = Object.keys(buckets)[0];
      return [agg(buckets[k], k), k];
    };
    const sumAgg     = recs => recs.reduce((s, r) => s + r.value, 0);
    // For daily aggregates (HRV, RHR, weight, steps, etc.) multiple records
    // for the same metric on the same day are duplicates from different sync
    // events — take the AVG, never sum (sum produced 2× weight values).
    const avgAgg     = recs => recs.reduce((s, r) => s + r.value, 0) / recs.length;
    const pickPreferred = type => pickWith(type, avgAgg);

    // Garmin's sleep value for this day (used as anchor for Fitbit dedup)
    const garminSleepHrs = (() => {
      const g = recsByTypeClient[6]?.garmin;
      if (!g?.length) return null;
      return Math.max(...g.map(r => r.value));
    })();

    // Stress / BodyBattery still come back as arrays — pull the average-ish value (last element)
    const arrAvg = v => Array.isArray(v) ? (v[v.length - 1] ?? null) : v;

    // Sleep gets a special aggregator: for Fitbit use the dedup heuristic with
    // Garmin as anchor; for any other client use the simple sum.
    const sleepAgg = (recs, client) =>
      client === 'fitbit' ? dedupFitbitSleep(recs, garminSleepHrs) : sumAgg(recs);
    const [sleep_hours, sleep_source] = pickWith(6, sleepAgg);
    const [hrv]          = pickPreferred(60);
    const [resting_hr]   = pickPreferred(5);
    const [steps]        = pickPreferred(58);
    const body_battery   = arrAvg(firstByType[64]);
    const stress_score   = arrAvg(firstByType[62]);

    // NOTE: TP no longer writes sleep_hours/sleep_source/sleep_score —
    // sleep is Fitbit-direct only. If Fitbit OAuth fails the day stays NULL
    // (visible gap on the chart) rather than mixing data from multiple sources.
    if ([hrv, resting_hr, steps, body_battery, stress_score].some(v => v != null)) {
      await pool.query(
        `INSERT INTO daily_metrics
         (date, hrv_ms, resting_hr, steps, body_battery, stress_score, source, raw, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'trainingpeaks',$7,NOW())
         ON CONFLICT (date) DO UPDATE SET
           hrv_ms       = COALESCE(EXCLUDED.hrv_ms,       daily_metrics.hrv_ms),
           resting_hr   = COALESCE(EXCLUDED.resting_hr,   daily_metrics.resting_hr),
           steps        = COALESCE(EXCLUDED.steps,        daily_metrics.steps),
           body_battery = COALESCE(EXCLUDED.body_battery, daily_metrics.body_battery),
           stress_score = COALESCE(EXCLUDED.stress_score, daily_metrics.stress_score),
           updated_at   = NOW()`,
        [day, hrv, resting_hr,
         steps != null ? Math.round(steps) : null,
         body_battery != null ? Math.round(body_battery) : null,
         stress_score != null ? Math.round(stress_score) : null,
         m]
      );
      rowsWritten++;
    }
    // Suppress lint warning — sleep_hours/sleep_source intentionally unused now
    void sleep_hours; void sleep_source;

    const [weight_kg]    = pickPreferred(9);
    const waist_cm     = firstByType[27] ?? null;
    const chest_cm     = firstByType[26] ?? null;
    const shoulders_cm = firstByType[25] ?? null;
    if ([weight_kg, waist_cm, chest_cm, shoulders_cm].some(v => v != null)) {
      await pool.query(
        `INSERT INTO body_composition
         (date, weight_kg, waist_cm, chest_cm, shoulders_cm, source, raw)
         VALUES ($1,$2,$3,$4,$5,'trainingpeaks',$6)
         ON CONFLICT (date, source) DO UPDATE SET
           weight_kg    = COALESCE(EXCLUDED.weight_kg,    body_composition.weight_kg),
           waist_cm     = COALESCE(EXCLUDED.waist_cm,     body_composition.waist_cm),
           chest_cm     = COALESCE(EXCLUDED.chest_cm,     body_composition.chest_cm),
           shoulders_cm = COALESCE(EXCLUDED.shoulders_cm, body_composition.shoulders_cm)`,
        [day, weight_kg, waist_cm, chest_cm, shoulders_cm, m]
      );
      rowsWritten++;

      // Mirror weight to legacy `weight` table so /api/weight stays fresh
      if (weight_kg != null) {
        await pool.query(
          `INSERT INTO weight (date, weight_kg, source) VALUES ($1, $2, 'trainingpeaks')
           ON CONFLICT (date, source) DO UPDATE SET weight_kg = EXCLUDED.weight_kg`,
          [day, weight_kg]
        );
        rowsWritten++;
      }
    }
  }

  return rowsWritten;
}

module.exports = { syncDay, ATHLETE_ID };
