import { AiMetricsService, RecordMetricInput } from './ai-metrics.service';
import {
  createMockDataSource,
  createMockRepository,
} from '../../../test/utils/mock-factories';

const baseInput: RecordMetricInput = {
  tenantId: 'tenant-a',
  aiConversationId: 'conv-1',
  channel: 'DASHBOARD',
  model: 'gpt-4o-mini',
  streamed: false,
  fallback: false,
  success: true,
  promptTokens: 10,
  completionTokens: 20,
  costUsd: 0.01,
  toolCallsCount: 0,
  toolSuccessCount: 0,
  toolFailureCount: 0,
  toolCallsTruncated: 0,
  promptDisclosureBlocked: false,
  toolExecMs: 0,
  totalLatencyMs: 50,
};

// AI-016/AI-017 (M2, FR-030, FR-032, FR-033, FR-034, FR-101a): the write
// side gains two optional fields — pinned here since no prior test in this
// file exercises `record()` at all.
describe('AiMetricsService.record — correlation id + actor user id (M2)', () => {
  it('passes correlationId and actorUserId through unchanged', async () => {
    const metrics = createMockRepository();
    const dataSource = createMockDataSource();
    const service = new AiMetricsService(metrics as never, dataSource as never);

    await service.record({
      ...baseInput,
      correlationId: 'corr-abc',
      actorUserId: 'user-1',
    });

    expect(metrics.create).toHaveBeenCalledWith(
      expect.objectContaining({
        correlation_id: 'corr-abc',
        actor_user_id: 'user-1',
      }),
    );
    expect(metrics.save).toHaveBeenCalled();
  });

  it('writes actor_user_id as explicit null for a guest turn — a value, not an omission (FR-034)', async () => {
    const metrics = createMockRepository();
    const dataSource = createMockDataSource();
    const service = new AiMetricsService(metrics as never, dataSource as never);

    await service.record({ ...baseInput, correlationId: 'corr-guest', actorUserId: null });

    const saved = metrics.create.mock.calls[0][0];
    expect(saved).toHaveProperty('actor_user_id', null);
    expect(saved.actor_user_id).not.toBeUndefined();
  });

  it('writes both fields as explicit null when omitted from the input entirely (never established)', async () => {
    const metrics = createMockRepository();
    const dataSource = createMockDataSource();
    const service = new AiMetricsService(metrics as never, dataSource as never);

    await service.record({ ...baseInput });

    const saved = metrics.create.mock.calls[0][0];
    expect(saved).toHaveProperty('correlation_id', null);
    expect(saved).toHaveProperty('actor_user_id', null);
  });

  it('every existing field is unchanged by the M2 addition', async () => {
    const metrics = createMockRepository();
    const dataSource = createMockDataSource();
    const service = new AiMetricsService(metrics as never, dataSource as never);

    await service.record({
      ...baseInput,
      toolCallsCount: 3,
      toolSuccessCount: 2,
      toolFailureCount: 1,
    });

    expect(metrics.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: { id: 'tenant-a' },
        ai_conversation_id: 'conv-1',
        channel: 'DASHBOARD',
        model: 'gpt-4o-mini',
        success: true,
        tool_calls_count: 3,
        tool_success_count: 2,
        tool_failure_count: 1,
        total_latency_ms: 50,
      }),
    );
  });
});

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
