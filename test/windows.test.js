// Timezone-aware budget window boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleWindow } from '../src/store/windows.js';

const iso = (ms) => new Date(ms).toISOString();

test('hourly and 5-hourly windows in Asia/Kolkata', () => {
  const at = Date.parse('2026-01-15T18:45:00Z'); // 00:15 IST on Jan 16
  const hour = ruleWindow({ period: 'hour', timezone: 'Asia/Kolkata' }, at);
  assert.equal(iso(hour.start), '2026-01-15T18:30:00.000Z');
  assert.equal(iso(hour.end), '2026-01-15T19:30:00.000Z');

  const five = ruleWindow({ period: 'n_hours', period_count: 5, timezone: 'Asia/Kolkata', anchor: '0' }, at);
  assert.equal(iso(five.start), '2026-01-15T18:30:00.000Z');
  assert.equal(iso(five.end), '2026-01-15T23:30:00.000Z');
});

test('daily reset time in Asia/Kolkata', () => {
  const at = Date.parse('2026-01-15T18:30:00Z'); // 00:00 IST Jan 16
  const midnight = ruleWindow({ period: 'day', timezone: 'Asia/Kolkata', reset_time: 0 }, at);
  assert.equal(iso(midnight.start), '2026-01-15T18:30:00.000Z');
  assert.equal(iso(midnight.end), '2026-01-16T18:30:00.000Z');

  const late = ruleWindow({ period: 'day', timezone: 'Asia/Kolkata', reset_time: 1439 }, at);
  assert.equal(iso(late.start), '2026-01-15T18:29:00.000Z');
  assert.equal(iso(late.end), '2026-01-16T18:29:00.000Z');
});

test('n-day, weekly, and monthly boundaries', () => {
  const at = Date.parse('2026-01-15T12:00:00Z'); // 17:30 IST Jan 15
  const nDays = ruleWindow({
    period: 'n_days', period_count: 7, timezone: 'Asia/Kolkata', reset_time: 0, anchor: '2026-01-01',
  }, at);
  assert.equal(iso(nDays.start), '2026-01-14T18:30:00.000Z');
  assert.equal(iso(nDays.end), '2026-01-21T18:30:00.000Z');

  const week = ruleWindow({ period: 'week', timezone: 'Asia/Kolkata', reset_time: 0, anchor: '1' }, at);
  assert.equal(new Date(week.start).getUTCDay(), 0, 'Monday 00:00 IST is Sunday 18:30 UTC');
  assert.equal(new Date(week.start).toISOString(), '2026-01-11T18:30:00.000Z');

  const month = ruleWindow({ period: 'month', timezone: 'Asia/Kolkata', reset_time: 0, anchor: '1' }, at);
  assert.equal(iso(month.start), '2025-12-31T18:30:00.000Z');
  assert.equal(iso(month.end), '2026-01-31T18:30:00.000Z');
});

test('daily windows honour DST offsets', () => {
  const before = ruleWindow({ period: 'day', timezone: 'America/New_York', reset_time: 0 }, Date.parse('2026-03-07T12:00:00Z'));
  const after = ruleWindow({ period: 'day', timezone: 'America/New_York', reset_time: 0 }, Date.parse('2026-03-08T12:00:00Z'));
  assert.equal((before.end - before.start) / 3600000, 24);
  assert.equal((after.end - after.start) / 3600000, 23, 'spring-forward day is 23 hours');
});

test('invalid legacy timezones fall back to UTC instead of throwing', () => {
  const at = Date.parse('2026-01-15T12:00:00Z');
  const invalid = ruleWindow({ period: 'day', timezone: 'Invalid/Zone', reset_time: 0 }, at);
  const utc = ruleWindow({ period: 'day', timezone: 'UTC', reset_time: 0 }, at);
  assert.deepEqual(invalid, utc);
});
