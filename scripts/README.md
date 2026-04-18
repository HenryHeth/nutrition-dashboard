# Sync scripts

Out-of-band data pulls that don't fit Vercel serverless (Python deps, long-lived auth tokens).

## Garmin daily sync

[`sync_garmin.py`](sync_garmin.py) — uses the Python `garminconnect` lib (the same lib Paul's existing scripts in `/workspace-matthew/get_*_*.py` use). Writes weight, sleep, daily metrics, activities, and strength sets directly to Neon.

Runs in GitHub Actions: [.github/workflows/sync-garmin.yml](../.github/workflows/sync-garmin.yml). Daily at 13:15 UTC (06:15 PDT — 15 min after the Vercel cron so they don't race on the same Neon connection pool).

### Required GitHub secrets

Set on the repo: Settings → Secrets and variables → Actions → New repository secret.

| Secret | What | Where to find |
|---|---|---|
| `GARMIN_EMAIL` | `paul@heth.ca` | known |
| `GARMIN_PASSWORD` | Garmin Connect password | Bitwarden |
| `NEON_DATABASE_URL` | Postgres connection string with sslmode=require | Neon → connection details, or copy from Vercel env vars |

### Local test

```bash
export GARMIN_EMAIL=paul@heth.ca
export GARMIN_PASSWORD='...'
export NEON_DATABASE_URL='postgresql://...'
pip install -r scripts/requirements.txt
python scripts/sync_garmin.py
```

Token cache lands in `~/.garth` — keep it for subsequent runs to avoid re-auth.

## TrainingPeaks

Lives in Node ([`lib/sources/trainingpeaks.js`](../lib/sources/trainingpeaks.js)) and runs from the Vercel cron. Cookie-based auth; refresh `TP_COOKIE` env var on Vercel when it expires (you'll start seeing 401s in `pipeline_runs`).

## SignalCheck

No sync needed — writes directly to the same Neon DB. The dashboard reads `health_checkins` / `supplement_logs` directly.

## FatSecret

Stub for now — existing MFP pipeline still feeds nutrition tables. When ready to migrate, fill in [`lib/sources/fatsecret.js`](../lib/sources/fatsecret.js) using the OAuth1 config at `/workspace-matthew/fitness-data/fatsecret_config.json`.
