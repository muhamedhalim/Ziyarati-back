import { ConfigService } from '@nestjs/config';

import { AiExecutionPolicyService } from './ai-execution-policy.service';
import { AiProcessingPolicyService } from './ai-processing-policy.service';
import { AI_EXECUTION_MODE, AI_FEATURE } from './ai-execution.constants';

const TENANT = 'tenant-1';

/** A residency decision as `AiDataResidencyService.resolve()` would return it. */
const residencyOff = { enforced: false, region: null, deploymentId: null, options: null };
const residencyOn = {
  enforced: true,
  region: 'eu',
  deploymentId: 'dep-1',
  options: { apiKey: 'k' },
};

function build(opts: {
  batchEnabled?: boolean;
  residency?: typeof residencyOff | typeof residencyOn;
  residencyThrows?: Error;
  entitled?: boolean;
  residencyRequiredFeatures?: string;
} = {}) {
  const config = new ConfigService({
    AI_BATCH_ENABLED: opts.batchEnabled ? 'true' : 'false',
    AI_RESIDENCY_REQUIRED_FEATURES: opts.residencyRequiredFeatures ?? '',
  });
  const residency = {
    resolve: jest.fn(async () => {
      if (opts.residencyThrows) throw opts.residencyThrows;
      return opts.residency ?? residencyOff;
    }),
  };
  const entitled = opts.entitled ?? true;
  const access = {
    resolve: jest.fn(async () => ({ allowed: entitled, source: 'none', reason: 'x' })),
    // `shouldBlock` true ⇒ a denial really denies (the platform's enforcing posture).
    shouldBlock: jest.fn(() => true),
  };
  const service = new AiProcessingPolicyService(
    config,
    new AiExecutionPolicyService(config),
    residency as never,
    access as never,
  );
  return { service, residency, access };
}

describe('AiProcessingPolicyService', () => {
  describe('execution mode', () => {
    it.each([
      AI_FEATURE.CHAT,
      AI_FEATURE.WHATSAPP_CHAT,
      AI_FEATURE.BOOKING_CHAT,
      AI_FEATURE.LIVE_CHAT,
    ])('keeps interactive feature %s on STANDARD', async (feature) => {
      const { service } = build({ batchEnabled: true });
      const d = await service.resolve({
        tenantId: TENANT,
        feature,
        route: 'ai.chat.api',
        latencyRequirement: 'IMMEDIATE',
      });
      expect(d.executionMode).toBe(AI_EXECUTION_MODE.STANDARD);
      expect(d.label).toBe('STANDARD');
    });

    it('routes a deferrable bulk workload to BATCH when enabled and entitled', async () => {
      const { service } = build({ batchEnabled: true });
      const d = await service.resolve({
        tenantId: TENANT,
        feature: AI_FEATURE.BULK_EMBEDDING,
        route: 'ai.bulk',
        latencyRequirement: 'DEFERRABLE',
      });
      expect(d.executionMode).toBe(AI_EXECUTION_MODE.BATCH);
      expect(d.label).toBe('BATCH');
    });

    it.each([
      AI_FEATURE.BULK_EMBEDDING,
      AI_FEATURE.REPORT,
      AI_FEATURE.ANALYTICS,
      AI_FEATURE.EVALUATION,
    ])('routes deferrable %s to BATCH', async (feature) => {
      const { service } = build({ batchEnabled: true });
      const d = await service.resolve({
        tenantId: TENANT,
        feature,
        route: 'ai.bulk',
        latencyRequirement: 'DEFERRABLE',
      });
      expect(d.executionMode).toBe(AI_EXECUTION_MODE.BATCH);
    });

    it('IMMEDIATE overrides a feature the map would otherwise batch — the second guard', async () => {
      const { service } = build({ batchEnabled: true });
      const d = await service.resolve({
        tenantId: TENANT,
        // A BATCH-mapped feature, but a human is waiting on it.
        feature: AI_FEATURE.REPORT,
        route: 'ai.report',
        latencyRequirement: 'IMMEDIATE',
      });
      expect(d.executionMode).toBe(AI_EXECUTION_MODE.STANDARD);
      expect(d.reason).toContain('immediate_standard');
    });

    it('degrades BATCH to STANDARD when the tenant is not entitled — never refuses', async () => {
      const { service } = build({ batchEnabled: true, entitled: false });
      const d = await service.resolve({
        tenantId: TENANT,
        feature: AI_FEATURE.BULK_EMBEDDING,
        route: 'ai.bulk',
        latencyRequirement: 'DEFERRABLE',
      });
      expect(d.executionMode).toBe(AI_EXECUTION_MODE.STANDARD);
      expect(d.reason).toContain('batch_not_entitled_standard');
    });

    it('keeps STANDARD when the platform batch flag is off', async () => {
      const { service } = build({ batchEnabled: false });
      const d = await service.resolve({
        tenantId: TENANT,
        feature: AI_FEATURE.BULK_EMBEDDING,
        route: 'ai.bulk',
        latencyRequirement: 'DEFERRABLE',
      });
      expect(d.executionMode).toBe(AI_EXECUTION_MODE.STANDARD);
    });
  });

  describe('data residency', () => {
    it('is not required when the tenant has no enforced deployment', async () => {
      const { service } = build();
      const d = await service.resolve({
        tenantId: TENANT,
        feature: AI_FEATURE.CHAT,
        route: 'ai.chat.api',
        latencyRequirement: 'IMMEDIATE',
      });
      expect(d.residencyRequired).toBe(false);
      expect(d.region).toBeNull();
      expect(d.label).toBe('STANDARD');
    });

    it('is required, with a region, when the tenant deployment enforces it', async () => {
      const { service } = build({ residency: residencyOn });
      const d = await service.resolve({
        tenantId: TENANT,
        feature: AI_FEATURE.CHAT,
        route: 'ai.chat.api',
        latencyRequirement: 'IMMEDIATE',
      });
      expect(d.residencyRequired).toBe(true);
      expect(d.region).toBe('eu');
      expect(d.label).toBe('STANDARD+RESIDENCY');
    });

    it('REFUSES rather than processing globally when the tenant is not entitled', async () => {
      const { service } = build({ residency: residencyOn, entitled: false });
      await expect(
        service.resolve({
          tenantId: TENANT,
          feature: AI_FEATURE.CHAT,
          route: 'ai.chat.api',
          latencyRequirement: 'IMMEDIATE',
        }),
      ).rejects.toMatchObject({
        publicContext: { reason: 'AI_COMPLIANCE_ROUTE_UNAVAILABLE' },
      });
    });

    it('REFUSES when platform policy requires a region the tenant cannot provide', async () => {
      const { service } = build({
        residency: residencyOff,
        residencyRequiredFeatures: AI_FEATURE.CHAT,
      });
      await expect(
        service.resolve({
          tenantId: TENANT,
          feature: AI_FEATURE.CHAT,
          route: 'ai.chat.api',
          latencyRequirement: 'IMMEDIATE',
        }),
      ).rejects.toMatchObject({
        publicContext: { reason: 'AI_COMPLIANCE_ROUTE_UNAVAILABLE' },
      });
    });

    it('propagates the resolver’s own fail-closed throw untouched', async () => {
      const boom = new Error('deployment misconfigured');
      const { service } = build({ residencyThrows: boom });
      await expect(
        service.resolve({
          tenantId: TENANT,
          feature: AI_FEATURE.CHAT,
          route: 'ai.chat.api',
          latencyRequirement: 'IMMEDIATE',
        }),
      ).rejects.toBe(boom);
    });

    it('performs no residency lookup cost when the flag is off (single call, short-circuits inside)', async () => {
      const { service, residency } = build();
      await service.resolve({
        tenantId: TENANT,
        feature: AI_FEATURE.CHAT,
        route: 'ai.chat.api',
        latencyRequirement: 'IMMEDIATE',
      });
      expect(residency.resolve).toHaveBeenCalledTimes(1);
    });
  });

  describe('the two dimensions are independent', () => {
    it('combines BATCH with residency rather than treating them as exclusive', async () => {
      const { service } = build({ batchEnabled: true, residency: residencyOn });
      const d = await service.resolve({
        tenantId: TENANT,
        feature: AI_FEATURE.BULK_EMBEDDING,
        route: 'ai.bulk',
        latencyRequirement: 'DEFERRABLE',
      });
      expect(d.executionMode).toBe(AI_EXECUTION_MODE.BATCH);
      expect(d.residencyRequired).toBe(true);
      expect(d.label).toBe('BATCH+RESIDENCY');
    });

    it('records the data-sensitivity classification without letting it force residency', async () => {
      const { service } = build();
      const d = await service.resolve({
        tenantId: TENANT,
        feature: AI_FEATURE.CHAT,
        route: 'ai.chat.api',
        latencyRequirement: 'IMMEDIATE',
        dataSensitivity: 'SENSITIVE',
      });
      // Serving clinics is not, on its own, a residency requirement.
      expect(d.residencyRequired).toBe(false);
      expect(d.reason).toContain('sensitivity_sensitive');
    });
  });
});
