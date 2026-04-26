#!/usr/bin/env python3
"""
Daily Garmin → Neon sync.

Pulls weight, sleep, daily metrics, activities, and strength-set details for
the past WINDOW_DAYS and upserts into the fitness-v2 schema. Designed to run
unattended in GitHub Actions (see .github/workflows/sync-garmin.yml).

Required env vars (provided by GH Actions secrets):
  GARMIN_EMAIL
  GARMIN_PASSWORD
  NEON_DATABASE_URL    (postgres connection string)

Token cache is restored to ~/.garth between runs via actions/cache so we don't
re-auth every day (Garmin will throttle if you do).
"""

import json
import os
import sys
import traceback
from datetime import date, datetime, timedelta

import psycopg2
from psycopg2.extras import Json
from garminconnect import Garmin

WINDOW_DAYS = int(os.environ.get("GARMIN_WINDOW_DAYS", "60"))   # daily run backfills the prior N-1 days
TOKEN_DIR = os.path.expanduser("~/.garth")


def is_rate_limited(exc: Exception) -> bool:
    """Return True if the exception indicates Garmin is rate-limiting us (429)."""
    msg = str(exc).lower()
    return "429" in msg or "too many" in msg or "retryerror" in type(exc).__name__.lower()


def get_client():
    email = os.environ["GARMIN_EMAIL"]
    password = os.environ["GARMIN_PASSWORD"]
    client = Garmin(email, password)
    if os.path.exists(TOKEN_DIR):
        try:
            client.login(TOKEN_DIR)
            print("Logged in via cached token", file=sys.stderr)
            return client
        except Exception as e:
            if is_rate_limited(e):
                print(f"Garmin rate-limiting token refresh — skipping today's sync: {e}", file=sys.stderr)
                sys.exit(0)
            print(f"Cache failed: {e}", file=sys.stderr)
    try:
        client.login()
    except Exception as e:
        if is_rate_limited(e):
            print(f"Garmin rate-limiting fresh login — skipping today's sync: {e}", file=sys.stderr)
            sys.exit(0)
        raise
    os.makedirs(TOKEN_DIR, exist_ok=True)
    client.garth.dump(TOKEN_DIR)
    return client


def categorize(name: str) -> str:
    # Normalize: lowercase + collapse all hyphens/underscores/whitespace to spaces
    import re
    n = re.sub(r"[\s_\-]+", " ", (name or "").lower()).strip()
    # Lower body FIRST so leg-press/leg-curl/hip-thrust don't match upper "press"/"curl"/"bench"
    if any(k in n for k in (
        "squat", "deadlift", "lunge", "leg press", "leg curl", "leg extension",
        "calf", "hip thrust", "rdl", "step up", "kickback", "glute"
    )):
        return "lower"
    if any(k in n for k in (
        "bench", "push up", "overhead", "shoulder press", "dip", "press",
        "fly", "tricep", "lateral raise"
    )):
        return "upper_push"
    if any(k in n for k in (
        "pull up", "chin up", "row", "lat pull", "dead hang", "curl",
        "pulldown", "face pull", "rear lateral", "biceps", "shrug"
    )):
        return "upper_pull"
    if any(k in n for k in ("plank", "crunch", "sit up", "ab ", "core", "russian twist", "wall slide")):
        return "core"
    return "other"


def sync(conn, client):
    end = date.today()
    start = end - timedelta(days=WINDOW_DAYS)
    rows_written = 0

    # 1) Weight — write to BOTH the legacy `weight` table (drives existing /api/weight)
    #    AND the new `body_composition` table.
    print(f"Fetching weight {start}..{end}", file=sys.stderr)
    try:
        # Garmin returns kg / grams depending on endpoint variant — assume kg here
        wd = client.get_weigh_ins(start.isoformat(), end.isoformat()) or {}
        for entry in wd.get("dailyWeightSummaries", []) or []:
            # Garmin response uses {latestWeight:{weight}, minWeight, maxWeight} — all in grams.
            latest = entry.get("latestWeight") or {}
            w_g = latest.get("weight") or entry.get("maxWeight") or entry.get("minWeight") \
                  or entry.get("startWeight") or entry.get("highWeight")
            day = entry.get("summaryDate") or latest.get("calendarDate")
            if not (w_g and day):
                continue
            w_kg = float(w_g) / 1000.0 if w_g > 1000 else float(w_g)
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO body_composition (date, weight_kg, source, raw)
                    VALUES (%s, %s, 'garmin', %s)
                    ON CONFLICT (date, source) DO UPDATE
                      SET weight_kg = EXCLUDED.weight_kg, raw = EXCLUDED.raw
                    """,
                    (day, w_kg, Json(entry)),
                )
                # Mirror to legacy `weight` table — UPSERT by date (idempotent)
                cur.execute(
                    """
                    INSERT INTO weight (date, weight_kg, source) VALUES (%s, %s, 'garmin')
                    ON CONFLICT DO NOTHING
                    """,
                    (day, w_kg),
                )
                # Replace if a different value exists for the same day from garmin
                cur.execute(
                    """
                    UPDATE weight SET weight_kg = %s WHERE date = %s AND source = 'garmin'
                    """,
                    (w_kg, day),
                )
            rows_written += 1
    except Exception as e:
        print(f"weight error: {e}", file=sys.stderr)

    # 2) Sleep + daily metrics (per-day calls)
    d = start
    while d <= end:
        try:
            s = client.get_sleep_data(d.isoformat()) or {}
            dto = s.get("dailySleepDTO") or {}
            total_sec = (dto.get("sleepTimeSeconds") or 0)
            score = dto.get("sleepScores") or {}
            score_val = None
            if isinstance(score, dict):
                overall = score.get("overall")
                score_val = overall.get("value") if isinstance(overall, dict) else overall
            # Sleep is Fitbit-direct only — Garmin no longer writes sleep_hours.
            # If Fitbit OAuth fails, the day stays NULL (visible gap) rather than
            # silently filling with Garmin data. Raw is still kept for diagnostics.
            if total_sec > 0:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO daily_metrics (date, source, raw, updated_at)
                        VALUES (%s, 'garmin', %s, NOW())
                        ON CONFLICT (date) DO UPDATE
                          SET raw        = EXCLUDED.raw,
                              updated_at = NOW()
                        """,
                        (d.isoformat(), Json(s)),
                    )
                rows_written += 1
        except Exception as e:
            print(f"sleep {d} error: {e}", file=sys.stderr)

        # Stress / body battery / RHR — these come from a stats endpoint
        try:
            stats = client.get_stats(d.isoformat()) or {}
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO daily_metrics (date, resting_hr, steps, body_battery, stress_score, source, raw, updated_at)
                    VALUES (%s, %s, %s, %s, %s, 'garmin', %s, NOW())
                    ON CONFLICT (date) DO UPDATE
                      SET resting_hr   = COALESCE(EXCLUDED.resting_hr,   daily_metrics.resting_hr),
                          steps        = COALESCE(EXCLUDED.steps,        daily_metrics.steps),
                          body_battery = COALESCE(EXCLUDED.body_battery, daily_metrics.body_battery),
                          stress_score = COALESCE(EXCLUDED.stress_score, daily_metrics.stress_score),
                          updated_at   = NOW()
                    """,
                    (
                        d.isoformat(),
                        stats.get("restingHeartRate"),
                        stats.get("totalSteps"),
                        stats.get("bodyBatteryMostRecentValue"),
                        stats.get("averageStressLevel"),
                        Json(stats),
                    ),
                )
            rows_written += 1
        except Exception as e:
            print(f"stats {d} error: {e}", file=sys.stderr)

        d += timedelta(days=1)

    # 3) Activities + strength sets
    print("Fetching activities", file=sys.stderr)
    try:
        activities = client.get_activities_by_date(start.isoformat(), end.isoformat()) or []
        for a in activities:
            aid = a.get("activityId")
            if not aid:
                continue
            day = (a.get("startTimeLocal") or "")[:10]
            type_key = (a.get("activityType") or {}).get("typeKey") or ""
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO workout_sessions (id, date, type, name, duration_seconds, training_load, raw)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE
                      SET type             = EXCLUDED.type,
                          name             = EXCLUDED.name,
                          duration_seconds = EXCLUDED.duration_seconds,
                          training_load    = EXCLUDED.training_load,
                          raw              = EXCLUDED.raw
                    """,
                    (
                        int(aid),
                        day,
                        type_key,
                        a.get("activityName"),
                        int((a.get("duration") or 0)),
                        a.get("activityTrainingLoad"),
                        Json(a),
                    ),
                )
            rows_written += 1

            if "strength" in type_key.lower():
                try:
                    sets_resp = client.get_activity_exercise_sets(aid) or {}
                except Exception as e:
                    print(f"sets {aid} error: {e}", file=sys.stderr)
                    sets_resp = {}
                sets = sets_resp.get("exerciseSets") or sets_resp.get("sets") or []
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM workout_sets WHERE session_id = %s", (int(aid),))
                for i, s in enumerate(sets):
                    exs = s.get("exercises") or []
                    name = exs[0].get("name") if exs else s.get("exerciseName")
                    reps = s.get("repetitionCount") or s.get("reps")
                    set_type = (s.get("setType") or "").upper()
                    # Skip rest periods, warm-ups, and any set without a real exercise/reps
                    if not name or name.lower() == "unknown" or set_type == "REST" or not reps:
                        continue
                    # garminconnect returns weight in grams sometimes — normalize
                    w_raw = s.get("weight")
                    w_lbs = None
                    if w_raw:
                        kg = w_raw / 1000.0 if w_raw > 1000 else w_raw
                        w_lbs = round(kg * 2.20462, 1)
                    with conn.cursor() as cur:
                        cur.execute(
                            """
                            INSERT INTO workout_sets (session_id, set_index, exercise, category, reps, weight_lbs, raw)
                            VALUES (%s, %s, %s, %s, %s, %s, %s)
                            """,
                            (int(aid), i, name, categorize(name), reps, w_lbs, Json(s)),
                        )
                    rows_written += 1
    except Exception as e:
        print(f"activities error: {e}", file=sys.stderr)

    return rows_written


def record_run(conn, status: str, rows: int, err: str | None):
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO pipeline_runs (source, finished_at, status, rows_written, error)
            VALUES ('garmin', NOW(), %s, %s, %s)
            """,
            (status, rows, err),
        )


def main():
    conn = psycopg2.connect(os.environ["NEON_DATABASE_URL"], sslmode="require")
    conn.autocommit = True
    try:
        client = get_client()
        try:
            rows = sync(conn, client)
            record_run(conn, "ok", rows, None)
            print(f"OK — {rows} rows written", file=sys.stderr)
        except Exception:
            err = traceback.format_exc()
            record_run(conn, "error", 0, err[:2000])
            print(err, file=sys.stderr)
            sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
