const { pool } = require('../../lib/db');
const trainingpeaks = require('../../lib/sources/trainingpeaks');
const garmin = require('../../lib/sources/garmin');
const fatsecret = require('../../lib/sources/fatsecret');
const signalcheck = require('../../lib/sources/signalcheck');
const fitbit = require('../../lib/sources/fitbit');

// Vercel Cron: hits this endpoint daily per vercel.json schedule.
// Vercel sets `Authorization: Bearer ${CRON_SECRET}` automatically.

// Order matters for sleep precedence:
//   fitbit (direct) → trainingpeaks (FitnessSyncer-via-TP) → garmin
// Each later source uses COALESCE so it doesn't overwrite an earlier-set
// sleep_source; Garmin's CASE statement explicitly skips when sleep_source='fitbit'.
const SOURCES = [
  ['fitbit',        fitbit.syncDay],
  ['trainingpeaks', trainingpeaks.syncDay],
  ['garmin',        garmin.syncDay],
  ['fatsecret',     fatsecret.syncDay],
  ['signalcheck',   signalcheck.syncDay]
];

async function recordRun(source, status, rowsWritten, error) {
  await pool.query(
    `INSERT INTO pipeline_runs (source, finished_at, status, rows_written, error)
     VALUES ($1, NOW(), $2, $3, $4)`,
    [source, status, rowsWritten, error]
  );
}

module.exports = async (req, res) => {
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // Sync yesterday by default (full day's data is settled by 6am next morning).
  const date = req.query.date || new Date(Date.now() - 86400000).toISOString().split('T')[0];

  const results = {};
  for (const [name, syncFn] of SOURCES) {
    try {
      const rows = await syncFn(date);
      results[name] = { status: 'ok', rows };
      await recordRun(name, 'ok', rows, null);
    } catch (e) {
      results[name] = { status: 'error', error: e.message };
      await recordRun(name, 'error', 0, e.message);
    }
  }

  return res.status(200).json({ date, results });
};
