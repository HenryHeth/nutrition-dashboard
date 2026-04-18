const { pool } = require('../db');

// TODO(creds): GARMIN_EMAIL + GARMIN_PASSWORD env vars.
// Spec calls out the Python `garminconnect` lib as primary. In a Node serverless context
// the realistic options are:
//   (a) Port to a Node lib (e.g. `garmin-connect`) — fragile, MFA can break it
//   (b) Run the Python scraper in GitHub Actions and have it write to Neon directly
//       (then this file becomes a no-op)
// Decision pending — see scripts/sync_garmin.py for the Python skeleton.

async function fetchActivities(date) {
  // TODO: list activities for date, return [{ id, type, name, duration_seconds, training_load }]
  throw new Error('garmin.fetchActivities not yet implemented');
}

async function fetchSets(activityId) {
  // TODO: return [{ set_index, exercise, category, reps, weight_lbs }] for strength sessions
  throw new Error('garmin.fetchSets not yet implemented');
}

function categorizeExercise(name) {
  const n = (name || '').toLowerCase();
  if (/(bench|push.?up|overhead|shoulder press|dip)/.test(n)) return 'upper_push';
  if (/(pull.?up|chin.?up|row|lat pull|dead hang|curl)/.test(n)) return 'upper_pull';
  if (/(squat|deadlift|lunge|leg press|calf|hip thrust|rdl)/.test(n)) return 'lower';
  if (/(plank|crunch|sit.?up|ab |core)/.test(n)) return 'core';
  return 'other';
}

async function syncDay(date) {
  const activities = await fetchActivities(date);
  let rowsWritten = 0;

  for (const a of activities) {
    await pool.query(
      `INSERT INTO workout_sessions (id, date, type, name, duration_seconds, training_load, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         type = EXCLUDED.type,
         name = EXCLUDED.name,
         duration_seconds = EXCLUDED.duration_seconds,
         training_load = EXCLUDED.training_load,
         raw = EXCLUDED.raw`,
      [a.id, date, a.type, a.name, a.duration_seconds, a.training_load, a.raw || null]
    );
    rowsWritten++;

    if (a.type === 'strength') {
      const sets = await fetchSets(a.id);
      // Replace-all per session (idempotent re-sync)
      await pool.query('DELETE FROM workout_sets WHERE session_id = $1', [a.id]);
      for (const s of sets) {
        await pool.query(
          `INSERT INTO workout_sets (session_id, set_index, exercise, category, reps, weight_lbs, raw)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [a.id, s.set_index, s.exercise, categorizeExercise(s.exercise), s.reps, s.weight_lbs, s.raw || null]
        );
        rowsWritten++;
      }
    }
  }

  return rowsWritten;
}

module.exports = { syncDay, categorizeExercise };
