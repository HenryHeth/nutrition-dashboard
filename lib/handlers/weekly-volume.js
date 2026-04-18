// /api/weekly-volume?from=YYYY-MM-DD&to=YYYY-MM-DD
// Weekly aggregated lifting volume per category — drives spec §4f progressive-overload bars.
// Volume = SUM(COALESCE(es.standard_lbs, ws.weight_lbs) * reps), grouped by ISO week + category.

const { pool } = require('../lib/db');
const crypto = require('crypto');

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
  const range = from && to ? 'AND s.date BETWEEN $1 AND $2' : '';
  const params = from && to ? [from, to] : [];

  try {
    const rows = await safeQuery(
      `SELECT date_trunc('week', s.date)::date AS week_start,
              ws.category,
              ROUND(SUM(COALESCE(es.standard_lbs, ws.weight_lbs) * ws.reps)::numeric, 0) AS volume_lbs
       FROM workout_sets ws
       JOIN workout_sessions s ON s.id = ws.session_id
       LEFT JOIN exercise_standards es ON es.exercise = ws.exercise
       WHERE ws.reps IS NOT NULL ${range}
       GROUP BY week_start, ws.category
       ORDER BY week_start`,
      params
    );

    const fmt = d => (d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0]);
    const byWeek = {};
    for (const r of rows) {
      const w = fmt(r.week_start);
      byWeek[w] ||= { week_start: w, upper_push: 0, upper_pull: 0, lower: 0, core: 0, other: 0, total: 0 };
      const cat = r.category || 'other';
      const v = +r.volume_lbs || 0;
      byWeek[w][cat] = (byWeek[w][cat] || 0) + v;
      byWeek[w].total += v;
    }

    const data = Object.keys(byWeek).sort().map(w => byWeek[w]);
    return res.status(200).json({ success: true, count: data.length, data });
  } catch (e) {
    console.error('weekly-volume error:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
};
