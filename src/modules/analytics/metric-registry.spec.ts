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

  it('no two entries share the same source — each measures something distinct', () => {
    const sources = METRIC_KEYS.map((k) => METRIC_REGISTRY[k].source);
    expect(new Set(sources).size).toBe(sources.length);
  });

  it('no two entries share the same label under different keys', () => {
    const labels = METRIC_KEYS.map((k) => METRIC_REGISTRY[k].label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('revenue keeps the existing sumBranchRevenue definition — settled payments, never Appointment.total_amount', () => {
    expect(METRIC_REGISTRY['revenue.total'].source).toContain('sumBranchRevenue');
    expect(METRIC_REGISTRY['revenue.total'].definition).toMatch(/SETTLED|PAID/);
  });
});
