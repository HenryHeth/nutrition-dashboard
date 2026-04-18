-- Fitness Dashboard v2 — Schema additions
-- Spec: /workspace-matthew/fitness-data/fitness-dashboard-v2-spec.md §3b
-- Apply to the same Neon DB that hosts daily_nutrition / weight / SignalCheck tables.
-- Idempotent: safe to re-run.

-- ============================================================
-- daily_metrics — sleep / HRV / RHR / steps / body battery / stress
-- Source: TrainingPeaks (primary), Garmin (fallback)
-- ============================================================
CREATE TABLE IF NOT EXISTS daily_metrics (
  date              DATE PRIMARY KEY,
  sleep_hours       REAL,
  sleep_score       INTEGER,        -- Fitbit / TP sleep score for restedness comparison
  hrv_ms            REAL,
  resting_hr        INTEGER,
  steps             INTEGER,
  body_battery      INTEGER,        -- Garmin 0-100
  stress_score      INTEGER,        -- Garmin 0-100
  source            TEXT,           -- 'trainingpeaks' | 'garmin'
  raw               JSONB,          -- full payload for re-derivation
  inserted_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- body_composition — weight / BF% / lean mass / measurements
-- Sources: TrainingPeaks body measurements + SprenScan
-- (Existing `weight` table is preserved; this is the superset.)
-- ============================================================
CREATE TABLE IF NOT EXISTS body_composition (
  date              DATE,
  weight_kg         REAL,
  weight_lbs        REAL GENERATED ALWAYS AS (weight_kg * 2.20462) STORED,
  body_fat_pct      REAL,
  lean_mass_lbs     REAL,
  waist_cm          REAL,
  chest_cm          REAL,
  shoulders_cm      REAL,
  source            TEXT,           -- 'trainingpeaks' | 'sprenscan' | 'manual'
  raw               JSONB,
  inserted_at       TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (date, source)
);

-- ============================================================
-- fitness_load — TrainingPeaks Performance Management Chart values
-- ============================================================
CREATE TABLE IF NOT EXISTS fitness_load (
  date              DATE PRIMARY KEY,
  ctl               REAL,           -- Chronic Training Load (Fitness)
  atl               REAL,           -- Acute Training Load (Fatigue)
  tsb               REAL,           -- Training Stress Balance (Form) = CTL - ATL
  inserted_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- workout_sessions — one row per Garmin activity
-- ============================================================
CREATE TABLE IF NOT EXISTS workout_sessions (
  id                BIGINT PRIMARY KEY,             -- Garmin activityId
  date              DATE NOT NULL,
  type              TEXT,                           -- 'strength' | 'run' | 'bike' | 'swim' | 'yoga' | ...
  name              TEXT,
  duration_seconds  INTEGER,
  training_load     REAL,
  raw               JSONB,
  inserted_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workout_sessions_date ON workout_sessions(date);

-- ============================================================
-- workout_sets — per-exercise sets/reps/weight from Garmin strength sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS workout_sets (
  id                BIGSERIAL PRIMARY KEY,
  session_id        BIGINT NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
  set_index         INTEGER NOT NULL,
  exercise          TEXT,
  category          TEXT,                           -- 'upper_push' | 'upper_pull' | 'lower' | 'core' | 'other'
  reps              INTEGER,
  weight_lbs        REAL,
  volume            REAL GENERATED ALWAYS AS (COALESCE(reps,0) * COALESCE(weight_lbs,0)) STORED,
  raw               JSONB
);
CREATE INDEX IF NOT EXISTS idx_workout_sets_session ON workout_sets(session_id);
CREATE INDEX IF NOT EXISTS idx_workout_sets_exercise ON workout_sets(exercise);

-- ============================================================
-- exercise_standards — non-destructive override layer for bodyweight / banded exercises
-- The raw `workout_sets.weight_lbs` is preserved as logged.
-- Volume queries should COALESCE(standard.weight_lbs, set.weight_lbs).
-- Spec §5: pre-loaded defaults below.
-- ============================================================
CREATE TABLE IF NOT EXISTS exercise_standards (
  exercise          TEXT PRIMARY KEY,
  standard_lbs      REAL NOT NULL,
  note              TEXT,
  set_by            TEXT DEFAULT 'paul',
  set_at            TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO exercise_standards (exercise, standard_lbs, note) VALUES
  ('Pull-ups',       150, 'bodyweight'),
  ('Chin-ups',       150, 'bodyweight'),
  ('Dead Hangs',     150, 'bodyweight'),
  ('Push-ups',       100, 'bodyweight (partial load)')
ON CONFLICT (exercise) DO NOTHING;

-- ============================================================
-- pipeline_runs — observability for the daily 6 AM sync job
-- ============================================================
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id                BIGSERIAL PRIMARY KEY,
  source            TEXT NOT NULL,                  -- 'trainingpeaks' | 'fatsecret' | 'garmin'
  started_at        TIMESTAMPTZ DEFAULT NOW(),
  finished_at       TIMESTAMPTZ,
  status            TEXT,                           -- 'ok' | 'error' | 'partial'
  rows_written      INTEGER,
  error             TEXT
);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started ON pipeline_runs(started_at DESC);
