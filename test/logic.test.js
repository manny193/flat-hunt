// Port of docs/prototype-logic-test.js to node:test, plus parsing edge cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract, moneyMentions, processItems, makeContext, matchAreas, keywordList, normalizeRaw, normUrl, watchedGroups, isKnownGroup } from '../src/core/logic.js';
import { SAMPLES, GREEN_GLEN } from './helpers.js';

const ctx = (over = {}) => makeContext([{ id: 1, ...GREEN_GLEN }], {
  keywordFilter: true,
  groups: [{ name: 'Bellandur Flats & Flatmates (sample)', url: 'https://facebook.com/groups/111', active: true }, { name: 'Bangalore Rentals HSR Bellandur (sample)', url: '', active: true }],
  ...over,
});
const pickEx = e => ({ rent: e.rent, dep: e.deposit, dm: e.depositMonths, mt: e.maintenance, bhk: e.bhk, type: e.type, kind: e.kind, brok: e.brokerage, furn: e.furnishing, g: e.gender, av: e.availableFrom, ph: e.phones });

test('extract() on the prototype samples matches the prototype baseline', () => {
  const expected = [
    { rent: 32000, dep: 200000, dm: null, mt: 2500, bhk: 2, type: 'flat', kind: 'offer', brok: 'no', furn: 'semi', g: null, av: '1st Dec', ph: ['9000011111'] },
    { rent: 32000, dep: 200000, dm: null, mt: 2500, bhk: 2, type: 'flat', kind: 'offer', brok: 'no', furn: 'semi', g: null, av: '1st Dec', ph: ['9000011111'] },
    { rent: 14000, dep: 40000, dm: null, mt: null, bhk: 3, type: 'flatmate', kind: 'offer', brok: null, furn: 'fully', g: 'female', av: null, ph: ['9000022222'] },
    { rent: 20000, dep: null, dm: null, mt: null, bhk: 1, type: 'flat', kind: 'seeking', brok: null, furn: null, g: null, av: null, ph: [] },
    { rent: 48000, dep: 300000, dm: null, mt: null, bhk: 3, type: 'flat', kind: 'offer', brok: 'yes', furn: 'fully', g: null, av: null, ph: ['9000033333'] },
    { rent: 30000, dep: 150000, dm: null, mt: null, bhk: 2, type: 'flat', kind: 'offer', brok: 'yes', furn: 'unfurnished', g: null, av: null, ph: ['9000033333'] },
    { rent: 25000, dep: null, dm: null, mt: null, bhk: 1, type: 'flat', kind: 'offer', brok: 'no', furn: null, g: null, av: null, ph: ['9000044444'] },
  ];
  SAMPLES.forEach((s, i) => assert.deepEqual(pickEx(extract(s.text)), expected[i], s.text));
});

test('processItems() on samples: report and listings match the prototype', () => {
  const r = processItems(SAMPLES, 'phone', [], ctx(), 1_800_000_000_000);
  const { at, byArea, unscrapable, ...rest } = r.report;
  assert.deepEqual(rest, {
    source: 'phone', total: 7, noText: 0, offTopic: 1, seeking: 1, dupes: 0, newListings: 5, merged: 1, known: 3, outside: 3,
    outsideGroups: { 'Flats without Brokers Bangalore (sample)': 1, 'Flat and Flatmates Bangalore (sample)': 2 },
    knownGroups: { 'Bellandur Flats & Flatmates (sample)': 1, 'Bangalore Rentals HSR Bellandur (sample)': 2 },
  });
  assert.deepEqual(byArea, { 'Green Glen': 6 });
  assert.deepEqual(r.changed.map(l => [l.rent, l.bhk, l.seenCount, l.groups.length, l.kind, l.outsideWatched]), [
    [32000, 2, 2, 2, 'offer', false], [14000, 3, 1, 1, 'offer', true], [20000, 1, 1, 1, 'seeking', true], [48000, 3, 1, 1, 'offer', false], [30000, 2, 1, 1, 'offer', false],
  ]);
  assert.ok(r.changed.every(l => l.areas.length === 1 && l.areas[0] === 1));
});

test('re-importing the same posts (with urls) is a no-op', () => {
  const withUrl = SAMPLES.map((s, i) => ({ ...s, url: 'https://www.facebook.com/groups/1/posts/' + i + '/?ref=x' }));
  const a = processItems(withUrl, 'scraper', [], ctx());
  const b = processItems(withUrl, 'scraper', a.changed, ctx());
  assert.equal(b.report.dupes, 6); assert.equal(b.report.newListings, 0); assert.equal(b.report.merged, 0);
  for (const it of withUrl) assert.equal(processItems([it], 'scraper', a.changed, ctx()).report.merged, 0, it.text);
});

test('money parsing: prototype edge cases', () => {
  const f = t => { const e = extract(t); return { rent: e.rent, deposit: e.deposit, depositMonths: e.depositMonths, maintenance: e.maintenance, bhk: e.bhk, brokerage: e.brokerage }; };
  assert.deepEqual(f('Rent: 18,500/- per month, 2 months deposit'), { rent: 18500, deposit: null, depositMonths: 2, maintenance: null, bhk: null, brokerage: null });
  assert.deepEqual(f('₹25k rent, maintenance 2000, deposit 1L'), { rent: 25000, deposit: 100000, depositMonths: null, maintenance: 2000, bhk: null, brokerage: null });
  assert.deepEqual(f('Flat available for 2026 Jan, pin 560103, 1200 sqft, rent 40000'), { rent: 40000, deposit: null, depositMonths: null, maintenance: null, bhk: null, brokerage: null });
  assert.deepEqual(f('2.5 BHK at Green Glen, no broker, 45k'), { rent: 45000, deposit: null, depositMonths: null, maintenance: null, bhk: 2.5, brokerage: 'no' });
});

test('money parsing: more rent and deposit shapes', () => {
  const r = t => extract(t).rent;
  assert.equal(r('Rent 32,000 + 2,500 maintenance'), 32000);
  assert.equal(r('Rs. 22000 per month'), 22000);
  assert.equal(r('INR 1,25,000 rent for villa'), 125000, 'Indian digit grouping');
  assert.equal(r('rent 28.5k negotiable'), 28500);
  assert.equal(r('Expected rent: 35 thousand'), 35000);
  assert.equal(r('1 BHK, 12000/month'), 12000);
  assert.equal(r('Call 9876543210 for details'), null, 'phone number is not rent');
  assert.equal(r('Near 560103, 1350 sqft, 3 BHK'), null, 'PIN code and area are not rent');
  assert.equal(r('Available from 2027'), null, 'years are not rent');
  assert.equal(r('Deposit 1.5 lakh only'), null, 'a lone deposit is not rent');
  const e = extract('Rent 30k, deposit 3 months, maintenance 3000 extra, brokerage 15000');
  assert.equal(e.rent, 30000); assert.equal(e.depositMonths, 3); assert.equal(e.maintenance, 3000); assert.equal(e.brokerageAmount, 15000); assert.equal(e.brokerage, 'yes');
  assert.equal(extract('Rent 30000, 2 lakhs as deposit').deposit, 200000);
  assert.deepEqual(moneyMentions('rent 25k').map(m => [m.n, m.label]), [[25000, 'rent']]);
});

test('seeking vs offer', () => {
  const k = t => extract(t).kind;
  assert.equal(k('Looking for a 2BHK flat in Green Glen layout, budget 30k'), 'seeking');
  assert.equal(k('Need a room in Bellandur from Dec'), 'seeking');
  assert.equal(k('Wanted 1 BHK near Ecospace'), 'seeking');
  assert.equal(k('Looking for a female flatmate for 3BHK in Green Glen'), 'offer', 'flatmate wanted = room on offer');
  assert.equal(k('2BHK available for rent in Green Glen Layout'), 'offer');
  assert.equal(k('Looking for replacement, room available from 1st Dec'), 'offer');
  assert.equal(extract('PG for gents near Bellandur').type, 'pg');
  assert.equal(extract('1 RK in green glen, 9k').bhk, '1RK');
});

test('multi-area matching records every matched area, ignores spacing and case', () => {
  const areas = [{ id: 1, kws: keywordList(['green glen', 'greenglen']) }, { id: 2, kws: keywordList(['hsr layout', 'hsr']) }, { id: 3, kws: keywordList(['koramangala']) }];
  assert.deepEqual(matchAreas('2BHK at GreenGlen layout', areas), [1]);
  assert.deepEqual(matchAreas('Flat in GREEN-GLEN, 10 min to HSR', areas), [1, 2]);
  assert.deepEqual(matchAreas('Studio in Indiranagar', areas), []);
  const two = makeContext([{ id: 1, ...GREEN_GLEN }, { id: 2, name: 'HSR', keywords: ['hsr layout', 'hsr'], active: true }, { id: 3, name: 'Paused', keywords: ['koramangala'], active: false }], { keywordFilter: true });
  const r = processItems([
    { text: '2BHK in HSR layout sector 2, rent 30k, call 9000055555' },
    { text: '1BHK in Koramangala 5th block, rent 25k, no brokerage. 9000044444' },
    { text: '3BHK between Green Glen and HSR, rent 50k, 9000066666' },
  ], 'manual', [], two);
  assert.equal(r.report.offTopic, 1, 'paused area is not scanned');
  assert.deepEqual(r.changed.map(l => l.areas), [[2], [1, 2]]);
  assert.deepEqual(r.report.byArea, { HSR: 2, 'Green Glen': 1 });
});

test('keyword filter off keeps everything; no active areas keeps everything', () => {
  assert.equal(processItems(SAMPLES, 'phone', [], ctx({ keywordFilter: false })).report.offTopic, 0);
  assert.equal(processItems(SAMPLES, 'phone', [], makeContext([], {})).report.offTopic, 0);
});

test('normalizeRaw tolerates common field names and relative times', () => {
  const now = Date.UTC(2026, 10, 7, 12);
  const p = normalizeRaw({ postText: 'Room available in green glen', permalink: 'https://m.facebook.com/groups/9/posts/77/?ref=share#x', author: { name: 'Asha' }, groupName: 'Flats BLR', timeText: '3h' }, 'scraper', now);
  assert.equal(p.text, 'Room available in green glen'); assert.equal(p.author, 'Asha'); assert.equal(p.group, 'Flats BLR');
  assert.equal(p.urlKey, 'facebook.com/groups/9/posts/77'); assert.equal(p.postedAt, now - 3 * 36e5);
  assert.equal(normalizeRaw({ text: 'x', timestamp: 1_790_000_000 }, 's', now).postedAt, 1_790_000_000_000, 'seconds -> ms');
  assert.equal(normUrl('https://www.facebook.com/permalink.php?story_fbid=12&id=34&ref=x'), 'facebook.com/permalink.php?story_fbid=12&id=34');
});

test('watched groups: structured setting, paused groups ignored', () => {
  const w = watchedGroups([{ name: 'Bellandur Flats', url: 'https://www.facebook.com/groups/111/', active: true }, { name: 'Old group', url: 'https://facebook.com/groups/222', active: false }]);
  assert.equal(w.length, 1);
  assert.equal(isKnownGroup('', 'https://m.facebook.com/groups/111', w), true);
  assert.equal(isKnownGroup('Old group', 'https://facebook.com/groups/222', w), false);
  assert.equal(watchedGroups('A | https://facebook.com/groups/1\nB').length, 2, 'prototype text format still works');
});
