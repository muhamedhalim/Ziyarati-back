import { BillingUpgradeAiEstimateService } from './billing-upgrade-ai-estimate.service';
import { BILLING_UPGRADE_TYPE } from './billing-upgrade.constants';

describe('BillingUpgradeAiEstimateService', () => {
  let providers: { resolve: jest.Mock };
  let config: { unitProviderCostMinor: jest.Mock; unitInfraCostMinor: jest.Mock; fallbackMarginMultiplier: number };
  let service: BillingUpgradeAiEstimateService;

  const input = {
    requestType: BILLING_UPGRADE_TYPE.USAGE_LIMIT,
    targetKey: 'AI_TOKENS',
    requestedQuantity: 100,
    currentUsage: 40,
    currentLimit: 50,
    billingPeriod: 'monthly',
    historicalAverageUsage: 45,
    currency: 'SAR',
  } as const;

  beforeEach(() => {
    providers = { resolve: jest.fn() };
    config = {
      unitProviderCostMinor: jest.fn().mockReturnValue(2),
      unitInfraCostMinor: jest.fn().mockReturnValue(1),
      fallbackMarginMultiplier: 1.3,
    };
    service = new BillingUpgradeAiEstimateService(providers as any, config as any);
  });

  it('never blocks manual pricing — falls back to a heuristic when the provider throws', async () => {
    providers.resolve.mockReturnValue({ complete: jest.fn().mockRejectedValue(new Error('provider down')) });

    const result = await service.estimate(input);

    expect(result.source).toBe('heuristic_fallback');
    expect(result.error).toBeDefined();
    expect(result.recommendedPriceMinor).toBeGreaterThanOrEqual(0);
  });

  it('falls back to the heuristic when the provider returns malformed JSON', async () => {
    providers.resolve.mockReturnValue({
      complete: jest.fn().mockResolvedValue({ content: 'not json at all', fallback: false }),
    });

    const result = await service.estimate(input);

    expect(result.source).toBe('heuristic_fallback');
    expect(result.error).toContain('not in the expected format');
  });

  it('falls back to the heuristic when only the no-op provider is configured', async () => {
    providers.resolve.mockReturnValue({
      complete: jest.fn().mockResolvedValue({ content: 'AI provider is not configured', fallback: true }),
    });

    const result = await service.estimate(input);
    expect(result.source).toBe('heuristic_fallback');
  });

  it('uses the AI-derived figures when the response is well-formed', async () => {
    providers.resolve.mockReturnValue({
      complete: jest.fn().mockResolvedValue({
        content: JSON.stringify({
          estimatedProviderCostMinor: 500,
          estimatedInfraCostMinor: 200,
          recommendedPriceMinor: 1000,
          confidenceScore: 0.8,
          assumptions: ['based on historical average'],
          pricingBreakdown: { base: 700 },
        }),
        fallback: false,
      }),
    });

    const result = await service.estimate(input);

    expect(result).toMatchObject({
      source: 'ai',
      estimatedProviderCostMinor: 500,
      estimatedInfraCostMinor: 200,
      recommendedPriceMinor: 1000,
      confidenceScore: 0.8,
    });
    expect(result.error).toBeUndefined();
  });

  it('clamps an out-of-range confidence score into [0, 1]', async () => {
    providers.resolve.mockReturnValue({
      complete: jest.fn().mockResolvedValue({
        content: JSON.stringify({
          estimatedProviderCostMinor: 100,
          estimatedInfraCostMinor: 50,
          recommendedPriceMinor: 200,
          confidenceScore: 5,
          assumptions: [],
          pricingBreakdown: {},
        }),
        fallback: false,
      }),
    });

    const result = await service.estimate(input);
    expect(result.confidenceScore).toBe(1);
  });

  it('never sends tenant/customer/patient identity — only aggregate numeric context reaches the prompt', async () => {
    const complete = jest.fn().mockResolvedValue({
      content: JSON.stringify({
        estimatedProviderCostMinor: 0,
        estimatedInfraCostMinor: 0,
        recommendedPriceMinor: 0,
        confidenceScore: 0.5,
        assumptions: [],
        pricingBreakdown: {},
      }),
      fallback: false,
    });
    providers.resolve.mockReturnValue({ complete });

    await service.estimate(input);

    const request = complete.mock.calls[0][0];
    // `tenantId` is a required AiCompletionRequest field, but must never carry a
    // real tenant id — the sentinel routes the call, it is not sent as content.
    expect(request.tenantId).toBe('platform');
    // The actual prompt content (what the model sees) must be pure numeric/
    // structural context — never a tenant, customer, or patient record.
    const promptContent = request.messages.map((m: { content: string }) => m.content).join('\n');
    expect(promptContent).not.toMatch(/customer/i);
    expect(promptContent).not.toMatch(/patient/i);
    expect(promptContent).not.toMatch(/tenant-a|t1\b/); // no real tenant id from the test input leaks in
  });
});
