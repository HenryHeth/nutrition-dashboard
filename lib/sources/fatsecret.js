// FatSecret OAuth 1.0 — TODO(creds): FATSECRET_CONSUMER_KEY + FATSECRET_CONSUMER_SECRET env vars.
// Existing config: /workspace-matthew/fitness-data/fatsecret_config.json (confirm freshness).
//
// Note: existing `daily_nutrition` and `food_entries` tables are already populated by the
// current MFP-based pipeline. This source is for the spec's switch to FatSecret as the primary
// nutrition source. Until the migration is approved, this is a no-op in the orchestrator.

async function syncDay(date) {
  // TODO: pull day's foods + macros from FatSecret, write to food_entries + daily_nutrition.
  // Skipping for now — existing MFP pipeline still feeding these tables.
  return 0;
}

module.exports = { syncDay };
