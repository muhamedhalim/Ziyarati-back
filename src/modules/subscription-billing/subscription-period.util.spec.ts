import { computeNextPeriodEnd } from './subscription-period.util';
import { BillingCycle, CustomCycleUnit } from '../../entities/enums';

/** FIN-009 — period arithmetic clamps to the end of a shorter month. */
describe('computeNextPeriodEnd', () => {
  const plan = (p: Record<string, unknown>) => p as any;
  const d = (s: string) => new Date(s);

  it('monthly: Jan 31 → Feb 28 (not Mar 3)', () => {
    const end = computeNextPeriodEnd(d('2026-01-31T10:00:00Z'), plan({ billing_cycle: BillingCycle.MONTHLY }));
    expect(end.toISOString()).toBe('2026-02-28T10:00:00.000Z');
  });

  it('monthly: leap year Jan 31 → Feb 29', () => {
    const end = computeNextPeriodEnd(d('2028-01-31T00:00:00Z'), plan({ billing_cycle: BillingCycle.MONTHLY }));
    expect(end.toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it('monthly: ordinary day is unchanged, year rolls over', () => {
    const end = computeNextPeriodEnd(d('2026-12-15T00:00:00Z'), plan({ billing_cycle: BillingCycle.MONTHLY }));
    expect(end.toISOString()).toBe('2027-01-15T00:00:00.000Z');
  });

  it('yearly: Feb 29 → Feb 28 next year (not Mar 1)', () => {
    const end = computeNextPeriodEnd(d('2024-02-29T00:00:00Z'), plan({ billing_cycle: BillingCycle.YEARLY }));
    expect(end.toISOString()).toBe('2025-02-28T00:00:00.000Z');
  });

  it('custom 3 months from Nov 30 → Feb 28', () => {
    const end = computeNextPeriodEnd(
      d('2026-11-30T00:00:00Z'),
      plan({ billing_cycle: BillingCycle.CUSTOM, custom_cycle_value: 3, custom_cycle_unit: CustomCycleUnit.MONTH }),
    );
    expect(end.toISOString()).toBe('2027-02-28T00:00:00.000Z');
  });

  it('custom days are untouched', () => {
    const end = computeNextPeriodEnd(
      d('2026-01-31T00:00:00Z'),
      plan({ billing_cycle: BillingCycle.CUSTOM, custom_cycle_value: 10, custom_cycle_unit: CustomCycleUnit.DAY }),
    );
    expect(end.toISOString()).toBe('2026-02-10T00:00:00.000Z');
  });
});
