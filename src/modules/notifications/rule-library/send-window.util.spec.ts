import {
  DEFAULT_SEND_WINDOW,
  inWindow,
  isValidSendWindow,
  shiftIntoWindow,
} from './send-window.util';

const RIYADH = 'Asia/Riyadh'; // UTC+3, no DST
const NEW_YORK = 'America/New_York'; // DST

/** A Riyadh wall-clock time as a UTC Date. */
const riyadh = (iso: string) => new Date(`${iso}+03:00`);

describe('send window', () => {
  it('leaves a time inside the window untouched', () => {
    const at = riyadh('2026-10-24T14:30:00');
    expect(shiftIntoWindow(at, RIYADH, DEFAULT_SEND_WINDOW)).toBe(at);
  });

  it('moves a 3 a.m. time to the same morning at 09:00', () => {
    const out = shiftIntoWindow(
      riyadh('2026-10-24T03:00:00'),
      RIYADH,
      DEFAULT_SEND_WINDOW,
    );
    expect(out?.toISOString()).toBe(
      riyadh('2026-10-24T09:00:00').toISOString(),
    );
  });

  it('moves a 22:00 time to tomorrow at 09:00', () => {
    const out = shiftIntoWindow(
      riyadh('2026-10-24T22:00:00'),
      RIYADH,
      DEFAULT_SEND_WINDOW,
    );
    expect(out?.toISOString()).toBe(
      riyadh('2026-10-25T09:00:00').toISOString(),
    );
  });

  it('treats the closing hour as outside and the opening hour as inside', () => {
    expect(
      inWindow(riyadh('2026-10-24T21:00:00'), RIYADH, DEFAULT_SEND_WINDOW),
    ).toBe(false);
    expect(
      inWindow(riyadh('2026-10-24T20:59:00'), RIYADH, DEFAULT_SEND_WINDOW),
    ).toBe(true);
    expect(
      inWindow(riyadh('2026-10-24T09:00:00'), RIYADH, DEFAULT_SEND_WINDOW),
    ).toBe(true);
    expect(
      inWindow(riyadh('2026-10-24T08:59:00'), RIYADH, DEFAULT_SEND_WINDOW),
    ).toBe(false);
  });

  it('sends a reminder EARLIER when moving it later would pass the appointment', () => {
    // Appointment 08:00 tomorrow; the 24h reminder lands at 08:00 today — before 09:00.
    // Waiting for 09:00 today is fine here (still before the appointment) …
    const appt = riyadh('2026-10-25T08:00:00');
    const a = shiftIntoWindow(
      riyadh('2026-10-24T08:00:00'),
      RIYADH,
      DEFAULT_SEND_WINDOW,
      {
        notAfter: appt,
      },
    );
    expect(a?.toISOString()).toBe(riyadh('2026-10-24T09:00:00').toISOString());
    // … but a 02:00 appointment means a 02:00 reminder: the nearest allowed time
    // BEFORE it is yesterday's closing, not tomorrow's opening (after the visit).
    const early = riyadh('2026-10-25T02:00:00');
    const b = shiftIntoWindow(
      riyadh('2026-10-24T02:00:00'),
      RIYADH,
      DEFAULT_SEND_WINDOW,
      {
        notAfter: early,
      },
    );
    expect(b?.toISOString()).toBe(riyadh('2026-10-24T09:00:00').toISOString());
  });

  it('uses the previous closing when the opening would be after the appointment', () => {
    // Reminder due 05:00; appointment at 06:00 the same morning. 09:00 is after it.
    const out = shiftIntoWindow(
      riyadh('2026-10-24T05:00:00'),
      RIYADH,
      DEFAULT_SEND_WINDOW,
      {
        notAfter: riyadh('2026-10-24T06:00:00'),
        earliest: riyadh('2026-10-23T00:00:00'),
      },
    );
    expect(out?.toISOString()).toBe(
      riyadh('2026-10-23T20:59:00').toISOString(),
    );
  });

  it('skips (null) when nothing usable remains', () => {
    const out = shiftIntoWindow(
      riyadh('2026-10-24T05:00:00'),
      RIYADH,
      DEFAULT_SEND_WINDOW,
      {
        notAfter: riyadh('2026-10-24T06:00:00'),
        // "now" is already after yesterday's closing — nothing earlier is possible.
        earliest: riyadh('2026-10-24T01:00:00'),
      },
    );
    expect(out).toBeNull();
  });

  it('is correct across a DST change', () => {
    // New York springs forward on 2026-03-08 (02:00 → 03:00). 02:30 does not exist;
    // 03:00 EDT is 07:00Z. A 01:00 EST (06:00Z) reminder opens at 09:00 EDT = 13:00Z.
    const out = shiftIntoWindow(
      new Date('2026-03-08T06:00:00Z'),
      NEW_YORK,
      DEFAULT_SEND_WINDOW,
    );
    expect(out?.toISOString()).toBe('2026-03-08T13:00:00.000Z');
    // The next day is already EDT: 22:00 EDT = 02:00Z → 09:00 EDT next day = 13:00Z.
    const next = shiftIntoWindow(
      new Date('2026-03-09T02:00:00Z'),
      NEW_YORK,
      DEFAULT_SEND_WINDOW,
    );
    expect(next?.toISOString()).toBe('2026-03-09T13:00:00.000Z');
  });

  it('falls back to UTC for an unknown timezone instead of throwing', () => {
    expect(() =>
      shiftIntoWindow(
        new Date('2026-10-24T03:00:00Z'),
        'Not/AZone',
        DEFAULT_SEND_WINDOW,
      ),
    ).not.toThrow();
  });

  it('validates window settings', () => {
    expect(isValidSendWindow({ startHour: 9, endHour: 21 })).toBe(true);
    expect(isValidSendWindow({ startHour: 21, endHour: 9 })).toBe(false);
    expect(isValidSendWindow({ startHour: -1, endHour: 5 })).toBe(false);
    expect(isValidSendWindow({ startHour: 9, endHour: 25 })).toBe(false);
    expect(isValidSendWindow({ startHour: 9.5, endHour: 21 })).toBe(false);
    expect(isValidSendWindow(null)).toBe(false);
  });
});
