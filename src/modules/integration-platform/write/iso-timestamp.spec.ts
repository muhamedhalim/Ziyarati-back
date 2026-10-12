import { AppError, ErrorCode } from '../../../common/errors';
import { parseOffsetTimestamp } from './iso-timestamp';

describe('parseOffsetTimestamp (F10 — explicit-offset ISO-8601 only)', () => {
  it.each([
    ['2026-10-28T10:00:00Z', '2026-10-28T10:00:00.000Z'],
    ['2026-10-28T10:00:00.250Z', '2026-10-28T10:00:00.250Z'],
    ['2026-10-28T13:00:00+03:00', '2026-10-28T10:00:00.000Z'],
    ['2026-10-28T05:00:00-05:00', '2026-10-28T10:00:00.000Z'],
    ['2026-10-28T10:00+00:00', '2026-10-28T10:00:00.000Z'], // minutes precision
    ['2026-10-28T15:30:00+05:30', '2026-10-28T10:00:00.000Z'],
  ])('accepts %s', (input, iso) => {
    expect(parseOffsetTimestamp(input, 'startAt').toISOString()).toBe(iso);
  });

  it('is independent of the process time zone (never interprets a local time)', () => {
    const before = process.env.TZ;
    try {
      process.env.TZ = 'Pacific/Kiritimati';
      expect(parseOffsetTimestamp('2026-10-28T10:00:00+03:00', 'x').toISOString()).toBe('2026-10-28T07:00:00.000Z');
    } finally {
      process.env.TZ = before;
    }
  });

  it('keeps distinct instants across a daylight-saving boundary (Europe/Berlin, 2026-10-25)', () => {
    // 02:30 happens twice that night: +02:00 (CEST) then +01:00 (CET).
    const first = parseOffsetTimestamp('2026-10-25T02:30:00+02:00', 'x');
    const second = parseOffsetTimestamp('2026-10-25T02:30:00+01:00', 'x');
    expect(second.getTime() - first.getTime()).toBe(3600_000);
  });

  it.each([
    ['no offset', '2026-10-28T10:00:00'],
    ['no offset, millis', '2026-10-28T10:00:00.000'],
    ['date only', '2026-10-28'],
    ['space separator', '2026-10-28 10:00:00Z'],
    ['numeric string epoch', '1792000000'],
    ['offset without colon', '2026-10-28T10:00:00+0300'],
    ['nonexistent day', '2026-02-30T10:00:00Z'],
    ['month 13', '2026-13-01T10:00:00Z'],
    ['hour 24', '2026-10-28T24:00:00Z'],
    ['offset hour 25', '2026-10-28T10:00:00+25:00'],
    ['garbage', 'tomorrow'],
    ['empty', ''],
  ])('rejects %s', (_name, input) => {
    expect(() => parseOffsetTimestamp(input, 'startAt')).toThrow(AppError);
  });

  it.each([1792000000, 1792000000000, null, undefined, {}, [], true])('rejects non-string %j', (v) => {
    try {
      parseOffsetTimestamp(v, 'startAt');
      throw new Error('expected rejection');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe(ErrorCode.VALIDATION_ERROR);
    }
  });

  it('names the offending field and never echoes the value', () => {
    try {
      parseOffsetTimestamp('2031-07-04T01:02:03', 'endAt');
      throw new Error('expected rejection');
    } catch (e) {
      const err = e as AppError;
      expect(err.message).toContain('endAt');
      expect(err.message).not.toContain('2031-07-04');
    }
  });
});
