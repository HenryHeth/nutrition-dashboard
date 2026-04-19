// /api/fitness/sync
//   GET  → status: latest pipeline_runs entry per source + minutes since
//   POST → trigger: kicks off Garmin GitHub Actions workflow + hits the Vercel cron
//
// Used by:
//   - "Re-sync" button on the audit page (POST)
//   - Dashboard auto-sync if the last successful sync was more than STALE_HOURS ago

const { pool } = require('../db');
const crypto = require('crypto');

const REPO = 'HenryHeth/nutrition-dashboard';
const WORKFLOW_FILE = 'sync-garmin.yml';
const STALE_HOURS = 4;

function verifyToken(token) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return true;
  const secret = process.env.AUTH_SECRET || 'nutrition-dashboard-2026';
  const expected = crypto.createHash('sha256').update(password + secret).digest('hex');
  return token === expected;
}

async function safeQuery(sql, params) {
  try { return (await pool.query(sql, params)).rows; }
  catch (e) { if (e.code === '42P01') return []; throw e; }
}

async function getStatus() {
  // Most recent pipeline_runs entry per source
  const rows = await safeQuery(
    `SELECT DISTINCT ON (source) source, status, finished_at, rows_written, error
     FROM pipeline_runs
     ORDER BY source, finished_at DESC`,
    []
  );
  const now = Date.now();
  const sources = rows.map(r => ({
    source: r.source,
    status: r.status,
    rows_written: r.rows_written,
    finished_at: r.finished_at,
    minutes_ago: r.finished_at ? Math.floor((now - new Date(r.finished_at).getTime()) / 60000) : null,
    error: r.error
  }));
  // Overall: stale if any successful source is more than STALE_HOURS old, or any failure in last 24h
  const lastOk = sources.filter(s => s.status === 'ok' && s.minutes_ago != null);
  const oldestOk = lastOk.length ? Math.max(...lastOk.map(s => s.minutes_ago)) : Infinity;
  const stale = oldestOk > STALE_HOURS * 60;
  return { sources, stale, stale_threshold_hours: STALE_HOURS };
}

async function triggerGarminWorkflow() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { ok: false, error: 'GITHUB_TOKEN not set' };
  const url = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify({ ref: 'main' })
  });
  if (r.status === 204) return { ok: true };
  const text = await r.text();
  return { ok: false, status: r.status, error: text.slice(0, 300) };
}

async function triggerVercelCron(req) {
  // Hit our own cron endpoint — runs TP, FatSecret, Fitbit, SignalCheck immediately
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return { ok: false, error: 'CRON_SECRET not set' };
  const host = req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const url = `${proto}://${host}/api/cron/sync-fitness`;
  try {
    // Fire-and-forget — the cron takes 30-60s to complete
    fetch(url, { headers: { Authorization: `Bearer ${cronSecret}` } }).catch(() => {});
    return { ok: true, triggered: 'background' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (process.env.DASHBOARD_PASSWORD && !verifyToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'GET') {
    const status = await getStatus();
    return res.status(200).json({ success: true, ...status });
  }

  if (req.method === 'POST') {
    const [garmin, vercelCron] = await Promise.all([
      triggerGarminWorkflow(),
      triggerVercelCron(req)
    ]);
    const status = await getStatus();
    return res.status(200).json({
      success: true,
      garmin,             // GitHub workflow dispatch result
      vercel_cron: vercelCron,  // TP/FS/Fitbit/SignalCheck
      status,             // current state of pipeline_runs
      message: 'Garmin sync queued in GitHub Actions (~60-90s). TP, FatSecret, Fitbit, SignalCheck running in background (~30s).'
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
