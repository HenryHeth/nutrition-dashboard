// /api/habits?days=60
// GitHub-style compliance grid (spec §4g). Returns 5 rows × N days with status:
//   'hit' | 'miss' | 'no_data'
// Rows: creatine, fiber, protein, sleep, supplement_stack.

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

  const days = Math.min(365, Math.max(7, parseInt(req.query.days) || 60));
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }
  const from = dates[0], to = dates[dates.length - 1];

  try {
    const [nutrition, sleep, supplements, checkins] = await Promise.all([
      safeQuery(`SELECT date, fiber_g, protein_g FROM daily_nutrition WHERE date BETWEEN $1 AND $2`, [from, to]),
      safeQuery(`SELECT date, sleep_hours FROM daily_metrics WHERE date BETWEEN $1 AND $2`, [from, to]),
      safeQuery(`SELECT logged_at::date AS date, type FROM supplement_logs WHERE logged_at::date BETWEEN $1 AND $2`, [from, to]),
      safeQuery(`SELECT date, BOOL_OR(supplement_missed) AS missed FROM health_checkins WHERE date BETWEEN $1 AND $2 GROUP BY date`, [from, to])
    ]);

    const fmt = d => (d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0]);
    const nByDate = Object.fromEntries(nutrition.map(r => [fmt(r.date), r]));
    const sByDate = Object.fromEntries(sleep.map(r => [fmt(r.date), r]));
    const cByDate = Object.fromEntries(checkins.map(r => [fmt(r.date), r]));
    const creatineDays = new Set(supplements.filter(r => /creatine/i.test(r.type || '')).map(r => fmt(r.date)));
    const anySuppDays  = new Set(supplements.map(r => fmt(r.date)));

    const status = (cond, hasData) => !hasData ? 'no_data' : (cond ? 'hit' : 'miss');

    const rows = [
      { key: 'creatine',  label: 'Creatine',         hits: dates.map(d => status(creatineDays.has(d), creatineDays.has(d) || anySuppDays.has(d))) },
      { key: 'fiber',     label: 'Fiber ≥ 25g',      hits: dates.map(d => { const r = nByDate[d]; return status(r && +r.fiber_g >= 25, !!r); }) },
      { key: 'protein',   label: 'Protein ≥ 120g',   hits: dates.map(d => { const r = nByDate[d]; return status(r && +r.protein_g >= 120, !!r); }) },
      { key: 'sleep',     label: 'Sleep ≥ 7 hrs',    hits: dates.map(d => { const r = sByDate[d]; return status(r && +r.sleep_hours >= 7, !!r); }) },
      { key: 'supp_stack',label: 'Supplement stack', hits: dates.map(d => { const r = cByDate[d]; return status(r && !r.missed, !!r); }) }
    ];

    return res.status(200).json({ success: true, dates, rows });
  } catch (e) {
    console.error('habits error:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
};
