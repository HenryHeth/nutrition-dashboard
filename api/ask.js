const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.NEON_DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function verifyToken(token) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return true; // No auth configured = allow all
  const secret = process.env.AUTH_SECRET || 'nutrition-dashboard-2026';
  const expectedToken = crypto.createHash('sha256').update(password + secret).digest('hex');
  return token === expectedToken;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Check auth
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (process.env.DASHBOARD_PASSWORD && !verifyToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { question, dateRange, detailLevel = 'medium', withHumour = false } = req.body;
    
    // Get nutrition stats
    const statsResult = await pool.query(`
      SELECT 
        COUNT(*) as days_logged,
        ROUND(AVG(calories)) as avg_calories,
        ROUND(AVG(protein_g)) as avg_protein,
        ROUND(AVG(carbs_g)) as avg_carbs,
        ROUND(AVG(fat_g)) as avg_fat
      FROM daily_nutrition
      WHERE date >= $1 AND date <= $2
    `, [dateRange?.start || '2021-01-01', dateRange?.end || new Date().toISOString().split('T')[0]]);
    
    // Get recent food entries
    const foodsResult = await pool.query(`
      SELECT date, meal, food_name, calories
      FROM food_entries
      WHERE date >= $1 AND date <= $2
      ORDER BY date DESC, meal
      LIMIT 200
    `, [dateRange?.start || '2021-01-01', dateRange?.end || new Date().toISOString().split('T')[0]]);
    
    // Get unique foods
    const uniqueFoodsResult = await pool.query(`
      SELECT DISTINCT food_name
      FROM food_entries
      WHERE date >= $1 AND date <= $2
      ORDER BY food_name
      LIMIT 200
    `, [dateRange?.start || '2021-01-01', dateRange?.end || new Date().toISOString().split('T')[0]]);
    
    const stats = statsResult.rows[0];
    const foods = foodsResult.rows;
    const uniqueFoods = uniqueFoodsResult.rows.map(r => r.food_name);
    
    // Build prompt
    const detailInstructions = {
      low: 'Be very brief. 2-3 sentences max.',
      medium: 'Give a balanced answer. Under 150 words.',
      high: 'Provide comprehensive analysis with examples.'
    };
    
    const humourInstruction = withHumour 
      ? '\n\nTONE: Add a dash of humour — be witty, throw in a food pun or playful observation. Keep it light and fun while still being helpful.'
      : '';
    
    const prompt = `You are Henry, Paul's AI assistant. Answer this nutrition question.${humourInstruction}

${detailInstructions[detailLevel]}

Date range: ${dateRange?.start || 'all'} to ${dateRange?.end || 'now'}
Days logged: ${stats.days_logged}
Averages: ${stats.avg_calories} cal/day, ${stats.avg_protein}g protein, ${stats.avg_carbs}g carbs, ${stats.avg_fat}g fat

=== UNIQUE FOODS (${uniqueFoods.length} items) ===
${uniqueFoods.join(', ')}

=== RECENT FOODS ===
${foods.map(f => `${f.date}: ${f.food_name}`).join('\n')}

Question: ${question}`;

    // Call Anthropic API directly
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    
    const data = await response.json();
    
    // Debug: log any errors from Anthropic
    if (data.error) {
      console.error('Anthropic error:', data.error);
      return res.status(200).json({ answer: 'AI error: ' + (data.error.message || JSON.stringify(data.error)) });
    }
    
    const answer = data.content?.[0]?.text || 'Sorry, I couldn\'t generate a response.';
    
    res.status(200).json({ answer });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ answer: 'Error: ' + error.message });
  }
};
