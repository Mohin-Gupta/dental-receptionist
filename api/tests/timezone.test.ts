import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  addMinutesToClinicString,
  parseInTimezone,
  toClinicTimeString,
} from '../src/lib/timezone';

test('constructs local clinic times with non-hour offsets', () => {
  assert.equal(
    toClinicTimeString(2026, 7, 13, 10, 30, 'Asia/Kolkata'),
    '2026-07-13T10:30:00+05:30'
  );
});

test('rejects a nonexistent local time during the spring DST gap', () => {
  assert.throws(
    () => toClinicTimeString(2026, 3, 8, 2, 30, 'America/New_York'),
    /does not exist/
  );
  assert.equal(
    toClinicTimeString(2026, 3, 8, 3, 30, 'America/New_York'),
    '2026-03-08T03:30:00-04:00'
  );
});

test('chooses the earlier occurrence during the fall DST fold', () => {
  assert.equal(
    toClinicTimeString(2026, 11, 1, 1, 30, 'America/New_York'),
    '2026-11-01T01:30:00-04:00'
  );
});

test('adds elapsed minutes across a DST transition', () => {
  assert.equal(
    addMinutesToClinicString(
      '2026-03-08T01:30:00-05:00',
      60,
      'America/New_York'
    ),
    '2026-03-08T03:30:00-04:00'
  );
});

test('local calendar days use 23 or 25 elapsed hours across DST', () => {
  const springStart = new Date(toClinicTimeString(2026, 3, 8, 0, 0, 'America/New_York'));
  const springEnd = new Date(toClinicTimeString(2026, 3, 9, 0, 0, 'America/New_York'));
  const fallStart = new Date(toClinicTimeString(2026, 11, 1, 0, 0, 'America/New_York'));
  const fallEnd = new Date(toClinicTimeString(2026, 11, 2, 0, 0, 'America/New_York'));

  assert.equal(springEnd.getTime() - springStart.getTime(), 23 * 60 * 60 * 1_000);
  assert.equal(fallEnd.getTime() - fallStart.getTime(), 25 * 60 * 60 * 1_000);
});

test('parses midnight without exposing Intl hour 24', () => {
  assert.deepEqual(parseInTimezone('2026-07-12T18:30:00.000Z', 'Asia/Kolkata'), {
    year: 2026,
    month: 7,
    day: 13,
    hour: 0,
    minute: 0,
  });
});
