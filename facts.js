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

// A fact with a UTC `timestamp` happened at a known moment, so it belongs on the
// date that moment falls on in this device's time zone. A fact with only a `date`
// is a calendar date and shows on that day everywhere.
function onLocalCalendar(fact) {
  if (!fact.timestamp) return fact;

  const moment = new Date(fact.timestamp);
  const year = moment.getFullYear();
  const month = moment.getMonth() + 1;
  const day = moment.getDate();
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { ...fact, year, month, day, date };
}

// Most important first; within the same importance, oldest first.
function getFactsForDay(month, day) {
  return loadFacts()
    .map(onLocalCalendar)
    .filter((fact) => fact.month === month && fact.day === day)
    .sort((a, b) => b.importance - a.importance || a.year - b.year);
}

module.exports = { getFactsForDay };
