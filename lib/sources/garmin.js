// Garmin source — orchestrator-side no-op.
//
// Garmin scraping uses the Python `garminconnect` lib (more reliable than Node
// alternatives, and Paul already has working scripts in /workspace-matthew that
// we ported into scripts/sync_garmin.py). That script runs in GitHub Actions
// (.github/workflows/sync-garmin.yml) and writes directly to Neon.
//
// This module exists so the Vercel cron orchestrator can record a uniform
// pipeline_runs row alongside the Python job's own entries. Status of the
// Garmin sync should be read from the most recent pipeline_runs row where
// source = 'garmin' (written by the Python script).

async function syncDay(date) {
  // Intentional no-op — see scripts/sync_garmin.py
  return 0;
}

module.exports = { syncDay };
