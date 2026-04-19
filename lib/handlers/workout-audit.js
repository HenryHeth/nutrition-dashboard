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
    const [rows, missingRows, standards] = await Promise.all([
      safeQuery(
        `SELECT ws.exercise,
                ws.category,
                COUNT(*)::int                                  AS times_logged,
                COUNT(DISTINCT ws.weight_lbs)::int             AS distinct_weights,
                MIN(ws.weight_lbs)                             AS min_lbs,
                MAX(ws.weight_lbs)                             AS max_lbs,
                ROUND(AVG(ws.weight_lbs)::numeric, 1)          AS mean_lbs,
                ARRAY_AGG(DISTINCT ws.weight_lbs ORDER BY ws.weight_lbs) FILTER (WHERE ws.weight_lbs IS NOT NULL) AS weights,
                COUNT(*) FILTER (WHERE ws.weight_lbs IS NULL OR ws.weight_lbs = 0)::int AS missing_weight_sets
         FROM workout_sets ws
         JOIN workout_sessions s ON s.id = ws.session_id
         WHERE ws.exercise IS NOT NULL
           AND s.date >= CURRENT_DATE - $1::int
         GROUP BY ws.exercise, ws.category
         ORDER BY times_logged DESC`,
        [days]
      ),
      // Per-exercise list of session dates with missing/zero weight — so user can fix in Garmin
      safeQuery(
        `SELECT ws.exercise, s.date, COUNT(*) AS sets_missing
         FROM workout_sets ws
         JOIN workout_sessions s ON s.id = ws.session_id
         WHERE ws.exercise IS NOT NULL
           AND s.date >= CURRENT_DATE - $1::int
           AND (ws.weight_lbs IS NULL OR ws.weight_lbs = 0)
         GROUP BY ws.exercise, s.date
         ORDER BY s.date DESC`,
        [days]
      ),
      safeQuery(`SELECT exercise, standard_lbs FROM exercise_standards`, [])
    ]);

    const stdByName = Object.fromEntries(standards.map(r => [r.exercise.toLowerCase(), +r.standard_lbs]));
    // Group missing-weight dates by exercise
    const fmt = d => (d instanceof Date ? d.toISOString().slice(0,10) : String(d).slice(0,10));
    const missingByEx = {};
    for (const r of missingRows) {
      (missingByEx[r.exercise] ||= []).push({ date: fmt(r.date), sets: +r.sets_missing });
    }

    const data = rows.map(r => {
      const min = r.min_lbs != null ? +r.min_lbs : null;
      const max = r.max_lbs != null ? +r.max_lbs : null;
      const mean = r.mean_lbs != null ? +r.mean_lbs : null;
      const variancePct = (min != null && max != null && mean > 0) ? Math.round(((max - min) / mean) * 100) : 0;
      const isBodyweight = BODYWEIGHT_HINTS.test(r.exercise || '');
      const current = stdByName[(r.exercise || '').toLowerCase()] ?? null;
      const suggested = current ?? (mean != null ? Math.round(mean) : null);
      const missingSets = +r.missing_weight_sets || 0;
      const missingDates = missingByEx[r.exercise] || [];

      // Flag conditions:
      //   1. Bodyweight exercise has any session with missing/zero weight (forgot to log) — most useful signal
      //   2. Any exercise has > 10% variance across sessions (potentially miscoded)
      const missingOnBodyweight = isBodyweight && missingSets > 0;
      const highVariance = variancePct > 10;
      const flagged = missingOnBodyweight || highVariance;
      const flagReasons = [];
      if (missingOnBodyweight) flagReasons.push(`${missingSets} set${missingSets>1?'s':''} missing weight on bodyweight exercise — fix in Garmin`);
      if (highVariance)       flagReasons.push(`${variancePct}% weight variance — convention drift?`);

      return {
        exercise: r.exercise,
        category: r.category,
        times_logged: r.times_logged,
        distinct_weights: r.distinct_weights,
        weights: (r.weights || []).map(Number),
        min_lbs: min, max_lbs: max, mean_lbs: mean,
        variance_pct: variancePct,
        suggested_standard: suggested,
        current_standard: current,
        is_bodyweight: isBodyweight,
        missing_weight_sets: missingSets,
        missing_dates: missingDates,
        flagged,
        flag_reasons: flagReasons
      };
    });

    return res.status(200).json({ success: true, days, count: data.length, data });
  } catch (e) {
    console.error('workout-audit error:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
};
