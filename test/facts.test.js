// Checks bitcoin_facts.json and that timestamped facts land on the local date.
// Run with: node --test test/facts.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const facts = require(path.join(__dirname, '..', 'bitcoin_facts.json'));
const { getFactsForDay } = require(path.join(__dirname, '..', 'facts.js'));

// Node re-reads TZ whenever it changes
function inTimeZone(zone, fn) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

const titlesOn = (zone, month, day) => inTimeZone(zone, () => getFactsForDay(month, day).map((f) => f.title));

test('every fact is well formed', () => {
  const ids = new Set();
  for (const fact of facts) {
    assert.ok(!ids.has(fact.id), `duplicate id ${fact.id}`);
    ids.add(fact.id);
    assert.match(fact.date, /^\d{4}-\d{2}-\d{2}$/, `#${fact.id} date`);
    const [year, month, day] = fact.date.split('-').map(Number);
    assert.deepStrictEqual([fact.year, fact.month, fact.day], [year, month, day], `#${fact.id} year/month/day must match date`);
    assert.ok(fact.title && fact.description && fact.source_url, `#${fact.id} missing text or source`);
  }
});

test('timestamps are UTC and on the stored UTC date', () => {
  for (const fact of facts.filter((f) => f.timestamp)) {
    assert.match(fact.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, `#${fact.id} timestamp must be UTC (ending in Z)`);
    assert.strictEqual(fact.timestamp.slice(0, 10), fact.date, `#${fact.id} date must be the UTC date of its timestamp`);
  }
});

test('fourth halving (00:09 UTC Apr 20, 2024) is Apr 19 in New York, Apr 20 in London', () => {
  assert.ok(titlesOn('America/New_York', 4, 19).includes('Fourth Bitcoin Halving'));
  assert.ok(!titlesOn('America/New_York', 4, 20).includes('Fourth Bitcoin Halving'));
  assert.ok(titlesOn('Europe/London', 4, 20).includes('Fourth Bitcoin Halving'));
  assert.ok(titlesOn('UTC', 4, 20).includes('Fourth Bitcoin Halving'));
});

test('date-only facts show on the same day in every time zone', () => {
  for (const zone of ['America/Los_Angeles', 'UTC', 'Asia/Tokyo', 'Pacific/Auckland']) {
    assert.ok(titlesOn(zone, 5, 22).includes('Bitcoin Pizza Day'), zone);
  }
});

test('local year, month and day are what the history pop-up displays', () => {
  const [fact] = inTimeZone('America/New_York', () =>
    getFactsForDay(4, 19).filter((f) => f.title === 'Fourth Bitcoin Halving'));
  assert.deepStrictEqual([fact.year, fact.month, fact.day, fact.date], [2024, 4, 19, '2024-04-19']);
});

test('every fact appears on exactly one day of the year in any time zone', () => {
  for (const zone of ['America/Los_Angeles', 'UTC', 'Asia/Tokyo']) {
    inTimeZone(zone, () => {
      let seen = 0;
      for (let m = 1; m <= 12; m++) {
        for (let d = 1; d <= 31; d++) seen += getFactsForDay(m, d).length;
      }
      assert.strictEqual(seen, facts.length, zone);
    });
  }
});
