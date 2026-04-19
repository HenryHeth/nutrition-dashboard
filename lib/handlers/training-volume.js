// /api/training-volume?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns daily training volume (lbs lifted) joined with AM DOMS — drives spec §4c chart.
// Volume = SUM(COALESCE(exercise_standards.standard_lbs, workout_sets.weight_lbs) * reps)
// Standards layer is non-destructive (raw weight_lbs untouched).

const { pool } = require('../db');
const crypto = require('crypto');

function verifyToken(token) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return true;
  const secret = process.env.AUTH_SECRET || 'nutrition-dashboard-2026';
  const expected = crypto.createHash('sha256').update(password + secret).digest('hex');
  return token === expected;
}

async function safeQuery(sql, params) {
  try {
    return (await pool.query(sql, params)).rows;
  } catch (e) {
    if (e.code === '42P01') return [];
    throw e;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (process.env.DASHBOARD_PASSWORD && !verifyToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { from, to } = req.query;
  const range = from && to ? 'AND ws.date BETWEEN $1 AND $2' : '';
  const checkinRange = from && to ? 'WHERE date BETWEEN $1 AND $2' : '';
  const params = from && to ? [from, to] : [];

  try {
    const [volumeRows, domsRows, sleepRows] = await Promise.all([
      safeQuery(
        `SELECT s.date,
                ROUND(SUM(COALESCE(es.standard_lbs, ws.weight_lbs) * ws.reps)::numeric, 0) AS volume_lbs
         FROM workout_sets ws
         JOIN workout_sessions s ON s.id = ws.session_id
         LEFT JOIN exercise_standards es ON es.exercise = ws.exercise
         WHERE ws.reps IS NOT NULL ${range.replace('ws.date', 's.date')}
         GROUP BY s.date
         ORDER BY s.date`,
        params
      ),
      safeQuery(
        `SELECT date, AVG(CASE WHEN period = 'AM' THEN doms END) AS doms_am
         FROM health_checkins
         ${checkinRange}
         GROUP BY date
         ORDER BY date`,
        params
      ),
      safeQuery(
        `SELECT date, sleep_hours, sleep_source FROM daily_metrics
         ${checkinRange}
         ORDER BY date`,
        params
      )
    ]);

    const fmt = d => (d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0]);
    const byDate = {};
    for (const r of volumeRows) (byDate[fmt(r.date)] ||= {}).volume_lbs = r.volume_lbs != null ? +r.volume_lbs : 0;
    for (const r of domsRows)   (byDate[fmt(r.date)] ||= {}).doms_am    = r.doms_am != null ? +r.doms_am : null;
    for (const r of sleepRows) {
      const k = fmt(r.date); byDate[k] ||= {};
      byDate[k].sleep_hours  = r.sleep_hours  != null ? +r.sleep_hours : null;
      byDate[k].sleep_source = r.sleep_source ?? null;
    }

    const data = Object.keys(byDate).sort().map(date => ({
      date,
      volume_lbs:   byDate[date].volume_lbs   ?? 0,
      doms_am:      byDate[date].doms_am      ?? null,
      sleep_hours:  byDate[date].sleep_hours  ?? null,
      sleep_source: byDate[date].sleep_source ?? null
    }));

    // Quick missing-weight count for the dashboard's proactive indicator.
    // Scoped to the same date range as the chart.
    const missingRow = await safeQuery(
      `SELECT COUNT(*)::int AS missing
       FROM workout_sets ws
       JOIN workout_sessions s ON s.id = ws.session_id
       WHERE ws.exercise IS NOT NULL
         AND (ws.weight_lbs IS NULL OR ws.weight_lbs = 0)
         ${range.replace('ws.date', 's.date')}`,
      params
    );
    const missing_weight_sets = missingRow[0]?.missing || 0;

    return res.status(200).json({ success: true, count: data.length, data, missing_weight_sets });
  } catch (e) {
    console.error('training-volume error:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
};
