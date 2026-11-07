import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeywords, cleanKeywords, stripSuffix, MAX_KEYWORDS } from '../src/core/keywords.js';

test('Green Glen: spaced, joined and doubled-letter typos', () => {
  assert.deepEqual(generateKeywords('Green Glen'), ['green glen', 'greenglen', 'green glenn', 'gren glen']);
});
test('suffix kept and stripped where present', () => {
  assert.deepEqual(generateKeywords('Green Glen Layout'), ['green glen layout', 'greenglenlayout', 'green glen', 'greenglen', 'green glenn', 'gren glen']);
  assert.deepEqual(generateKeywords('HSR Layout'), ['hsr layout', 'hsrlayout', 'hsr']);
  assert.deepEqual(generateKeywords('Sarjapur Road'), ['sarjapur road', 'sarjapurroad', 'sarjapur', 'sarjapurr']);
  assert.deepEqual(generateKeywords('Outer Ring Road'), ['outer ring road', 'outerringroad', 'outer ring', 'outerring', 'outer ringg']);
  assert.equal(stripSuffix('rt nagar'), 'rt');
  assert.deepEqual(generateKeywords('MG Road'), ['mg road', 'mgroad'], 'core shorter than 3 letters is dropped');
});
test('single words, punctuation, casing, empty input', () => {
  assert.deepEqual(generateKeywords('Koramangala'), ['koramangala']);
  assert.deepEqual(generateKeywords('  BELLANDUR!! '), ['bellandur', 'bellandurr', 'belandur']);
  assert.deepEqual(generateKeywords(''), []);
  assert.deepEqual(generateKeywords('!!'), []);
});
test('deduped and capped', () => {
  const k = generateKeywords('Kaggadaspura Doddanekkundi Village');
  assert.ok(k.length <= MAX_KEYWORDS); assert.equal(new Set(k).size, k.length);
});
test('cleanKeywords normalises user edits', () => {
  assert.deepEqual(cleanKeywords('Green Glen\n green-glen , ab\n\nGREEN GLEN'), ['green glen']);
  assert.deepEqual(cleanKeywords(['HSR', 'hsr layout', 'x']), ['hsr', 'hsr layout']);
});
