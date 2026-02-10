const crypto = require('crypto');

// Simple token generation - hash of password + secret
function generateToken(password) {
  const secret = process.env.AUTH_SECRET || 'nutrition-dashboard-2026';
  return crypto.createHash('sha256').update(password + secret).digest('hex');
}

function verifyToken(token) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return false;
  const expectedToken = generateToken(password);
  return token === expectedToken;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { password } = req.body;
    const correctPassword = process.env.DASHBOARD_PASSWORD;
    
    if (!correctPassword) {
      return res.status(500).json({ error: 'Auth not configured' });
    }
    
    if (password === correctPassword) {
      const token = generateToken(password);
      return res.status(200).json({ success: true, token });
    } else {
      return res.status(401).json({ success: false, error: 'Invalid password' });
    }
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: error.message });
  }
};

// Export for use in other API routes
module.exports.verifyToken = verifyToken;
// Auth v1
