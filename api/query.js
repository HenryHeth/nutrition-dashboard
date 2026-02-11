const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.NEON_DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Auth helper
function verifyToken(token) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return true;
  const secret = process.env.AUTH_SECRET || 'nutrition-dashboard-2026';
  const expectedToken = crypto.createHash('sha256').update(password + secret).digest('hex');
  return token === expectedToken;
}

// Query classifier - detects if question needs SQL aggregation
function isAggregationQuery(question) {
  const q = question.toLowerCase();
  const patterns = [
    /how many/i,
    /how much/i,
    /count/i,
    /total/i,
    /sum/i,
    /average/i,
    /avg/i,
    /times did/i,
    /days did/i,
    /frequency/i,
    /often/i,
    /number of/i
  ];
  return patterns.some(p => p.test(q));
}

// SQL Validator - only allow safe SELECT queries
function validateSQL(sql) {
  const normalized = sql.trim().toLowerCase();
  
  // Must start with SELECT
  if (!normalized.startsWith('select')) {
    return { valid: false, error: 'Only SELECT queries allowed' };
  }
  
  // Block dangerous keywords
  const blocked = ['insert', 'update', 'delete', 'drop', 'alter', 'create', 'truncate', 'grant', 'revoke', ';--', 'union'];
  for (const word of blocked) {
    if (normalized.includes(word)) {
      return { valid: false, error: `Blocked keyword: ${word}` };
    }
  }
  
  // Must reference our tables
  const allowedTables = ['food_entries', 'daily_nutrition', 'weight'];
  const hasValidTable = allowedTables.some(t => normalized.includes(t));
  if (!hasValidTable) {
    return { valid: false, error: 'Query must reference food_entries, daily_nutrition, or weight' };
  }
  
  return { valid: true };
}

// Text-to-SQL prompt
const TEXT_TO_SQL_PROMPT = `You are a SQL query generator for a nutrition database. Generate a PostgreSQL query for the user's question.

SCHEMA:
- food_entries: id, date (DATE), meal (TEXT), food_name (TEXT), quantity (REAL), unit (TEXT), calories (REAL), protein (REAL), carbs (REAL), fat (REAL), fiber (REAL), sugar (REAL), sodium (REAL)
- daily_nutrition: date (DATE PRIMARY KEY), calories (REAL), protein_g (REAL), carbs_g (REAL), fat_g (REAL), fiber_g (REAL), sugar_g (REAL), sodium_mg (REAL)
- weight: date (DATE), weight_kg (REAL)

RULES:
1. Only SELECT queries (no INSERT, UPDATE, DELETE)
2. Use ILIKE with % for fuzzy food name matching
3. For year ranges: date >= '2025-01-01' AND date < '2026-01-01'
4. For "how many times" → COUNT(DISTINCT date) for days, COUNT(*) for entries
5. For "how much" → SUM(column)
6. Return ONLY the SQL query, no explanation, no markdown

EXAMPLES:
Q: How many times did I drink gin last year?
SELECT COUNT(DISTINCT date) as days, COUNT(*) as entries FROM food_entries WHERE food_name ILIKE '%gin%' AND NOT food_name ILIKE '%ginger%' AND date >= '2025-01-01' AND date < '2026-01-01';

Q: Total protein in January 2026?
SELECT SUM(protein_g) as total_protein FROM daily_nutrition WHERE date >= '2026-01-01' AND date < '2026-02-01';

Q: How many beers did I have in 2025?
SELECT COUNT(DISTINCT date) as days, COUNT(*) as entries FROM food_entries WHERE (food_name ILIKE '%beer%' OR food_name ILIKE '%lager%' OR food_name ILIKE '%ipa%' OR food_name ILIKE '%ale%') AND date >= '2025-01-01' AND date < '2026-01-01';

Q: Show me all gin entries
SELECT date, food_name, calories FROM food_entries WHERE food_name ILIKE '%gin%' AND NOT food_name ILIKE '%ginger%' ORDER BY date DESC LIMIT 50;

USER QUESTION: {question}
SQL:`;

// Generate SQL from natural language
async function generateSQL(question) {
  const prompt = TEXT_TO_SQL_PROMPT.replace('{question}', question);
  
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }]
  });
  
  let sql = response.content[0].text.trim();
  
  // Clean up common issues
  sql = sql.replace(/```sql/gi, '').replace(/```/g, '').trim();
  
  // Remove trailing semicolon for pg
  if (sql.endsWith(';')) {
    sql = sql.slice(0, -1);
  }
  
  return sql;
}

// Format results for display
function formatResults(question, sql, rows, executionTime) {
  const q = question.toLowerCase();
  
  let response = '';
  
  if (rows.length === 0) {
    response = "No matching entries found.";
  } else if (rows.length === 1 && (rows[0].days !== undefined || rows[0].entries !== undefined || rows[0].count !== undefined)) {
    // Aggregation result
    const r = rows[0];
    if (r.days !== undefined && r.entries !== undefined) {
      response = `Found ${r.entries} entries across ${r.days} different days.`;
      if (r.total) {
        response += ` Total quantity: ${r.total}`;
      }
    } else if (r.count !== undefined) {
      response = `Count: ${r.count}`;
    } else if (r.total_protein !== undefined) {
      response = `Total protein: ${Math.round(r.total_protein)}g`;
    } else if (r.total_calories !== undefined) {
      response = `Total calories: ${Math.round(r.total_calories)}`;
    } else {
      response = JSON.stringify(r);
    }
  } else {
    // List of entries
    response = `Found ${rows.length} entries:\n\n`;
    rows.slice(0, 20).forEach(r => {
      if (r.date && r.food_name) {
        const date = r.date instanceof Date ? r.date.toISOString().split('T')[0] : r.date;
        response += `• ${date}: ${r.food_name}`;
        if (r.calories) response += ` (${r.calories} cal)`;
        response += '\n';
      }
    });
    if (rows.length > 20) {
      response += `\n... and ${rows.length - 20} more entries`;
    }
  }
  
  return {
    answer: response,
    sql: sql,
    rowCount: rows.length,
    executionTimeMs: executionTime,
    method: 'sql'
  };
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
    const { question } = req.body;
    
    if (!question) {
      return res.status(400).json({ error: 'Question required' });
    }
    
    // Check if this is an aggregation query
    const useSQL = isAggregationQuery(question);
    
    if (!useSQL) {
      // Fall back to existing LLM approach for non-aggregation questions
      return res.status(200).json({ 
        answer: 'This question is better suited for the general Ask Henry feature.',
        method: 'redirect',
        suggestion: 'Try the main Ask Henry feature for this type of question.'
      });
    }
    
    // Generate SQL
    const sql = await generateSQL(question);
    
    // Validate SQL
    const validation = validateSQL(sql);
    if (!validation.valid) {
      return res.status(400).json({ 
        error: 'Generated SQL failed validation',
        reason: validation.error,
        sql: sql
      });
    }
    
    // Execute query
    const startTime = Date.now();
    const result = await pool.query(sql);
    const executionTime = Date.now() - startTime;
    
    // Format and return results
    const formatted = formatResults(question, sql, result.rows, executionTime);
    
    return res.status(200).json(formatted);
    
  } catch (error) {
    console.error('Query error:', error);
    return res.status(500).json({ 
      error: 'Query failed',
      message: error.message 
    });
  }
};
