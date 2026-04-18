// FatSecret nutrition source — pulls Paul's diary into the existing
// `food_entries` and `daily_nutrition` tables. Replaces the dormant MFP pipeline.
//
// OAuth 1.0 (HMAC-SHA1) — 3-legged session token; doesn't expire.
// Required env vars:
//   FATSECRET_CONSUMER_KEY, FATSECRET_CONSUMER_SECRET,
//   FATSECRET_SESSION_TOKEN, FATSECRET_SESSION_SECRET
//
// Reference: workspace-matthew/get_nutrition_summary.py (working Python impl).

const crypto = require('crypto');
const { pool } = require('../db');

const API_URL = 'https://platform.fatsecret.com/rest/server.api';

// FatSecret uses "days since 1970-01-01" as the date integer.
function dateToEpochDays(d) {
  const epoch = Date.UTC(1970, 0, 1);
  const target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.floor((target - epoch) / 86400000);
}

function pctEncode(s) {
  return encodeURIComponent(s)
    .replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function sign(method, url, params, consumerSecret, tokenSecret) {
  const sorted = Object.keys(params).sort()
    .map(k => `${pctEncode(k)}=${pctEncode(String(params[k]))}`)
    .join('&');
  const baseString = `${method}&${pctEncode(url)}&${pctEncode(sorted)}`;
  const signingKey = `${pctEncode(consumerSecret)}&${pctEncode(tokenSecret)}`;
  return crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
}

async function fsCall(method, extraParams = {}) {
  const ck = process.env.FATSECRET_CONSUMER_KEY;
  const cs = process.env.FATSECRET_CONSUMER_SECRET;
  const tok = process.env.FATSECRET_SESSION_TOKEN;
  const tsec = process.env.FATSECRET_SESSION_SECRET;
  if (!ck || !cs || !tok || !tsec) throw new Error('FATSECRET_* env vars not set');

  const params = {
    ...extraParams,
    method,
    format: 'json',
    oauth_consumer_key: ck,
    oauth_token: tok,
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_nonce: String(Math.floor(Math.random() * 9_000_000) + 1_000_000),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_version: '1.0'
  };
  params.oauth_signature = sign('POST', API_URL, params, cs, tsec);

  const body = new URLSearchParams(params).toString();
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) throw new Error(`FatSecret ${method} → ${res.status}`);
  return res.json();
}

function num(v) { return v == null || v === '' ? 0 : +v; }

async function syncDay(date) {
  // `date` is the orchestrator's "anchor" — backfill a 60-day rolling window by default.
  // FATSECRET_BACKFILL_DAYS env override lets us catch up larger gaps.
  const windowDays = parseInt(process.env.FATSECRET_BACKFILL_DAYS || '60', 10);

  let rowsWritten = 0;
  const end = new Date(date + 'T00:00:00Z');
  const days = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d);
  }

  for (const d of days) {
    const dayStr = d.toISOString().slice(0, 10);
    const dayInt = dateToEpochDays(d);

    let payload;
    try {
      payload = await fsCall('food_entries.get', { date: String(dayInt) });
    } catch (e) {
      // Skip the day rather than fail the whole window
      console.error(`FS ${dayStr} fetch error:`, e.message);
      continue;
    }

    let entries = payload?.food_entries?.food_entry;
    if (!entries) continue;
    if (!Array.isArray(entries)) entries = [entries];

    // Replace-the-day pattern for idempotency
    await pool.query('DELETE FROM food_entries WHERE date = $1', [dayStr]);
    let dayCal = 0, dayProt = 0, dayCarb = 0, dayFat = 0, dayFib = 0, daySug = 0, daySod = 0;
    for (const e of entries) {
      const cal  = num(e.calories);
      const prot = num(e.protein);
      const carb = num(e.carbohydrate);
      const fat  = num(e.fat);
      const fib  = num(e.fiber);
      const sug  = num(e.sugar);
      const sod  = num(e.sodium);
      dayCal += cal; dayProt += prot; dayCarb += carb;
      dayFat += fat; dayFib += fib;  daySug += sug;  daySod += sod;

      await pool.query(
        `INSERT INTO food_entries (date, meal, food_name, quantity, unit,
                                   calories, protein_g, carbs_g, fat_g)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          dayStr,
          e.meal || null,
          e.food_entry_name || e.food_name || null,
          num(e.number_of_units),
          e.metric_serving_unit || e.serving_size || null,
          Math.round(cal), prot, carb, fat
        ]
      );
      rowsWritten++;
    }

    await pool.query(
      `INSERT INTO daily_nutrition (date, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (date) DO UPDATE SET
         calories  = EXCLUDED.calories,
         protein_g = EXCLUDED.protein_g,
         carbs_g   = EXCLUDED.carbs_g,
         fat_g     = EXCLUDED.fat_g,
         fiber_g   = EXCLUDED.fiber_g,
         sugar_g   = EXCLUDED.sugar_g,
         sodium_mg = EXCLUDED.sodium_mg`,
      [dayStr, Math.round(dayCal), dayProt, dayCarb, dayFat, dayFib, daySug, Math.round(daySod)]
    );
    rowsWritten++;
  }

  return rowsWritten;
}

module.exports = { syncDay };
