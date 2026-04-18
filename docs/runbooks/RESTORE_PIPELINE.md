# Restore broken sync pipelines

The daily Pipeline Health Check workflow (`.github/workflows/check-pipeline-health.yml`)
fires at 13:30 UTC and emails you if any source has errored or gone stale in the
last 24 h. When you get that email, open the failing run on GitHub Actions, read
the summary, then follow the matching section below.

---

## Fitbit OAuth expired — sleep stops updating

**Symptoms** — Health check email subject contains `fitbit` in the error block, or
"Fitbit sleep stale". Per design, when Fitbit fails the dashboard shows the day
as a gap (no fallback to Garmin/TP) so the gap itself is the warning sign.

**Restore steps:**

1. Visit https://nutrition-dashboard-one.vercel.app/api/fitbit/authorize in any
   browser (Paul logged in to fitbit.com). It will redirect to the Fitbit auth
   page — click **Allow**, you'll see "✅ Fitbit connected".

2. Manually trigger the Garmin sync workflow to also re-fire Fitbit on the next
   tick, OR wait until 06:00 PDT tomorrow:
   ```bash
   gh workflow run sync-garmin.yml --repo HenryHeth/nutrition-dashboard
   ```

3. After it finishes, re-run the health check to confirm:
   ```bash
   gh workflow run check-pipeline-health.yml --repo HenryHeth/nutrition-dashboard
   ```

**If the OAuth dance itself fails** (Fitbit returns an error during /authorize):

- The Fitbit Personal app is at https://dev.fitbit.com/apps (client_id `23VB33`)
- Confirm the Redirect URI is still
  `https://nutrition-dashboard-one.vercel.app/api/fitbit/callback`
- If client secret was rotated: pull new secret, update Vercel env var:
  ```bash
  bw get item "Fitbit Dashboard App" --session "$(~/.local/bin/bw-unlock)" \
    | jq -r '.fields[] | select(.name=="client_secret") | .value' \
    | vercel env add FITBIT_CLIENT_SECRET production --force
  ```

---

## TrainingPeaks cookie expired

**Symptoms** — `trainingpeaks` source errors with `TP token exchange failed:
401`. CTL/ATL/TSB stops updating, body composition stops, HRV/RHR stops.

**Restore steps:**

1. Log in to https://app.trainingpeaks.com in any browser
2. Open browser DevTools → Application → Cookies → `trainingpeaks.com`
3. Copy the **`Production_tpAuth`** cookie value (long base64 blob)
4. Update Vercel:
   ```bash
   vercel env rm TP_COOKIE production --yes
   echo -n "<paste cookie here>" | vercel env add TP_COOKIE production
   ```
5. Update Bitwarden under "trainingpeaks.com" → custom field `tp_auth_cookie`
6. Re-trigger:
   ```bash
   curl -H "Authorization: Bearer $(vercel env pull /dev/null && grep CRON_SECRET .env.production | cut -d= -f2)" \
     https://nutrition-dashboard-one.vercel.app/api/cron/sync-fitness
   ```

---

## Garmin login failed

**Symptoms** — GitHub Action `sync-garmin.yml` fails with 401 or "MFA required".

**Restore steps:**

1. If MFA is the issue, log in to https://connect.garmin.com from a browser to
   clear the MFA challenge. The cached `~/.garth` token in GitHub Actions may
   need to be cleared:
   ```bash
   gh cache list --repo HenryHeth/nutrition-dashboard
   gh cache delete <cache-id> --repo HenryHeth/nutrition-dashboard
   ```
2. If Garmin password was rotated:
   ```bash
   bw get password "Garmin Connect 2025" --session "$(~/.local/bin/bw-unlock)" \
     | gh secret set GARMIN_PASSWORD --repo HenryHeth/nutrition-dashboard
   ```
3. Re-run:
   ```bash
   gh workflow run sync-garmin.yml --repo HenryHeth/nutrition-dashboard
   ```

---

## FatSecret OAuth1 session expired

Rare — OAuth1 session tokens are long-lived. If `fatsecret` source starts
returning 401:

1. Re-run the OAuth1 dance via FatSecret's developer portal (their docs)
2. Update the four env vars from the new tokens:
   ```bash
   for k in FATSECRET_CONSUMER_KEY FATSECRET_CONSUMER_SECRET FATSECRET_SESSION_TOKEN FATSECRET_SESSION_SECRET; do
     vercel env rm "$k" production --yes
   done
   # then add each from the new values, similar to TP_COOKIE above
   ```
3. Re-trigger Vercel cron via curl as above

---

## Generic / unknown source error

1. Open the GitHub Actions run, click the failing job, expand the failing step
2. Tail the most recent error from the DB directly:
   ```bash
   psql "$NEON_DATABASE_URL" -c "
     SELECT source, finished_at, error
     FROM pipeline_runs
     WHERE status = 'error'
     ORDER BY finished_at DESC
     LIMIT 5;
   "
   ```
3. If it's network/transient, manually retry the source's workflow / endpoint
4. If it's a code bug, fix in a PR and redeploy

---

## Re-running the health check manually

```bash
gh workflow run check-pipeline-health.yml --repo HenryHeth/nutrition-dashboard
gh run list --workflow check-pipeline-health.yml --repo HenryHeth/nutrition-dashboard --limit 3
```
