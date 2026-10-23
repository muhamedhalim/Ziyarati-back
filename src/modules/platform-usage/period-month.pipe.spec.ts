import { BadRequestException } from '@nestjs/common';

import { PeriodMonthPipe, isPeriodMonth } from './period-month.pipe';
import { PlatformUsageService } from './platform-usage.service';

/** CR-36: `periodMonth` used to be spliced into SQL unvalidated on GET /platform/usage/summary. */
describe('PeriodMonthPipe', () => {
  const pipe = new PeriodMonthPipe();

  it.each(['2026-07', '1999-12', '2030-01'])('accepts %s', (v) => {
    expect(pipe.transform(v)).toBe(v);
  });

  it.each([undefined, null, ''])('treats %p as "not supplied"', (v) => {
    expect(pipe.transform(v)).toBeUndefined();
  });

  it.each([
    "2026-07'; DROP TABLE users;--",
    "2026-07' OR '1'='1",
    '2026-13',
    '2026-00',
    '26-07',
    '2026-7',
    '2026-07-01',
    ' 2026-07',
    '2026-07\n',
    ['2026-07', '2026-08'],
    { a: 1 },
    20260707,
  ])('rejects %p with 400', (v) => {
    expect(() => pipe.transform(v)).toThrow(BadRequestException);
  });

  it('isPeriodMonth narrows only well-formed strings', () => {
    expect(isPeriodMonth('2026-07')).toBe(true);
    expect(isPeriodMonth("2026-07'")).toBe(false);
    expect(isPeriodMonth(undefined)).toBe(false);
  });
});

describe('PlatformUsageService.baseCte (defence in depth)', () => {
  const svc = Object.create(PlatformUsageService.prototype) as unknown as {
    baseCte(period: string): string;
  };

  it('splices a valid period', () => {
    expect(svc.baseCte('2026-07')).toContain("su.period_month = '2026-07'");
  });

  it('refuses a period that could break out of the literal', () => {
    expect(() => svc.baseCte("2026-07'; DROP TABLE users;--")).toThrow(BadRequestException);
    expect(() => svc.baseCte("x' OR 1=1 --")).toThrow(BadRequestException);
  });
});
