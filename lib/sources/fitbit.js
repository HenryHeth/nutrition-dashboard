// Fitbit direct sleep source — pulls Fitbit's own canonical sleep data via
// the Fitbit Web API. Replaces FitnessSyncer-via-TP as the primary sleep
// source, since Fitbit's `summary.totalMinutesAsleep` is the authoritative
// aggregation and naps come pre-flagged in `sleep[]`.
//
// Auth: OAuth 2.0 with refresh token stored in oauth_tokens table.
// Set up once via Paul visiting /api/fitbit/authorize in browser.

const { pool } = require('../db');

const CLIENT_ID     = process.env.FITBIT_CLIENT_ID;
const CLIENT_SECRET = process.env.FITBIT_CLIENT_SECRET;
const WINDOW_DAYS   = parseInt(process.env.FITBIT_WINDOW_DAYS || '60', 10);

async function getAccessToken() {
  const r = await pool.query(
    `SELECT access_token, refresh_token, expires_at FROM oauth_tokens WHERE provider='fitbit'`
  );
  if (r.rowCount === 0) throw new Error('Fitbit not connected — visit /api/fitbit/authorize first');

  const { access_token, refresh_token, expires_at } = r.rows[0];
  // Refresh if expired or expires within 5 minutes
  if (new Date(expires_at).getTime() - Date.now() > 5 * 60 * 1000) return access_token;

  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://api.fitbit.com/oauth2/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token })
  });
  if (!res.ok) throw new Error(`Fitbit token refresh failed: ${res.status} ${await res.text()}`);
  const tok = await res.json();
  await pool.query(
    `UPDATE oauth_tokens SET access_token=$1, refresh_token=$2,
      expires_at = NOW() + ($3 || ' seconds')::interval, updated_at=NOW()
     WHERE provider='fitbit'`,
    [tok.access_token, tok.refresh_token, String(tok.expires_in || 28800)]
  );
  return tok.access_token;
}

async function fetchSleep(token, dateStr) {
  const r = await fetch(`https://api.fitbit.com/1.2/user/-/sleep/date/${dateStr}.json`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (r.status === 429) throw new Error('Fitbit rate-limited');
  if (!r.ok) {
    if (r.status === 404) return null;
    throw new Error(`Fitbit /sleep/${dateStr} → ${r.status}`);
  }
  return r.json();
}

function ymd(d) { return d.toISOString().slice(0, 10); }

async function syncDay(date) {
  const token = await getAccessToken();

  const end = new Date(date + 'T00:00:00Z');
  let rowsWritten = 0;

  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const day = ymd(d);

    let payload;
    try {
      payload = await fetchSleep(token, day);
    } catch (e) {
      console.error(`fitbit ${day} fetch error: ${e.message}`);
      continue;
    }
    if (!payload) continue;

    // summary.totalMinutesAsleep is Fitbit's own authoritative aggregate
    // (handles naps + dedup internally).
    const summary = payload.summary || {};
    const sleepHours = summary.totalMinutesAsleep ? +(summary.totalMinutesAsleep / 60).toFixed(2) : null;
    const sleepScore = summary.efficiency ?? null;
    if (sleepHours == null) continue;

    await pool.query(
      `INSERT INTO daily_metrics (date, sleep_hours, sleep_score, sleep_source, source, raw, updated_at)
       VALUES ($1, $2, $3, 'fitbit', 'fitbit', $4, NOW())
       ON CONFLICT (date) DO UPDATE SET
         sleep_hours  = EXCLUDED.sleep_hours,
         sleep_score  = EXCLUDED.sleep_score,
         sleep_source = 'fitbit',
         raw          = EXCLUDED.raw,
         updated_at   = NOW()`,
      [day, sleepHours, sleepScore, payload]
    );
    rowsWritten++;
  }

  return rowsWritten;
}

module.exports = { syncDay };
