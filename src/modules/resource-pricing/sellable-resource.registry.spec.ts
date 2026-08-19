import {
  SELLABLE_RESOURCE_REGISTRY,
  SELLABLE_ITEM_KEYS,
  SELLABLE_KIND,
  findSellableResource,
} from './sellable-resource.registry';
import {
  USAGE_METRIC,
  USAGE_METRIC_MAP,
  RESOURCE_LIMIT_MAP,
  UsageMetric,
} from '../subscription-billing/usage-metric';
import {
  RESOURCE_LIMIT_FEATURE,
  ENFORCED_RESOURCE_LIMITS,
  featuresForMetric,
} from '../subscription-billing/feature-registry';

describe('SELLABLE_RESOURCE_REGISTRY', () => {
  it('every itemKey is unique, and SELLABLE_ITEM_KEYS is exactly the registry\'s keys', () => {
    const keys = SELLABLE_RESOURCE_REGISTRY.map((r) => r.itemKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(SELLABLE_ITEM_KEYS).toEqual(keys);
  });

  describe('credit items', () => {
    const credits = SELLABLE_RESOURCE_REGISTRY.filter((r) => r.kind === SELLABLE_KIND.CREDIT);

    it('every credit item names a real UsageMetric, and every UsageMetric appears exactly once', () => {
      const allMetrics = Object.values(USAGE_METRIC);
      const covered = credits.map((r) => r.meteredMetric);
      expect(new Set(covered)).toEqual(new Set(allMetrics));
      expect(covered.length).toBe(allMetrics.length);
    });

    it('planColumn and isBigInt are exactly what USAGE_METRIC_MAP says for that metric', () => {
      for (const item of credits) {
        const mapping = USAGE_METRIC_MAP[item.meteredMetric as UsageMetric];
        expect(item.planColumn).toBe(mapping.limitColumn);
        expect(item.isBigInt).toBe(mapping.isBigInt);
      }
    });

    it('feature is one of the features FEATURE_REGISTRY actually attributes to that metric', () => {
      for (const item of credits) {
        const owners = featuresForMetric(item.meteredMetric as UsageMetric);
        expect(owners).toContain(item.feature);
      }
    });

    it('every credit item is sellable (no metered metric is architecturally blocked)', () => {
      for (const item of credits) {
        expect(item.eligibility).toBe('sellable');
        expect(item.blockedReason).toBeUndefined();
      }
    });

    it('AI tokens are unitSize 1000 (priced per 1,000, linear scaling); every other credit is unitSize 1', () => {
      for (const item of credits) {
        if (item.meteredMetric === USAGE_METRIC.AI_TOKENS) {
          expect(item.unitSize).toBe(1000);
        } else {
          expect(item.unitSize).toBe(1);
        }
      }
    });
  });

  describe('capacity items', () => {
    const capacity = SELLABLE_RESOURCE_REGISTRY.filter((r) => r.kind === SELLABLE_KIND.CAPACITY);

    it('every capacity item is in ENFORCED_RESOURCE_LIMITS — buying it must change real behaviour', () => {
      for (const item of capacity) {
        expect(ENFORCED_RESOURCE_LIMITS.has(item.resourceMetric!)).toBe(true);
      }
    });

    it('every entry in ENFORCED_RESOURCE_LIMITS is represented exactly once — nothing enforced goes unlisted', () => {
      const covered = capacity.map((r) => r.resourceMetric);
      expect(new Set(covered)).toEqual(ENFORCED_RESOURCE_LIMITS);
      expect(covered.length).toBe(ENFORCED_RESOURCE_LIMITS.size);
    });

    it('planColumn is exactly RESOURCE_LIMIT_MAP[metric]', () => {
      for (const item of capacity) {
        expect(item.planColumn).toBe(RESOURCE_LIMIT_MAP[item.resourceMetric!]);
      }
    });

    it('feature is exactly RESOURCE_LIMIT_FEATURE[metric]', () => {
      for (const item of capacity) {
        expect(item.feature).toBe(RESOURCE_LIMIT_FEATURE[item.resourceMetric!]);
      }
    });

    it('unitSize is 1 for count caps; the three byte-denominated items (storageBytes/uploadedFiles/trainingFiles) are priced per MB (1,048,576 bytes/lot)', () => {
      const BYTE_DENOMINATED = new Set(['storageBytes', 'uploadedFiles', 'trainingFiles']);
      for (const item of capacity) {
        if (BYTE_DENOMINATED.has(item.resourceMetric!)) {
          expect(item.unitSize).toBe(1_048_576);
        } else {
          expect(item.unitSize).toBe(1);
        }
      }
    });

    it('only storageBytes is blocked — Phase 0.1 unblocked customers/uploadedFiles/knowledgeBaseFiles/trainingFiles', () => {
      const blocked = capacity.filter((r) => r.eligibility === 'blocked');
      expect(blocked.map((r) => r.resourceMetric)).toEqual(['storageBytes']);
      expect(blocked[0].blockedReason).toBeTruthy();

      const sellable = capacity.filter((r) => r.eligibility === 'sellable');
      expect(sellable.map((r) => r.resourceMetric).sort()).toEqual(
        ['branches', 'customers', 'employees', 'knowledgeBaseFiles', 'trainingFiles', 'uploadedFiles'].sort(),
      );
      for (const item of sellable) {
        expect(item.blockedReason).toBeUndefined();
      }
    });

    it('the three byte-denominated items are bigint-backed; every count-based item is not', () => {
      const bigintItems = capacity.filter((r) => r.isBigInt);
      expect(bigintItems.map((r) => r.resourceMetric).sort()).toEqual(
        ['storageBytes', 'trainingFiles', 'uploadedFiles'].sort(),
      );
    });
  });

  describe('eligibility invariants (all items)', () => {
    it('every blocked item carries a non-empty blockedReason; every sellable item carries none', () => {
      for (const item of SELLABLE_RESOURCE_REGISTRY) {
        if (item.eligibility === 'blocked') {
          expect(item.blockedReason).toBeTruthy();
        } else {
          expect(item.blockedReason).toBeUndefined();
        }
      }
    });

    it('every enforcement seam is a non-empty description', () => {
      for (const item of SELLABLE_RESOURCE_REGISTRY) {
        expect(item.enforcement.length).toBeGreaterThan(0);
      }
    });
  });

  describe('findSellableResource', () => {
    it('finds a registered item by key', () => {
      expect(findSellableResource(USAGE_METRIC.AI_TOKENS)?.kind).toBe(SELLABLE_KIND.CREDIT);
      expect(findSellableResource('branches')?.kind).toBe(SELLABLE_KIND.CAPACITY);
    });

    it('returns undefined for an unknown key', () => {
      expect(findSellableResource('not_a_real_item')).toBeUndefined();
    });
  });

  // NOTE: the plan's §7 also calls for asserting "every registry item has a
  // grant path in ResourceEntitlementListener (asserted by a switch with an
  // assertNever default)". That listener is Phase 2.3 — it does not exist
  // yet, so that assertion cannot be written without importing a module this
  // phase has no business depending on. Deferred to
  // `resource-entitlement.listener.spec.ts` when Phase 2.3 is implemented;
  // flagged explicitly in this session's report rather than stubbed here.
});
