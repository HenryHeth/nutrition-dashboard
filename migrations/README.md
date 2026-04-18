# Migrations

Plain SQL files. Apply in order against the Neon DB:

```bash
psql "$NEON_DATABASE_URL" -f migrations/001_fitness_v2_schema.sql
```

Each file is idempotent (`CREATE TABLE IF NOT EXISTS`, `ON CONFLICT DO NOTHING`) — safe to re-run.

## Order

1. `001_fitness_v2_schema.sql` — adds `daily_metrics`, `body_composition`, `fitness_load`, `workout_sessions`, `workout_sets`, `exercise_standards`, `pipeline_runs`. Existing `weight` table is preserved untouched.
