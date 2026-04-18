// /api/workout-audit?days=90
// Per-exercise stats over the last N days for spec §5 audit screen.
// Returns: exercise, count, distinct_weights, min/max/mean weight, variance_pct,
//          suggested_standard, current_standard, flagged.

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

const BODYWEIGHT_HINTS = /pull.?up|chin.?up|push.?up|dead hang|dip|inverted row|pistol/i;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (process.env.DASHBOARD_PASSWORD && !verifyToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const days = Math.min(365, Math.max(7, parseInt(req.query.days) || 90));

  try {
    const [rows, standards] = await Promise.all([
      safeQuery(
        `SELECT ws.exercise,
                ws.category,
                COUNT(*)::int                                  AS times_logged,
                COUNT(DISTINCT ws.weight_lbs)::int             AS distinct_weights,
                MIN(ws.weight_lbs)                             AS min_lbs,
                MAX(ws.weight_lbs)                             AS max_lbs,
                ROUND(AVG(ws.weight_lbs)::numeric, 1)          AS mean_lbs,
                ARRAY_AGG(DISTINCT ws.weight_lbs ORDER BY ws.weight_lbs) AS weights
         FROM workout_sets ws
         JOIN workout_sessions s ON s.id = ws.session_id
         WHERE ws.exercise IS NOT NULL
           AND s.date >= CURRENT_DATE - $1::int
         GROUP BY ws.exercise, ws.category
         ORDER BY times_logged DESC`,
        [days]
      ),
      safeQuery(`SELECT exercise, standard_lbs FROM exercise_standards`, [])
    ]);

    const stdByName = Object.fromEntries(standards.map(r => [r.exercise.toLowerCase(), +r.standard_lbs]));

    const data = rows.map(r => {
      const min = r.min_lbs != null ? +r.min_lbs : null;
      const max = r.max_lbs != null ? +r.max_lbs : null;
      const mean = r.mean_lbs != null ? +r.mean_lbs : null;
      const variancePct = (min != null && max != null && mean > 0) ? Math.round(((max - min) / mean) * 100) : 0;
      const isBodyweight = BODYWEIGHT_HINTS.test(r.exercise || '');
      const current = stdByName[(r.exercise || '').toLowerCase()] ?? null;
      // Suggested = mode-ish: most-common weight. Approximate via mean for now.
      const suggested = current ?? (mean != null ? Math.round(mean) : null);
      // Flag bodyweight exercises whose logged weights vary > 10%.
      const flagged = isBodyweight && variancePct > 10;
      return {
        exercise: r.exercise,
        category: r.category,
        times_logged: r.times_logged,
        distinct_weights: r.distinct_weights,
        weights: (r.weights || []).filter(v => v != null).map(Number),
        min_lbs: min, max_lbs: max, mean_lbs: mean,
        variance_pct: variancePct,
        suggested_standard: suggested,
        current_standard: current,
        is_bodyweight: isBodyweight,
        flagged
      };
    });

    return res.status(200).json({ success: true, days, count: data.length, data });
  } catch (e) {
    console.error('workout-audit error:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
};
