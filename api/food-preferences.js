const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.NEON_DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Auto-create table if needed
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS food_preferences (
      id SERIAL PRIMARY KEY,
      person VARCHAR(50) NOT NULL,
      submitted_at TIMESTAMPTZ DEFAULT NOW(),
      top3 TEXT,
      hatefoods TEXT,
      proteins TEXT[],
      meal_types TEXT[],
      sides TEXT[],
      smoothie VARCHAR(50),
      snacks TEXT,
      cook_time VARCHAR(50),
      batch_cook VARCHAR(50),
      repeats VARCHAR(50),
      wishmore TEXT,
      notes TEXT,
      raw_json JSONB
    )
  `);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await ensureTable();

    if (req.method === 'POST') {
      const d = req.body;
      if (!d || !d.person) {
        return res.status(400).json({ error: 'Missing person field' });
      }

      // Upsert — replace if same person submits again
      await pool.query(`
        DELETE FROM food_preferences WHERE LOWER(person) = LOWER($1)
      `, [d.person]);

      await pool.query(`
        INSERT INTO food_preferences 
          (person, top3, hatefoods, proteins, meal_types, sides, smoothie, snacks, cook_time, batch_cook, repeats, wishmore, notes, raw_json)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `, [
        d.person,
        d.top3 || '',
        d.hatefoods || '',
        d.proteins || [],
        d.mealTypes || [],
        d.sides || [],
        d.smoothie || '',
        d.snacks || '',
        d.cookTime || '',
        d.batchCook || '',
        d.repeats || '',
        d.wishmore || '',
        d.notes || '',
        JSON.stringify(d)
      ]);

      return res.status(200).json({ ok: true, person: d.person });
    }

    if (req.method === 'GET') {
      const result = await pool.query('SELECT * FROM food_preferences ORDER BY submitted_at DESC');
      return res.status(200).json(result.rows);
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('food-preferences error:', err);
    res.status(500).json({ error: err.message });
  }
};
