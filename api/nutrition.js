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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Check auth
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (process.env.DASHBOARD_PASSWORD && !verifyToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { from, to } = req.query;
    
    let query = 'SELECT * FROM daily_nutrition';
    const params = [];
    
    if (from && to) {
      query += ' WHERE date >= $1 AND date <= $2';
      params.push(from, to);
    }
    
    query += ' ORDER BY date ASC';
    
    const result = await pool.query(query, params);
    
    // Format dates as YYYY-MM-DD strings
    const data = result.rows.map(row => ({
      ...row,
      date: row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date.split('T')[0]
    }));
    
    res.status(200).json({
      success: true,
      count: data.length,
      data: data
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};
