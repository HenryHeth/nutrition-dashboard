// /api/fitbit/authorize  — kicks off OAuth (Paul visits this once in browser)
// /api/fitbit/callback   — Fitbit redirects back here with ?code=...&state=...
//
// Stores the long-lived refresh_token in oauth_tokens(provider='fitbit') so the
// daily cron can mint fresh access tokens without re-auth.

const crypto = require('crypto');
const { pool } = require('../../lib/db');

const CLIENT_ID     = process.env.FITBIT_CLIENT_ID;
const CLIENT_SECRET = process.env.FITBIT_CLIENT_SECRET;
const SCOPES        = 'sleep weight heartrate activity profile cardio_fitness';
const SITE_BASE     = process.env.SITE_BASE_URL || 'https://nutrition-dashboard-one.vercel.app';

const b64url = buf => buf.toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function authorize(req, res) {
  if (!CLIENT_ID) return res.status(500).send('FITBIT_CLIENT_ID not set');

  // PKCE
  const verifier  = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state     = b64url(crypto.randomBytes(16));

  // Stash verifier+state in DB so callback (a different invocation) can find it
  await pool.query(
    `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, scope, user_id, updated_at)
     VALUES ('fitbit_pending', $1, $2, NOW() + INTERVAL '15 minutes', '', NULL, NOW())
     ON CONFLICT (provider) DO UPDATE SET
       access_token=EXCLUDED.access_token, refresh_token=EXCLUDED.refresh_token,
       expires_at=EXCLUDED.expires_at, updated_at=NOW()`,
    [verifier, state]
  );

  const redirect = `${SITE_BASE}/api/fitbit/callback`;
  const params = new URLSearchParams({
    response_type:         'code',
    client_id:             CLIENT_ID,
    scope:                 SCOPES,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
    redirect_uri:          redirect,
    state
  });
  return res.redirect(302, `https://www.fitbit.com/oauth2/authorize?${params}`);
}

async function callback(req, res) {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`Fitbit returned error: ${error}`);
  if (!code || !state) return res.status(400).send('Missing code/state');

  // Look up the verifier we stashed
  const pending = await pool.query(
    `SELECT access_token AS verifier, refresh_token AS state FROM oauth_tokens
     WHERE provider='fitbit_pending' AND expires_at > NOW()`
  );
  if (pending.rowCount === 0) return res.status(400).send('No pending OAuth (expired). Restart at /api/fitbit/authorize.');
  if (pending.rows[0].state !== state) return res.status(400).send('State mismatch (possible CSRF).');
  const verifier = pending.rows[0].verifier;

  // Exchange code for tokens (Basic auth = client_id:client_secret)
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const redirect = `${SITE_BASE}/api/fitbit/callback`;
  const body = new URLSearchParams({
    client_id:    CLIENT_ID,
    grant_type:   'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirect
  });
  const r = await fetch('https://api.fitbit.com/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization:  `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  if (!r.ok) {
    const text = await r.text();
    return res.status(500).send(`Token exchange failed (${r.status}):\n${text}`);
  }
  const tok = await r.json();
  // tok = { access_token, refresh_token, expires_in, scope, user_id, token_type }

  await pool.query(
    `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, scope, user_id, updated_at)
     VALUES ('fitbit', $1, $2, NOW() + ($3 || ' seconds')::interval, $4, $5, NOW())
     ON CONFLICT (provider) DO UPDATE SET
       access_token=EXCLUDED.access_token, refresh_token=EXCLUDED.refresh_token,
       expires_at=EXCLUDED.expires_at, scope=EXCLUDED.scope,
       user_id=EXCLUDED.user_id, updated_at=NOW()`,
    [tok.access_token, tok.refresh_token, String(tok.expires_in || 28800), tok.scope || SCOPES, tok.user_id || null]
  );
  // Clean up the pending row
  await pool.query(`DELETE FROM oauth_tokens WHERE provider='fitbit_pending'`);

  return res.status(200).send(`<!doctype html><meta charset="utf-8">
<title>Fitbit connected</title>
<body style="font-family:system-ui;background:#1a1a2e;color:#eee;padding:2rem;text-align:center">
<h1>✅ Fitbit connected</h1>
<p>Refresh token stored. Daily sync will start at the next cron tick.</p>
<p><a href="/" style="color:#e94560">← Back to dashboard</a></p>
</body>`);
}

module.exports = (req, res) => {
  switch (req.query.action) {
    case 'authorize': return authorize(req, res);
    case 'callback':  return callback(req, res);
    default: return res.status(404).json({ error: 'unknown fitbit action', expected: ['authorize', 'callback'] });
  }
};
