import { currentPeriodMonth } from './ai.constants';

describe('ai.constants', () => {
  it('currentPeriodMonth formats as YYYY-MM (UTC)', () => {
    expect(currentPeriodMonth(new Date('2026-06-09T00:00:00Z'))).toBe('2026-06');
    expect(currentPeriodMonth(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12');
  });
});
