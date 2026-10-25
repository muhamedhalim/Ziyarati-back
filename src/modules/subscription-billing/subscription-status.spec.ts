import { SubscriptionStatus as S } from '../../entities/enums';
import {
  DEFAULT_SUBSCRIPTION_GRACE_DAYS,
  effectiveSubscriptionStatus,
  graceEndsAtOf,
  resolveGraceDays,
} from './subscription-status';

const NOW = new Date('2026-10-25T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

describe('effectiveSubscriptionStatus', () => {
  const sub = (status: S, ends: Date, grace?: Date | null) => ({
    status,
    ends_at: ends,
    grace_started_at: grace ?? null,
  });

  it.each([
    [S.CANCELLED, days(-30)],
    [S.SUSPENDED, days(-30)],
    [S.GRACE_EXPIRED, days(-30)],
    [S.PENDING_PAYMENT, days(-30)],
    [S.PENDING_PAYMENT, days(30)],
  ])('%s passes through unchanged regardless of dates', (status, ends) => {
    expect(effectiveSubscriptionStatus(sub(status, ends), 14, NOW)).toBe(status);
  });

  it.each([S.ACTIVE, S.TRIAL])('%s before ends_at stays unchanged', (status) => {
    expect(effectiveSubscriptionStatus(sub(status, days(1)), 14, NOW)).toBe(status);
  });

  it.each([S.ACTIVE, S.TRIAL])('%s past ends_at reads as PAST_DUE', (status) => {
    expect(effectiveSubscriptionStatus(sub(status, days(-1)), 14, NOW)).toBe(S.PAST_DUE);
  });

  it('PAST_DUE inside the grace window stays PAST_DUE', () => {
    expect(effectiveSubscriptionStatus(sub(S.PAST_DUE, days(-20), days(-13)), 14, NOW)).toBe(S.PAST_DUE);
  });

  it('PAST_DUE whose grace window has elapsed reads as GRACE_EXPIRED', () => {
    expect(effectiveSubscriptionStatus(sub(S.PAST_DUE, days(-30), days(-15)), 14, NOW)).toBe(S.GRACE_EXPIRED);
  });

  it('PAST_DUE exactly at the grace boundary is not yet expired', () => {
    expect(effectiveSubscriptionStatus(sub(S.PAST_DUE, days(-30), days(-14)), 14, NOW)).toBe(S.PAST_DUE);
  });

  it('PAST_DUE without grace_started_at stays PAST_DUE', () => {
    expect(effectiveSubscriptionStatus(sub(S.PAST_DUE, days(-90)), 14, NOW)).toBe(S.PAST_DUE);
  });

  it('honours a different grace length', () => {
    const s = sub(S.PAST_DUE, days(-30), days(-5));
    expect(effectiveSubscriptionStatus(s, 3, NOW)).toBe(S.GRACE_EXPIRED);
    expect(effectiveSubscriptionStatus(s, 7, NOW)).toBe(S.PAST_DUE);
  });
});

describe('grace helpers', () => {
  it('resolveGraceDays reads the setting and defaults to 14', () => {
    const get = jest.fn((_k: string, d?: number) => d);
    expect(resolveGraceDays({ get } as never)).toBe(DEFAULT_SUBSCRIPTION_GRACE_DAYS);
    expect(get).toHaveBeenCalledWith('SUBSCRIPTION_GRACE_DAYS', 14);
    expect(resolveGraceDays({ get: () => 30 } as never)).toBe(30);
  });

  it('graceEndsAtOf adds whole days', () => {
    expect(graceEndsAtOf(NOW, 14).getTime()).toBe(days(14).getTime());
  });
});
