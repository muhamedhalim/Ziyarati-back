import { RefundsProcessor } from './refunds.processor';
import { RefundRecoveryService } from '../../modules/payments/refund-recovery.service';
import { FinancialMetricsService } from '../../modules/payments/financial-metrics.service';

describe('RefundsProcessor', () => {
  it('reaps stale pending refunds and records a heartbeat', async () => {
    const recovery = { reapStalePending: jest.fn().mockResolvedValue({ finalized: 2 }) };
    const metrics = { recordReaperHeartbeat: jest.fn().mockResolvedValue(undefined) };
    const processor = new RefundsProcessor(
      recovery as unknown as RefundRecoveryService,
      metrics as unknown as FinancialMetricsService,
    );

    const result = await processor.process({} as any);
    expect(result).toEqual({ finalized: 2 });
    expect(metrics.recordReaperHeartbeat).toHaveBeenCalledWith({ finalized: 2 });
  });
});
