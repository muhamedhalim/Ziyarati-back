import { AiMetricsService } from './ai-metrics.service';
import {
  createMockDataSource,
  createMockRepository,
} from '../../../test/utils/mock-factories';

describe('AiMetricsService clinic response privacy', () => {
  it('returns usage and performance metrics without provider cost fields', async () => {
    const metrics = createMockRepository();
    const dataSource = createMockDataSource();
    dataSource.query
      .mockResolvedValueOnce([
        {
          n: '2',
          error_count: '0',
          streamed_count: '1',
          avg_latency_ms: '25',
          p50_latency_ms: '20',
          p95_latency_ms: '40',
          p99_latency_ms: '45',
          avg_first_token_ms: '5',
          p50_first_token_ms: '5',
          p95_first_token_ms: '8',
          p99_first_token_ms: '10',
          avg_streaming_duration_ms: '12',
          avg_rag_retrieval_ms: '3',
          avg_embedding_ms: '2',
          avg_tool_exec_ms: '4',
          tool_calls: '1',
          tool_success: '1',
          tool_failure: '0',
          prompt_tokens: '10',
          completion_tokens: '20',
          total_tokens: '30',
          total_latency_ms_sum: '50',
        },
      ])
      .mockResolvedValueOnce([
        {
          model: 'gpt-4o-mini',
          requests: '2',
          tokens: '30',
          avg_latency_ms: '25',
        },
      ]);

    const service = new AiMetricsService(metrics as never, dataSource as never);
    const result = await service.summary('tenant-a', {} as never);

    expect(result).toEqual(
      expect.objectContaining({
        requests: 2,
        tokens: expect.objectContaining({ total: 30 }),
      }),
    );
    expect(result).not.toHaveProperty('costUsd');
    expect(result.byModel[0]).not.toHaveProperty('costUsd');
    expect(dataSource.query.mock.calls[0][0]).not.toContain('cost_usd');
  });

  it('does not include provider cost in the clinic time series', async () => {
    const metrics = createMockRepository();
    const dataSource = createMockDataSource();
    dataSource.query.mockResolvedValueOnce([
      {
        day: new Date('2026-08-01T00:00:00.000Z'),
        requests: '2',
        avg_latency_ms: '25',
        tokens: '30',
        errors: '0',
      },
    ]);

    const service = new AiMetricsService(metrics as never, dataSource as never);
    const result = await service.timeSeries('tenant-a', {} as never);

    expect(result[0]).toEqual({
      date: '2026-08-01',
      requests: 2,
      avgLatencyMs: 25,
      tokens: 30,
      errors: 0,
    });
    expect(dataSource.query.mock.calls[0][0]).not.toContain('cost_usd');
  });
});
