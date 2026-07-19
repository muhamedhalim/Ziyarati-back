import { AiAnalyticsService } from './ai-analytics.service';

describe('AiAnalyticsService cost isolation', () => {
  it('always binds the authenticated tenant as the first ledger scope parameter', async () => {
    const dataSource = { query: jest.fn().mockResolvedValue([]) };
    const service = new AiAnalyticsService(
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      dataSource as any,
    );
    await service.costAttribution('tenant-a', {
      from: '2026-01-01', to: '2026-02-01',
      conversationId: '00000000-0000-4000-8000-000000000001',
    });
    const [sql, params] = dataSource.query.mock.calls[0];
    expect(sql).toContain('WHERE tenant_id=$1');
    expect(params[0]).toBe('tenant-a');
    expect(sql).toContain('ai_conversation_id');
    expect(params.at(-1)).toBe('00000000-0000-4000-8000-000000000001');
    expect(sql).not.toContain('prompt');
    expect(sql).not.toContain('response');
  });
});
