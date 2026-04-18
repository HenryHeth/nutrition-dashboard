// /api/body-composition?from=YYYY-MM-DD&to=YYYY-MM-DD
// Lean mass + BF% trend, with weight from the existing `weight` table as context (spec §4e).
// Sparse data is expected — frontend connects the dots.

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

  const { from, to } = req.query;
  const range = from && to ? 'WHERE date BETWEEN $1 AND $2' : '';
  const params = from && to ? [from, to] : [];

  try {
    // body_composition can have multiple rows per date (one per source) — pick the most-detailed.
    const body = await safeQuery(
      `SELECT date,
              MAX(weight_lbs)    AS weight_lbs,
              MAX(body_fat_pct)  AS body_fat_pct,
              MAX(lean_mass_lbs) AS lean_mass_lbs,
              MAX(waist_cm)      AS waist_cm,
              MAX(chest_cm)      AS chest_cm,
              MAX(shoulders_cm)  AS shoulders_cm
       FROM body_composition
       ${range}
       GROUP BY date
       ORDER BY date`,
      params
    );

    const fmt = d => (d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0]);
    const data = body.map(r => ({
      date: fmt(r.date),
      weight_lbs:    r.weight_lbs    != null ? +r.weight_lbs    : null,
      body_fat_pct:  r.body_fat_pct  != null ? +r.body_fat_pct  : null,
      lean_mass_lbs: r.lean_mass_lbs != null ? +r.lean_mass_lbs : null,
      waist_cm:      r.waist_cm      != null ? +r.waist_cm      : null,
      chest_cm:      r.chest_cm      != null ? +r.chest_cm      : null,
      shoulders_cm:  r.shoulders_cm  != null ? +r.shoulders_cm  : null
    }));

    return res.status(200).json({ success: true, count: data.length, data });
  } catch (e) {
    console.error('body-composition error:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
};
