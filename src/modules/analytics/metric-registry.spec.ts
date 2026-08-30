import { METRIC_KEYS, METRIC_REGISTRY } from './metric-registry';

describe('METRIC_REGISTRY (T022, FR-A002)', () => {
  it('every metric has a non-empty label, definition and source', () => {
    for (const key of METRIC_KEYS) {
      const m = METRIC_REGISTRY[key];
      expect(m.key).toBe(key);
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.definition.length).toBeGreaterThan(0);
      expect(m.source.length).toBeGreaterThan(0);
    }
  });

  // FR-A002 is about SEMANTIC duplication ("the same thing under different
  // names"), not implementation sharing — several genuinely distinct figures
  // (e.g. bookings_platform/bookings_manual/bookings_whatsapp_bot/bookings_public_ai,
  // or rates.cancellation/rates.cancellation_by_patient/rates.cancellation_by_clinic)
  // are legitimately computed together, in one query pass, by the SAME
  // `AnalyticsAggregationService` method — that is an efficiency detail, not a
  // duplicate metric. The real duplicate-detection check is label/definition
  // uniqueness (below): two entries sharing a `source` string MUST still have
  // distinct labels AND distinct definitions, or they really would be the same
  // figure under two names.
  it('entries sharing a source are still definitionally distinct (different label AND definition)', () => {
    const bySource = new Map<string, string[]>();
    for (const key of METRIC_KEYS) {
      const { source } = METRIC_REGISTRY[key];
      bySource.set(source, [...(bySource.get(source) ?? []), key]);
    }
    for (const [source, keys] of bySource) {
      if (keys.length < 2) continue;
      const labels = keys.map((k) => METRIC_REGISTRY[k].label);
      const definitions = keys.map((k) => METRIC_REGISTRY[k].definition);
      expect(new Set(labels).size).toBe(labels.length);
      expect(new Set(definitions).size).toBe(definitions.length);
      void source; // grouping key only — assertion is on the grouped entries
    }
  });

  it('no two entries share the same label under different keys', () => {
    const labels = METRIC_KEYS.map((k) => METRIC_REGISTRY[k].label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('revenue keeps the existing sumBranchRevenue definition — settled payments, never Appointment.total_amount', () => {
    expect(METRIC_REGISTRY['revenue.total'].source).toContain(
      'sumBranchRevenue',
    );
    expect(METRIC_REGISTRY['revenue.total'].definition).toMatch(/SETTLED|PAID/);
  });
});
