// POST /api/exercise-standards { exercise, standard_lbs, note? }
// Upserts a row into exercise_standards. Used by the /workout-audit "Standardise" action.
// Non-destructive: workout_sets.weight_lbs is never modified — this is a read-time override.

const { pool } = require('../lib/db');
const crypto = require('crypto');

function verifyToken(token) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return true;
  const secret = process.env.AUTH_SECRET || 'nutrition-dashboard-2026';
  const expected = crypto.createHash('sha256').update(password + secret).digest('hex');
  return token === expected;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (process.env.DASHBOARD_PASSWORD && !verifyToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    if (req.method === 'POST') {
      const { exercise, standard_lbs, note } = req.body || {};
      if (!exercise || standard_lbs == null) {
        return res.status(400).json({ error: 'exercise and standard_lbs required' });
      }
      await pool.query(
        `INSERT INTO exercise_standards (exercise, standard_lbs, note, set_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (exercise) DO UPDATE
         SET standard_lbs = EXCLUDED.standard_lbs,
             note         = COALESCE(EXCLUDED.note, exercise_standards.note),
             set_at       = NOW()`,
        [exercise, +standard_lbs, note || null]
      );
      return res.status(200).json({ success: true });
    }
    if (req.method === 'DELETE') {
      const { exercise } = req.query;
      if (!exercise) return res.status(400).json({ error: 'exercise required' });
      await pool.query('DELETE FROM exercise_standards WHERE exercise = $1', [exercise]);
      return res.status(200).json({ success: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('exercise-standards error:', e);
    return res.status(500).json({ error: e.message });
  }
};
