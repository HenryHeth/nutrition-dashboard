// /api/checkins?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns SignalCheck health_checkins as per-day AM/PM time series for all metrics,
// joined with daily_metrics.sleep_score (for the Restedness-vs-Sleep dual chart, spec §4d).

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

const METRICS = ['restedness', 'doms', 'mood', 'hunger', 'back_stiffness', 'general_health'];

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
  const checkinRange = from && to ? 'WHERE date BETWEEN $1 AND $2' : '';
  const metricsRange = from && to ? 'WHERE date BETWEEN $1 AND $2' : '';
  const params = from && to ? [from, to] : [];

  // Pivot AM/PM into separate columns per metric
  const selectExprs = METRICS.flatMap(m => [
    `MAX(CASE WHEN period = 'AM' THEN ${m} END) AS ${m}_am`,
    `MAX(CASE WHEN period = 'PM' THEN ${m} END) AS ${m}_pm`
  ]).join(',\n      ');

  try {
    const [checkins, sleep] = await Promise.all([
      safeQuery(
        `SELECT date,
                ${selectExprs},
                BOOL_OR(supplement_missed) AS supplement_missed
         FROM health_checkins
         ${checkinRange}
         GROUP BY date
         ORDER BY date`,
        params
      ),
      safeQuery(`SELECT date, sleep_score, sleep_hours FROM daily_metrics ${metricsRange} ORDER BY date`, params)
    ]);

    const fmt = d => (d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0]);
    const byDate = {};
    for (const r of checkins) {
      const k = fmt(r.date);
      byDate[k] = { date: k, supplement_missed: !!r.supplement_missed };
      for (const m of METRICS) {
        byDate[k][`${m}_am`] = r[`${m}_am`] != null ? +r[`${m}_am`] : null;
        byDate[k][`${m}_pm`] = r[`${m}_pm`] != null ? +r[`${m}_pm`] : null;
      }
    }
    for (const r of sleep) {
      const k = fmt(r.date);
      byDate[k] ||= { date: k };
      byDate[k].sleep_score = r.sleep_score != null ? +r.sleep_score : null;
      byDate[k].sleep_hours = r.sleep_hours != null ? +r.sleep_hours : null;
    }

    const data = Object.keys(byDate).sort().map(k => byDate[k]);
    return res.status(200).json({ success: true, count: data.length, data });
  } catch (e) {
    console.error('checkins error:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
};
