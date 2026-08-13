import {
  ALWAYS_ON_FEATURES,
  FEATURE_KEYS,
  FEATURE_REGISTRY,
  FeatureKey,
  dependencyClosure,
  featuresForMetric,
  grantCovers,
  isFeatureKey,
} from './feature-registry';
import { USAGE_METRIC } from './usage-metric';

describe('FEATURE_REGISTRY', () => {
  it('has a spec for every key, with no empty metadata', () => {
    for (const key of FEATURE_KEYS) {
      const spec = FEATURE_REGISTRY[key];
      expect(spec).toBeDefined();
      expect(spec.name.length).toBeGreaterThan(0);
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });

  it('only ever declares dependencies that are themselves registry keys', () => {
    // A dangling edge would be written into `feature_dependencies` by the boot
    // sync and then read back as a permanently-missing dependency, silently
    // blocking the dependent feature for every tenant.
    for (const key of FEATURE_KEYS) {
      for (const dep of FEATURE_REGISTRY[key].dependsOn) {
        expect(FEATURE_KEYS).toContain(dep);
      }
    }
  });

  it('only ever names real metered metrics', () => {
    const known = Object.values(USAGE_METRIC);
    for (const key of FEATURE_KEYS) {
      const metric = FEATURE_REGISTRY[key].usageMetric;
      if (metric) expect(known).toContain(metric);
    }
  });

  it('keeps always-on features dependency-free', () => {
    // An always-on capability exists so a DENIED tenant can still pay and ask
    // for help. If it depended on a gateable feature it would inherit that
    // gate, and a blocked clinic would have no route back to a subscription.
    for (const key of ALWAYS_ON_FEATURES) {
      expect(FEATURE_REGISTRY[key].dependsOn).toEqual([]);
    }
    expect(ALWAYS_ON_FEATURES).toEqual(
      expect.arrayContaining([
        FeatureKey.CORE_WORKSPACE,
        FeatureKey.BILLING,
        FeatureKey.SUPPORT,
      ]),
    );
  });
});

describe('dependencyClosure', () => {
  it('returns the transitive closure without the key itself', () => {
    const closure = dependencyClosure(FeatureKey.CAMPAIGNS);
    // campaigns -> whatsapp -> conversations -> crm
    expect(closure).toEqual(
      expect.arrayContaining([
        FeatureKey.WHATSAPP,
        FeatureKey.CONVERSATIONS,
        FeatureKey.CRM,
      ]),
    );
    expect(closure).not.toContain(FeatureKey.CAMPAIGNS);
  });

  it('terminates for every key', () => {
    for (const key of FEATURE_KEYS) {
      expect(() => dependencyClosure(key)).not.toThrow();
    }
  });

  it('is empty for a leaf capability', () => {
    expect(dependencyClosure(FeatureKey.CRM)).toEqual([]);
  });
});

describe('grantCovers', () => {
  it('covers the granted key itself', () => {
    expect(grantCovers(FeatureKey.WHATSAPP, FeatureKey.WHATSAPP)).toBe(true);
  });

  it('covers what the granted key cannot work without', () => {
    // This is the whole point of the closure: an operator who enables WhatsApp
    // for a tenant with no subscription expects the WhatsApp inbox to work,
    // and the inbox reads conversations and customer records.
    expect(grantCovers(FeatureKey.WHATSAPP, FeatureKey.CONVERSATIONS)).toBe(
      true,
    );
    expect(grantCovers(FeatureKey.WHATSAPP, FeatureKey.CRM)).toBe(true);
  });

  it('does NOT cover unrelated capabilities', () => {
    expect(grantCovers(FeatureKey.WHATSAPP, FeatureKey.CAMPAIGNS)).toBe(false);
    expect(grantCovers(FeatureKey.WHATSAPP, FeatureKey.PAYMENTS)).toBe(false);
    expect(grantCovers(FeatureKey.AI_ASSISTANT, FeatureKey.CAMPAIGNS)).toBe(
      false,
    );
  });

  it('does not run the dependency edge backwards', () => {
    // campaigns needs whatsapp; granting conversations must not grant whatsapp.
    expect(grantCovers(FeatureKey.CONVERSATIONS, FeatureKey.WHATSAPP)).toBe(
      false,
    );
  });
});

describe('featuresForMetric', () => {
  it('derives the feature for each metered metric', () => {
    expect(featuresForMetric(USAGE_METRIC.WHATSAPP_MESSAGES)).toEqual([
      FeatureKey.WHATSAPP,
    ]);
    expect(featuresForMetric(USAGE_METRIC.CAMPAIGNS)).toEqual([
      FeatureKey.CAMPAIGNS,
    ]);
    expect(featuresForMetric(USAGE_METRIC.APPOINTMENTS)).toEqual([
      FeatureKey.APPOINTMENTS,
    ]);
    expect(featuresForMetric(USAGE_METRIC.AI_TOKENS)).toEqual([
      FeatureKey.AI_ASSISTANT,
    ]);
  });

  it('resolves every metric to at least one feature', () => {
    for (const metric of Object.values(USAGE_METRIC)) {
      expect(featuresForMetric(metric).length).toBeGreaterThan(0);
    }
  });
});

describe('isFeatureKey', () => {
  it('accepts registry keys and rejects everything else', () => {
    expect(isFeatureKey('whatsapp')).toBe(true);
    expect(isFeatureKey('ai.assistant')).toBe(true);
    // The key 10 controllers used to gate on, which never existed in the
    // catalog — the drift this registry makes impossible.
    expect(isFeatureKey('ai')).toBe(false);
    expect(isFeatureKey('')).toBe(false);
    expect(isFeatureKey(undefined)).toBe(false);
    expect(isFeatureKey('constructor')).toBe(false);
  });
});
