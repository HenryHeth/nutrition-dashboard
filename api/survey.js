const fs = require('fs');
const path = require('path');

module.exports = (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'family-survey.html'), 'utf8');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
};
