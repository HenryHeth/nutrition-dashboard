// SignalCheck writes directly to the same Neon DB (health_checkins, supplement_logs).
// No sync needed — dashboard queries those tables directly.
// This module exists for symmetry with the orchestrator and to record a "ok / no-op" run.

async function syncDay(date) {
  return 0;
}

module.exports = { syncDay };
