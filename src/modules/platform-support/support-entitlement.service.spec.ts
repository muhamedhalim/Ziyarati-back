import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { ErrorCode } from '../../common/errors';
import { FeatureResolverService } from '../subscription-billing/feature-resolver.service';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

import { SupportClinicResolver } from './support-clinic.resolver';
import { SupportEntitlementService } from './support-entitlement.service';

const TENANT_ID = '22222222-2222-4222-8222-222222222222';

const feature = (over: Partial<Record<string, unknown>> = {}) => ({
  featureKey: 'ai_assistant',
  name: 'AI Assistant',
  category: 'ai',
  description: 'Conversational assistant',
  visibility: 'PUBLIC',
  isBeta: false,
  isDeprecated: false,
  enabled: true,
  override: null,
  allowedPlanIds: ['plan-pro', 'plan-enterprise'],
  planIncluded: true,
  dependencies: [],
  missingDependencies: [],
  dependenciesSatisfied: true,
  usageMetric: 'AI_TOKENS',
  usage: { used: 820, limit: 1000, remaining: 180, percentUsed: 82, exceeded: false },
  available: true,
  blockedReason: null,
  ...over,
});

const resolution = (over: Partial<Record<string, unknown>> = {}) => ({
  subscription: {
    active: true,
    enforced: true,
    status: 'ACTIVE',
    source: 'SUBSCRIPTION',
    planId: 'plan-pro',
    planName: 'Professional',
    expiresAt: '2026-12-31T00:00:00.000Z',
  },
  features: [feature()],
  ...over,
});

describe('SupportEntitlementService', () => {
  let service: SupportEntitlementService;
  let tenants: MockRepository;
  let resolver: { resolveTenant: jest.Mock };

  beforeEach(async () => {
    tenants = createMockRepository();
    tenants.exists.mockResolvedValue(true);
    resolver = { resolveTenant: jest.fn().mockResolvedValue(resolution()) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SupportEntitlementService,
        SupportClinicResolver,
        { provide: getRepositoryToken(Tenant), useValue: tenants },
        { provide: FeatureResolverService, useValue: resolver },
      ],
    }).compile();

    service = moduleRef.get(SupportEntitlementService);
  });

  it('composes FeatureResolverService rather than re-deriving entitlement — one call, no second source of truth', async () => {
    await service.subscription(TENANT_ID);
    await service.featureMatrix(TENANT_ID);

    expect(resolver.resolveTenant).toHaveBeenCalledTimes(2);
    expect(resolver.resolveTenant).toHaveBeenCalledWith(TENANT_ID);
  });

  describe('subscription', () => {
    it('returns exactly the allow-listed keys — nothing about pricing, cost or margins', async () => {
      const result = await service.subscription(TENANT_ID);

      expect(Object.keys(result).sort()).toEqual(
        [
          'accessAllowed',
          'accessSource',
          'expiresAt',
          'featuresAvailable',
          'featuresBlockedByReason',
          'featuresTotal',
          'planId',
          'planName',
          'quotasEnforced',
          'status',
          'usage',
        ].sort(),
      );
      const serialized = JSON.stringify(result);
      for (const forbidden of ['price', 'cost', 'margin', 'amount', 'currency']) {
        expect(serialized.toLowerCase()).not.toContain(forbidden);
      }
    });

    it('surfaces free-mode / override access as the explanation for "the limits are not applying to us"', async () => {
      resolver.resolveTenant.mockResolvedValue(
        resolution({
          subscription: {
            active: true,
            enforced: false,
            status: 'OVERRIDE',
            source: 'FREE_OVERRIDE',
            planId: null,
            planName: null,
            expiresAt: null,
          },
        }),
      );

      const result = await service.subscription(TENANT_ID);

      expect(result.accessAllowed).toBe(true);
      expect(result.quotasEnforced).toBe(false);
      expect(result.accessSource).toBe('FREE_OVERRIDE');
    });

    it('rolls blocked features up by reason so the headline cause is visible without the full matrix', async () => {
      resolver.resolveTenant.mockResolvedValue(
        resolution({
          features: [
            feature({ available: true, blockedReason: null }),
            feature({ featureKey: 'a', available: false, blockedReason: 'plan_restricted' }),
            feature({ featureKey: 'b', available: false, blockedReason: 'plan_restricted' }),
            feature({ featureKey: 'c', available: false, blockedReason: 'quota_exceeded' }),
          ],
        }),
      );

      const result = await service.subscription(TENANT_ID);

      expect(result.featuresTotal).toBe(4);
      expect(result.featuresAvailable).toBe(1);
      expect(result.featuresBlockedByReason).toEqual({
        plan_restricted: 2,
        quota_exceeded: 1,
      });
    });

    it('deduplicates usage lines by metric — four AI features must not render the same quota four times', async () => {
      resolver.resolveTenant.mockResolvedValue(
        resolution({
          features: [
            feature({ featureKey: 'ai_a', usageMetric: 'AI_TOKENS' }),
            feature({ featureKey: 'ai_b', usageMetric: 'AI_TOKENS' }),
            feature({
              featureKey: 'wa',
              usageMetric: 'WHATSAPP_MESSAGES',
              usage: { used: 10, limit: 50, remaining: 40, percentUsed: 20, exceeded: false },
            }),
            feature({ featureKey: 'plain', usageMetric: null, usage: null }),
          ],
        }),
      );

      const { usage } = await service.subscription(TENANT_ID);

      expect(usage.map((u) => u.metric)).toEqual(['AI_TOKENS', 'WHATSAPP_MESSAGES']);
      expect(usage[0]).toEqual({
        metric: 'AI_TOKENS',
        used: 820,
        limit: 1000,
        remaining: 180,
        percentUsed: 82,
        exceeded: false,
      });
    });

    it('404s an unknown clinic before touching the resolver', async () => {
      tenants.exists.mockResolvedValue(false);

      await expect(service.subscription(TENANT_ID)).rejects.toMatchObject({
        code: ErrorCode.TENANT_NOT_FOUND,
      });
      expect(resolver.resolveTenant).not.toHaveBeenCalled();
    });
  });

  describe('featureMatrix', () => {
    it('emits per-feature signals a human can read as a decision chain, and a machine-readable reason', async () => {
      resolver.resolveTenant.mockResolvedValue(
        resolution({
          features: [
            feature({
              featureKey: 'public_ai_booking',
              name: 'Public AI Booking',
              enabled: false,
              override: false,
              planIncluded: true,
              available: false,
              blockedReason: 'disabled',
            }),
          ],
        }),
      );

      const { features } = await service.featureMatrix(TENANT_ID);

      expect(features[0]).toEqual({
        featureKey: 'public_ai_booking',
        name: 'Public AI Booking',
        category: 'ai',
        description: 'Conversational assistant',
        enabled: false,
        clinicOverride: false,
        planIncluded: true,
        dependencies: [],
        missingDependencies: [],
        dependenciesSatisfied: true,
        usageMetric: 'AI_TOKENS',
        usage: { used: 820, limit: 1000, remaining: 180, percentUsed: 82, exceeded: false },
        available: false,
        blockedReason: 'disabled',
      });
    });

    it('drops the plan catalogue matrix — Support sees "included for THIS clinic", not which plans have it', async () => {
      const { features } = await service.featureMatrix(TENANT_ID);

      expect(features[0]).not.toHaveProperty('allowedPlanIds');
      expect(JSON.stringify(features)).not.toContain('plan-enterprise');
    });

    it('drops product-roadmap metadata that is not operational state', async () => {
      const { features } = await service.featureMatrix(TENANT_ID);

      expect(features[0]).not.toHaveProperty('visibility');
      expect(features[0]).not.toHaveProperty('isBeta');
      expect(features[0]).not.toHaveProperty('isDeprecated');
    });

    it('reports missing dependencies so "the module vanished" resolves to its actual cause', async () => {
      resolver.resolveTenant.mockResolvedValue(
        resolution({
          features: [
            feature({
              available: false,
              blockedReason: 'dependency_missing',
              dependencies: ['whatsapp'],
              missingDependencies: ['whatsapp'],
              dependenciesSatisfied: false,
            }),
          ],
        }),
      );

      const { features } = await service.featureMatrix(TENANT_ID);

      expect(features[0].blockedReason).toBe('dependency_missing');
      expect(features[0].missingDependencies).toEqual(['whatsapp']);
    });
  });
});
