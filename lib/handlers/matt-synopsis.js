// /api/fitness/matt-synopsis?mode=bulk|cut|tri|balanced&criticality=gentle|balanced|blunt&from=YYYY-MM-DD&to=YYYY-MM-DD
// (legacy ?days=N still accepted)
// Pulls the date range of all sources, builds a context block, and asks Claude
// (in Matthew's voice) for a focused synopsis with both positives and concerns
// scaled to Paul's current training mode. Uses Haiku 4.5 — fast + cheap
// (~$0.002 per generation) so unattended use doesn't burn credits.

const { pool } = require('../db');
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function verifyToken(token) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return true;
  const secret = process.env.AUTH_SECRET || 'nutrition-dashboard-2026';
  const expected = crypto.createHash('sha256').update(password + secret).digest('hex');
  return token === expected;
}

async function safeQuery(sql, params) {
  try { return (await pool.query(sql, params)).rows; }
  catch (e) { if (e.code === '42P01') return []; throw e; }
}

// Mode-specific targets — for Paul (~67kg, age 56, longevity + triathlon focus)
const MODES = {
  bulk: {
    label: 'Bulk',
    targets: {
      calories:   '+200 to +500 above maintenance (~2400-2700 kcal/day)',
      protein_g:  '120-150 g (1.8-2.2 g/kg)',
      sleep_hrs:  '7.5+ for recovery',
      tsb:        'around -10 to -20 (absorbing training)'
    },
    focus: 'progressive overload, recovery, calorie consistency'
  },
  cut: {
    label: 'Cut',
    targets: {
      calories:   '-300 to -500 deficit (~1700-1900 kcal/day)',
      protein_g:  '135-160 g (2.0-2.4 g/kg) to preserve lean mass',
      sleep_hrs:  '7.5+ — sleep debt accelerates lean-mass loss',
      tsb:        'closer to 0 (maintain, don\'t add stress)'
    },
    focus: 'protein hits, sleep consistency, maintain volume not intensity'
  },
  tri: {
    label: 'Triathlon',
    targets: {
      calories:   'matched to weekly TSS — surplus on long days, neutral otherwise',
      protein_g:  '110-130 g',
      carbs_g:    '335-470 g (5-7 g/kg) for endurance fueling',
      sleep_hrs:  '8+ during build phases',
      tsb:        '-5 to -15 in build, +5 to +15 in taper'
    },
    focus: 'CTL trending up, recovery between hard sessions, carb fueling'
  },
  balanced: {
    label: 'Balanced',
    targets: {
      calories:   'maintenance (~2100-2300 kcal/day)',
      protein_g:  '110-130 g (1.6 g/kg)',
      sleep_hrs:  '7+',
      tsb:        '-5 to +5 (steady state)'
    },
    focus: 'consistency, no big swings, sleep + protein floor'
  }
};

const CRITICALITY_INSTRUCTIONS = {
  gentle:   'Lead with what\'s working. Frame any concerns as gentle nudges. Tone: encouraging coach.',
  balanced: 'Equal weight to wins and concerns. Tone: matter-of-fact strategist.',
  blunt:    'Lead with what\'s broken. Be direct. Skip the encouragement. Tone: no-bullshit coach who has 5 minutes.'
};

async function pullContext(from, to) {
  const range = 'WHERE date BETWEEN $1 AND $2';
  const params = [from, to];
  const rows = await Promise.all([
    safeQuery(`SELECT date, calories, protein_g, carbs_g, fat_g, fiber_g FROM daily_nutrition ${range} AND calories > 0 ORDER BY date`, params),
    safeQuery(`SELECT date, sleep_hours, sleep_score, sleep_source, hrv_ms, resting_hr, steps, body_battery, stress_score FROM daily_metrics ${range} ORDER BY date`, params),
    safeQuery(`SELECT date, ROUND(ctl::numeric, 1) ctl, ROUND(atl::numeric, 1) atl, ROUND(tsb::numeric, 1) tsb FROM fitness_load ${range} ORDER BY date`, params),
    safeQuery(
      `SELECT s.date,
              SUM(COALESCE(es.standard_lbs, ws.weight_lbs) * ws.reps)::int AS volume_lbs,
              COUNT(*) AS sets,
              ARRAY_AGG(DISTINCT ws.category) FILTER (WHERE ws.category IS NOT NULL) AS categories
       FROM workout_sets ws
       JOIN workout_sessions s ON s.id = ws.session_id
       LEFT JOIN exercise_standards es ON es.exercise = ws.exercise
       WHERE s.date BETWEEN $1 AND $2 AND ws.reps IS NOT NULL
       GROUP BY s.date ORDER BY s.date`,
      params
    ),
    safeQuery(
      `SELECT date,
              AVG(CASE WHEN period='AM' THEN restedness END)     AS rested_am,
              AVG(CASE WHEN period='PM' THEN restedness END)     AS rested_pm,
              AVG(CASE WHEN period='AM' THEN doms END)           AS doms_am,
              AVG(CASE WHEN period='AM' THEN mood END)           AS mood_am,
              AVG(CASE WHEN period='AM' THEN hunger END)         AS hunger_am,
              AVG(CASE WHEN period='AM' THEN back_stiffness END) AS back_am,
              AVG(CASE WHEN period='AM' THEN general_health END) AS gh_am
       FROM health_checkins
       ${range}
       GROUP BY date ORDER BY date`,
      params
    ),
    safeQuery(`SELECT date, ROUND((weight_kg * 2.20462)::numeric, 1) AS weight_lbs FROM weight ${range} ORDER BY date`, params)
  ]);
  return {
    nutrition: rows[0], metrics: rows[1], load: rows[2],
    workouts: rows[3], checkins: rows[4], weight: rows[5]
  };
}

function summarize(ctx, days) {
  const fmt = d => (d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0]);
  const avg = arr => arr.length ? arr.reduce((a,b)=>a+b,0) / arr.length : null;
  const nuts = ctx.nutrition;
  const mets = ctx.metrics.filter(m => m.sleep_hours);
  const wts  = ctx.weight;

  return {
    days_window: days,
    nutrition: {
      days_logged:  nuts.length,
      avg_calories: Math.round(avg(nuts.map(n => +n.calories || 0)) || 0),
      avg_protein_g: Math.round(avg(nuts.map(n => +n.protein_g || 0)) || 0),
      avg_carbs_g:   Math.round(avg(nuts.map(n => +n.carbs_g || 0)) || 0),
      avg_fat_g:     Math.round(avg(nuts.map(n => +n.fat_g || 0)) || 0),
      avg_fiber_g:   Math.round(avg(nuts.map(n => +n.fiber_g || 0)) || 0)
    },
    sleep: {
      days_with_data: mets.length,
      avg_hours:   +(avg(mets.map(m => +m.sleep_hours))?.toFixed(2) || 0),
      avg_score:   Math.round(avg(mets.filter(m=>m.sleep_score).map(m => +m.sleep_score)) || 0),
      source:      mets[0]?.sleep_source || null,
      below_7_hr_days: mets.filter(m => +m.sleep_hours < 7).length,
      latest:      mets.length ? { date: fmt(mets[mets.length-1].date), hrs: +mets[mets.length-1].sleep_hours } : null
    },
    recovery: {
      avg_hrv:        Math.round(avg(ctx.metrics.filter(m=>m.hrv_ms).map(m => +m.hrv_ms)) || 0),
      avg_resting_hr: Math.round(avg(ctx.metrics.filter(m=>m.resting_hr).map(m => +m.resting_hr)) || 0)
    },
    training_load: ctx.load.length ? {
      latest_ctl: +ctx.load[ctx.load.length-1].ctl,
      latest_atl: +ctx.load[ctx.load.length-1].atl,
      latest_tsb: +ctx.load[ctx.load.length-1].tsb,
      ctl_trend:  ctx.load.length >= 2 ? +(ctx.load[ctx.load.length-1].ctl - ctx.load[0].ctl).toFixed(1) : null
    } : null,
    workouts: {
      sessions: ctx.workouts.length,
      total_volume_lbs: ctx.workouts.reduce((s,w) => s + (+w.volume_lbs || 0), 0),
      categories_hit: [...new Set(ctx.workouts.flatMap(w => w.categories || []))]
    },
    subjective: {
      checkin_days: ctx.checkins.length,
      avg_rested_am: +(avg(ctx.checkins.filter(c=>c.rested_am).map(c => +c.rested_am))?.toFixed(1) || 0),
      avg_doms_am:   +(avg(ctx.checkins.filter(c=>c.doms_am).map(c => +c.doms_am))?.toFixed(1) || 0),
      avg_mood_am:   +(avg(ctx.checkins.filter(c=>c.mood_am).map(c => +c.mood_am))?.toFixed(1) || 0),
      back_flagged_days: ctx.checkins.filter(c => +c.back_am > 3).length
    },
    weight: wts.length ? {
      latest:  +wts[wts.length-1].weight_lbs,
      change:  wts.length >= 2 ? +(wts[wts.length-1].weight_lbs - wts[0].weight_lbs).toFixed(1) : null
    } : null
  };
}

const SYSTEM_PROMPT = `You are Matthew — Paul's personal training strategist and nutrition scientist. 💪
- Vibe: science-backed, data-obsessed, motivational
- Paul is 56, ~150 lbs, longevity-focused (Outlive), triathlon + skiing + sailing/foiling
- Health flags: back surgery history (sitting > 4 hrs/day = bad), life-threatening crustacean allergy
- He values brevity (dyslexic, prefers data-dense, no walls of text)

You are reviewing his last week of metrics. Give him a focused synopsis using **markdown**:

## ✅ What's working
- 2-4 specific bullets backed by numbers from the data

## ⚠️ Watch
- 1-3 specific bullets where he's missing the target for his current mode
- Quote the actual number vs the target

## 🎯 This week's call
- One sentence: the single most important thing to fix or sustain

Reference the mode targets as the bar to clear. Use his actual numbers. Don't repeat data he can already see on the dashboard — focus on patterns and decisions.`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (process.env.DASHBOARD_PASSWORD && !verifyToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const mode = (req.query.mode || 'balanced').toLowerCase();
  const criticality = (req.query.criticality || 'balanced').toLowerCase();

  // Range: prefer ?from/?to (matches dashboard date picker). Fall back to ?days for legacy callers.
  let from = req.query.from, to = req.query.to;
  if (!from || !to) {
    const days = Math.min(60, Math.max(3, parseInt(req.query.days) || 7));
    const end = new Date();
    const start = new Date(end); start.setDate(start.getDate() - (days - 1));
    from = start.toISOString().slice(0, 10);
    to   = end.toISOString().slice(0, 10);
  }
  const days = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;

  if (!MODES[mode]) return res.status(400).json({ error: 'unknown mode', expected: Object.keys(MODES) });
  if (!CRITICALITY_INSTRUCTIONS[criticality]) {
    return res.status(400).json({ error: 'unknown criticality', expected: Object.keys(CRITICALITY_INSTRUCTIONS) });
  }

  try {
    const ctx = await pullContext(from, to);
    const summary = summarize(ctx, days);

    const userPrompt = `Mode: **${MODES[mode].label}**
Targets for this mode:
${Object.entries(MODES[mode].targets).map(([k,v]) => `  - ${k}: ${v}`).join('\n')}
Mode focus: ${MODES[mode].focus}

Tone: ${CRITICALITY_INSTRUCTIONS[criticality]}

Window: ${from} → ${to} (${days} days)
Paul's data:
\`\`\`json
${JSON.stringify(summary, null, 2)}
\`\`\``;

    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',  // fast + cheap (~$0.002/call); plenty for synopsis work
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const text = resp.content[0]?.text || '';
    return res.status(200).json({
      success: true,
      mode, criticality, from, to, days,
      summary,           // returned so frontend can show "based on these numbers"
      synopsis: text,
      generated_at: new Date().toISOString(),
      usage: resp.usage  // input/output tokens for cost monitoring
    });
  } catch (e) {
    console.error('matt-synopsis error:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
};
