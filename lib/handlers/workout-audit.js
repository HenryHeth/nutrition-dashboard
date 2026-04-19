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

  // How big a deviation triggers an anomaly. 3× median = likely a typo
  // (e.g. 50 reps when you meant 5, or 250 lbs when you meant 25).
  // Only checked for exercises with at least 4 logged sets so the median is meaningful.
  const ANOMALY_FACTOR = 3;
  const MIN_SETS_FOR_ANOMALY = 4;

  try {
    const [rows, missingRows, anomalyRows, standards] = await Promise.all([
      safeQuery(
        `SELECT ws.exercise,
                ws.category,
                COUNT(*)::int                                  AS times_logged,
                COUNT(DISTINCT ws.weight_lbs)::int             AS distinct_weights,
                MIN(ws.weight_lbs)                             AS min_lbs,
                MAX(ws.weight_lbs)                             AS max_lbs,
                ROUND(AVG(ws.weight_lbs)::numeric, 1)          AS mean_lbs,
                ARRAY_AGG(DISTINCT ws.weight_lbs ORDER BY ws.weight_lbs) FILTER (WHERE ws.weight_lbs IS NOT NULL) AS weights,
                COUNT(*) FILTER (WHERE ws.weight_lbs IS NULL OR ws.weight_lbs = 0)::int AS missing_weight_sets,
                COUNT(*) FILTER (WHERE ws.reps IS NULL OR ws.reps = 0)::int AS missing_reps_sets
         FROM workout_sets ws
         JOIN workout_sessions s ON s.id = ws.session_id
         WHERE ws.exercise IS NOT NULL
           AND s.date >= CURRENT_DATE - $1::int
         GROUP BY ws.exercise, ws.category
         ORDER BY times_logged DESC`,
        [days]
      ),
      // Per-exercise list of session dates with missing weight OR reps — so user can fix in Garmin.
      // Includes session_id (Garmin activityId) for direct linking.
      safeQuery(
        `SELECT ws.exercise, s.date, s.id AS session_id,
                COUNT(*) FILTER (WHERE ws.weight_lbs IS NULL OR ws.weight_lbs = 0) AS sets_missing_weight,
                COUNT(*) FILTER (WHERE ws.reps IS NULL OR ws.reps = 0)             AS sets_missing_reps
         FROM workout_sets ws
         JOIN workout_sessions s ON s.id = ws.session_id
         WHERE ws.exercise IS NOT NULL
           AND s.date >= CURRENT_DATE - $1::int
           AND ((ws.weight_lbs IS NULL OR ws.weight_lbs = 0) OR (ws.reps IS NULL OR ws.reps = 0))
         GROUP BY ws.exercise, s.date, s.id
         ORDER BY s.date DESC`,
        [days]
      ),
      // Per-exercise anomaly detection: any set where weight or reps is
      // > ANOMALY_FACTOR × median or < median / ANOMALY_FACTOR is flagged.
      // Catches typo-style errors (e.g. one set logged as 100 reps when median is 10).
      safeQuery(
        `WITH stats AS (
           SELECT ws.exercise,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY ws.weight_lbs) AS med_weight,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY ws.reps)       AS med_reps,
                  COUNT(*) AS set_count
           FROM workout_sets ws
           JOIN workout_sessions s ON s.id = ws.session_id
           WHERE s.date >= CURRENT_DATE - $1::int
             AND ws.weight_lbs > 0 AND ws.reps > 0
           GROUP BY ws.exercise
           HAVING COUNT(*) >= $2
         )
         SELECT ws.exercise, s.date, s.id AS session_id, ws.set_index,
                ws.weight_lbs, ws.reps,
                ROUND(stats.med_weight::numeric, 1) AS med_weight,
                ROUND(stats.med_reps::numeric, 1)   AS med_reps,
                CASE
                  WHEN ws.weight_lbs > $3 * stats.med_weight  THEN 'weight too high'
                  WHEN ws.weight_lbs < stats.med_weight / $3 THEN 'weight too low'
                  WHEN ws.reps > $3 * stats.med_reps          THEN 'reps too high'
                  WHEN ws.reps < stats.med_reps / $3          THEN 'reps too low'
                END AS anomaly_kind
         FROM workout_sets ws
         JOIN workout_sessions s ON s.id = ws.session_id
         JOIN stats ON stats.exercise = ws.exercise
         WHERE s.date >= CURRENT_DATE - $1::int
           AND ws.weight_lbs > 0 AND ws.reps > 0
           AND (ws.weight_lbs > $3 * stats.med_weight
             OR ws.weight_lbs < stats.med_weight / $3
             OR ws.reps        > $3 * stats.med_reps
             OR ws.reps        < stats.med_reps / $3)
         ORDER BY s.date DESC`,
        [days, MIN_SETS_FOR_ANOMALY, ANOMALY_FACTOR]
      ),
      safeQuery(`SELECT exercise, standard_lbs FROM exercise_standards`, [])
    ]);

    const stdByName = Object.fromEntries(standards.map(r => [r.exercise.toLowerCase(), +r.standard_lbs]));
    // Group missing-weight dates by exercise
    const fmt = d => (d instanceof Date ? d.toISOString().slice(0,10) : String(d).slice(0,10));
    const missingByEx = {};
    for (const r of missingRows) {
      (missingByEx[r.exercise] ||= []).push({
        date: fmt(r.date),
        session_id: String(r.session_id),
        sets_missing_weight: +r.sets_missing_weight,
        sets_missing_reps:   +r.sets_missing_reps
      });
    }
    // Same shape for anomalies
    const anomaliesByEx = {};
    for (const a of anomalyRows) {
      (anomaliesByEx[a.exercise] ||= []).push({
        date: fmt(a.date),
        session_id: String(a.session_id),
        set_index: a.set_index,
        weight_lbs: a.weight_lbs != null ? +a.weight_lbs : null,
        reps: a.reps,
        median_weight: +a.med_weight,
        median_reps: +a.med_reps,
        kind: a.anomaly_kind
      });
    }

    const data = rows.map(r => {
      const min = r.min_lbs != null ? +r.min_lbs : null;
      const max = r.max_lbs != null ? +r.max_lbs : null;
      const mean = r.mean_lbs != null ? +r.mean_lbs : null;
      const variancePct = (min != null && max != null && mean > 0) ? Math.round(((max - min) / mean) * 100) : 0;
      const isBodyweight = BODYWEIGHT_HINTS.test(r.exercise || '');
      const current = stdByName[(r.exercise || '').toLowerCase()] ?? null;
      const suggested = current ?? (mean != null ? Math.round(mean) : null);
      const missingWeightSets = +r.missing_weight_sets || 0;
      const missingRepsSets   = +r.missing_reps_sets   || 0;
      const missingDates = missingByEx[r.exercise] || [];
      const anomalies = anomaliesByEx[r.exercise] || [];

      // Flag = any of: missing weight, missing reps, anomaly (likely typo)
      const flagged = missingWeightSets > 0 || missingRepsSets > 0 || anomalies.length > 0;
      const flagReasons = [];
      if (missingWeightSets > 0) {
        const where = isBodyweight ? 'bodyweight — forgot override' : 'Garmin did not capture';
        flagReasons.push(`${missingWeightSets} set${missingWeightSets>1?'s':''} missing weight (${where})`);
      }
      if (missingRepsSets > 0) {
        flagReasons.push(`${missingRepsSets} set${missingRepsSets>1?'s':''} missing reps`);
      }
      if (anomalies.length > 0) {
        flagReasons.push(`${anomalies.length} possible typo${anomalies.length>1?'s':''} (way outside the usual range)`);
      }

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
        missing_weight_sets: missingWeightSets,
        missing_reps_sets:   missingRepsSets,
        anomaly_count:       anomalies.length,
        missing_dates: missingDates,
        anomalies,
        flagged,
        flag_reasons: flagReasons
      };
    });

    const totalMissingWeight = data.reduce((s, r) => s + r.missing_weight_sets, 0);
    const totalMissingReps   = data.reduce((s, r) => s + r.missing_reps_sets,   0);
    const flaggedCount = data.filter(r => r.flagged).length;
    return res.status(200).json({
      success: true, days, count: data.length, data,
      summary: {
        total_missing_weight_sets: totalMissingWeight,
        total_missing_reps_sets:   totalMissingReps,
        flagged_exercises:         flaggedCount
      }
    });
  } catch (e) {
    console.error('workout-audit error:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
};
