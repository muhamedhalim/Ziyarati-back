import { AiToolDispatchService } from './ai-tool-dispatch.service';

describe('AiToolDispatchService side-effect idempotency', () => {
  it('does not replay an unknown-outcome side effect', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValueOnce([
        {
          id: 'tool-1',
          status: 'UNKNOWN_OUTCOME',
          result: null,
        },
      ]),
    };
    const service = new AiToolDispatchService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      dataSource as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const executor = jest.fn();
    const result = await (service as any).run(
      { tenantId: 'tenant-1', aiConversationId: 'conv-1' },
      'book_appointment',
      'stable-key',
      {},
      executor,
    );
    expect(executor).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ success: false }));
  });

  // AI-008/C1 (FR-023, FR-027, R3): the record step (recordAttempt) uses a
  // namespaced key that can NEVER equal a real claim key — by construction,
  // not convention. This is a UNIT-level guard on that construction; T083's
  // end-to-end test proves the resulting non-interference against a real
  // database — neither replaces the other.
  it('recordAttempt inserts under an attempt:<tool>:<uuid> key that cannot collide with any real claim key', async () => {
    const dataSource = { query: jest.fn().mockResolvedValueOnce([]) };
    // AI-016/AI-017 (T072/T073): writeAttemptRow now calls
    // this.tenantContext.getCorrelationId() and reads ctx.principal/
    // ctx.actorUserId — this can no longer be `{}`.
    const tenantContext = { getCorrelationId: jest.fn().mockReturnValue(null) };
    const service = new AiToolDispatchService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      dataSource as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      tenantContext as any,
      {} as any,
      {} as any,
    );

    await (service as any).recordAttempt(
      { tenantId: 'tenant-1', aiConversationId: 'conv-1' },
      'book_appointment',
      { customerId: 'cust-1' },
      'DENIED',
      'Forbidden: booking requires the "appointments.create" permission.',
    );

    expect(dataSource.query).toHaveBeenCalledTimes(1);
    const [sql, params] = dataSource.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO ai_tool_calls/);
    // Params order: tenant_id, ai_conversation_id, conversation_id, tool_name,
    // arguments, status, error, idempotency_key, correlation_id, actor_user_id.
    const key = params[7] as string;
    expect(key).toMatch(
      /^attempt:book_appointment:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // The reserved `attempt:` prefix is not a substring any real claim-key
    // template in this file produces (e.g. `book:${convId}:${staffId}:${startAt}`,
    // `check:${uuid}`, `handover:${convId}`, `insurance_status:${uuid}`,
    // `admin:${name}:${uuid}`) — none begin with `attempt:`, so this key can
    // never equal one of theirs regardless of what any caller supplies.
    expect(key.startsWith('attempt:')).toBe(true);
    expect(params[5]).toBe('DENIED');
    expect(params[6]).toMatch(/Forbidden/);
  });
});
