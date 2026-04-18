// /api/overlays?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns one merged time series for the main chart's optional overlays:
//   sleep_hours, ctl, atl, tsb, restedness_am, doms_am
// Used by the macros chart line overlays per spec §4b.
// Tables read: daily_metrics, fitness_load, health_checkins.
// All optional — missing tables/rows return null for that metric/day.

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
    const r = await pool.query(sql, params);
    return r.rows;
  } catch (e) {
    // Table-doesn't-exist (42P01) is expected pre-migration. Return empty.
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
  const range = from && to ? 'WHERE date >= $1 AND date <= $2' : '';
  const params = from && to ? [from, to] : [];

  try {
    const [metrics, load, checkins] = await Promise.all([
      safeQuery(`SELECT date, sleep_hours FROM daily_metrics ${range} ORDER BY date`, params),
      safeQuery(`SELECT date, ctl, atl, tsb FROM fitness_load ${range} ORDER BY date`, params),
      safeQuery(
        `SELECT date,
                AVG(CASE WHEN period = 'AM' THEN restedness END) AS restedness_am,
                AVG(CASE WHEN period = 'AM' THEN doms END) AS doms_am
         FROM health_checkins ${range}
         GROUP BY date
         ORDER BY date`,
        params
      )
    ]);

    // Merge by date
    const byDate = {};
    const fmt = d => (d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0]);
    for (const r of metrics)  (byDate[fmt(r.date)] ||= {}).sleep_hours = r.sleep_hours != null ? +r.sleep_hours : null;
    for (const r of load) {
      const k = fmt(r.date); byDate[k] ||= {};
      byDate[k].ctl = r.ctl != null ? +r.ctl : null;
      byDate[k].atl = r.atl != null ? +r.atl : null;
      byDate[k].tsb = r.tsb != null ? +r.tsb : null;
    }
    for (const r of checkins) {
      const k = fmt(r.date); byDate[k] ||= {};
      byDate[k].restedness_am = r.restedness_am != null ? +r.restedness_am : null;
      byDate[k].doms_am = r.doms_am != null ? +r.doms_am : null;
    }

    const data = Object.keys(byDate).sort().map(date => ({ date, ...byDate[date] }));
    return res.status(200).json({ success: true, count: data.length, data });
  } catch (e) {
    console.error('overlays error:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
};
