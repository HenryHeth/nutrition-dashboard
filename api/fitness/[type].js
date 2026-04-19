// /api/fitness/<type>?<query>
// Single Vercel serverless function that dispatches to handlers in lib/handlers/.
// Consolidated to fit Hobby plan's 12-function cap (was 8 separate files in /api).
//
// Routes:
//   /api/fitness/overlays           — main chart line overlays (sleep, CTL/ATL/TSB, restedness, DOMS)
//   /api/fitness/training-volume    — daily training volume + AM DOMS
//   /api/fitness/weekly-volume      — weekly stacked volume per category
//   /api/fitness/body-composition   — lean mass + BF% trend
//   /api/fitness/checkins           — SignalCheck pivoted by day with sleep_score
//   /api/fitness/habits             — last-N-day habit compliance grid
//   /api/fitness/workout-audit      — per-exercise stats for the audit screen
//   /api/fitness/exercise-standards — POST/DELETE upsert/remove a bodyweight standard

const handlers = {
  'overlays':            require('../../lib/handlers/overlays'),
  'training-volume':     require('../../lib/handlers/training-volume'),
  'weekly-volume':       require('../../lib/handlers/weekly-volume'),
  'body-composition':    require('../../lib/handlers/body-composition'),
  'checkins':            require('../../lib/handlers/checkins'),
  'habits':              require('../../lib/handlers/habits'),
  'workout-audit':       require('../../lib/handlers/workout-audit'),
  'exercise-standards':  require('../../lib/handlers/exercise-standards'),
  'matt-synopsis':       require('../../lib/handlers/matt-synopsis'),
  'sync':                require('../../lib/handlers/sync')
};

module.exports = (req, res) => {
  const h = handlers[req.query.type];
  if (!h) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(404).json({
      error: 'unknown fitness type',
      type: req.query.type,
      available: Object.keys(handlers)
    });
  }
  return h(req, res);
};
