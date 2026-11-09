// "This day in Bitcoin history" facts, read from bitcoin_facts.json in the app bundle.
const fs = require('fs');
const path = require('path');

let facts = null;

function loadFacts() {
  if (!facts) {
    facts = JSON.parse(fs.readFileSync(path.join(__dirname, 'bitcoin_facts.json'), 'utf8'));
  }
  return facts;
}

// Most important first; within the same importance, oldest first.
function getFactsForDay(month, day) {
  return loadFacts()
    .filter((fact) => fact.month === month && fact.day === day)
    .sort((a, b) => b.importance - a.importance || a.year - b.year);
}

module.exports = { getFactsForDay };
