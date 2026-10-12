import { IntegrationInboundService } from './integration-inbound.service';
import { computeInboundSignature } from './inbound-signature';
import {
  ADMISSION_OP,
  CONNECTION_STATUS,
  INBOUND_REJECTION,
  INBOUND_STATUS,
  UPSERT_LIFECYCLE,
  UPSERT_OUTCOME,
  WEBHOOK_ENDPOINT_STATUS,
  WEBHOOK_SIGNATURE_SCHEME,
} from '../integration-platform.constants';
import { AppError, ErrorCode } from '../../../common/errors';

const SECRET = 'b'.repeat(64);
const TENANT = 'tenant-1';
const CONNECTION = 'conn-1';
const V2 = WEBHOOK_SIGNATURE_SCHEME.HMAC_SHA256_TIMESTAMPED_V2;

function build(over: { admit?: jest.Mock } = {}) {
  const endpoint = {
    id: 'ep-1',
    tenant: { id: TENANT },
    signature_scheme: V2,
    tolerance_seconds: 300,
    allowed_events: ['appointment.created', 'customer.upserted'],
    status: WEBHOOK_ENDPOINT_STATUS.ACTIVE,
    connection: { id: CONNECTION, status: CONNECTION_STATUS.ACTIVE, provider: 'none', deleted_at: null },
  };
  const endpoints = {
    findByConnectionId: jest.fn().mockResolvedValue(endpoint),
    secretOf: jest.fn().mockReturnValue(SECRET),
    recordOutcome: jest.fn().mockResolvedValue(undefined),
  };
  const events = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((x) => x),
    save: jest.fn().mockImplementation(async (x) => x),
  };
  const mgr = { create: jest.fn((_e, x) => x), save: jest.fn().mockResolvedValue({ id: 'ev-1' }) };
  const dataSource = { transaction: jest.fn(async (cb: (m: typeof mgr) => unknown) => cb(mgr)) };
  const admission = { admit: over.admit ?? jest.fn().mockResolvedValue(undefined) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const connections = {
    requireActive: jest.fn().mockResolvedValue({ id: CONNECTION }),
    conflictPolicyOf: jest.fn().mockReturnValue('reject_and_report'),
    markSuccess: jest.fn().mockResolvedValue(undefined),
    markError: jest.fn().mockResolvedValue(undefined),
  };
  const idempotency = {
    hashPayload: jest.fn().mockReturnValue('h'),
    begin: jest.fn().mockResolvedValue({ recordId: 'idem-1' }),
    complete: jest.fn().mockResolvedValue(undefined),
    fail: jest.fn().mockResolvedValue(undefined),
  };
  const upsert = {
    upsertOne: jest.fn().mockResolvedValue({ outcome: UPSERT_OUTCOME.UPDATED, externalId: 'EXT', internalId: 'ap-1' }),
  };
  const serviceAccount = { resolve: jest.fn().mockResolvedValue('user-1') };
  const svc = new IntegrationInboundService(
    events as never,
    endpoints as never,
    connections as never,
    admission as never,
    idempotency as never,
    upsert as never,
    serviceAccount as never,
    audit as never,
    {} as never,
    dataSource as never,
  );
  return { svc, endpoint, endpoints, events, admission, audit, upsert, connections };
}

function signed(over: { sig?: string; eventType?: string } = {}) {
  const body = JSON.stringify({ externalId: 'EXT-1', data: { full_name: 'Sara' } });
  const ts = String(Math.floor(Date.now() / 1000));
  const eventType = over.eventType ?? 'customer.upserted';
  const sig = over.sig ?? computeInboundSignature(V2, SECRET, ts, body, { eventId: 'evt-1', eventType });
  return {
    body,
    headers: {
      'x-ziyarati-signature': sig,
      'x-ziyarati-timestamp': ts,
      'x-ziyarati-event-id': 'evt-1',
      'x-ziyarati-event': eventType,
    },
  };
}

describe('F03 — unauthenticated traffic is charged to its own budget', () => {
  it('a bad signature is charged to the UNSIGNED op with the caller ip, never the signed budget', async () => {
    const t = build();
    const r = signed({ sig: 'sha256=' + '0'.repeat(64) });
    await expect(t.svc.receive(CONNECTION, r.body, r.headers, '203.0.113.9')).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
    expect(t.admission.admit).toHaveBeenCalledTimes(1);
    expect(t.admission.admit).toHaveBeenCalledWith(ADMISSION_OP.INBOUND_WEBHOOK_UNSIGNED, {
      tenantId: TENANT,
      connectionId: CONNECTION,
      ip: '203.0.113.9',
    });
  });

  it('a missing signature is also unsigned traffic', async () => {
    const t = build();
    const r = signed();
    delete (r.headers as Record<string, unknown>)['x-ziyarati-signature'];
    await expect(t.svc.receive(CONNECTION, r.body, r.headers, '203.0.113.9')).rejects.toBeInstanceOf(AppError);
    expect(t.admission.admit).toHaveBeenCalledWith(ADMISSION_OP.INBOUND_WEBHOOK_UNSIGNED, expect.anything());
  });

  it('when the unsigned budget is exhausted: 429 and NOTHING is written (no counter, no audit row)', async () => {
    const admit = jest.fn().mockRejectedValue(new AppError(ErrorCode.RATE_LIMITED, { publicContext: { retryAfterMs: 1000 } }));
    const t = build({ admit });
    const r = signed({ sig: 'sha256=' + '0'.repeat(64) });
    await expect(t.svc.receive(CONNECTION, r.body, r.headers, '203.0.113.9')).rejects.toMatchObject({
      code: ErrorCode.RATE_LIMITED,
    });
    expect(t.endpoints.recordOutcome).not.toHaveBeenCalled();
    expect(t.audit.record).not.toHaveBeenCalled();
    expect(t.events.save).not.toHaveBeenCalled();
  });

  it('limiter unavailable on the unsigned path is an explicit 503, not a silent pass', async () => {
    const admit = jest.fn().mockRejectedValue(new AppError(ErrorCode.SERVICE_UNAVAILABLE));
    const t = build({ admit });
    const r = signed({ sig: 'sha256=' + '0'.repeat(64) });
    await expect(t.svc.receive(CONNECTION, r.body, r.headers, '203.0.113.9')).rejects.toMatchObject({
      code: ErrorCode.SERVICE_UNAVAILABLE,
    });
  });

  it('a correctly signed event is charged to the SIGNED budget only, and is accepted after a burst of bad ones', async () => {
    const t = build();
    const bad = signed({ sig: 'sha256=' + '1'.repeat(64) });
    for (let i = 0; i < 5; i += 1) {
      await t.svc.receive(CONNECTION, bad.body, bad.headers, '203.0.113.9').catch(() => undefined);
    }
    t.admission.admit.mockClear();
    const good = signed();
    const res = await t.svc.receive(CONNECTION, good.body, good.headers, '198.51.100.7');
    expect(res.status).toBe(202);
    expect(t.admission.admit).toHaveBeenCalledTimes(1);
    expect(t.admission.admit).toHaveBeenCalledWith(ADMISSION_OP.INBOUND_WEBHOOK, { tenantId: TENANT, connectionId: CONNECTION });
  });

  it('a stale (replayed) but validly-MACed delivery is unsigned-budget traffic too', async () => {
    const t = build();
    const body = JSON.stringify({ externalId: 'EXT-1', data: {} });
    const ts = String(Math.floor(Date.now() / 1000) - 3600);
    const sig = computeInboundSignature(V2, SECRET, ts, body, { eventId: 'evt-1', eventType: 'customer.upserted' });
    const headers = {
      'x-ziyarati-signature': sig,
      'x-ziyarati-timestamp': ts,
      'x-ziyarati-event-id': 'evt-1',
      'x-ziyarati-event': 'customer.upserted',
    };
    await expect(t.svc.receive(CONNECTION, body, headers, '203.0.113.9')).rejects.toMatchObject({
      publicContext: { reason: INBOUND_REJECTION.STALE_TIMESTAMP },
    });
    expect(t.admission.admit).toHaveBeenCalledWith(ADMISSION_OP.INBOUND_WEBHOOK_UNSIGNED, expect.anything());
  });
});

describe('F02 — process() authorises and derives the lifecycle from the event type at apply time', () => {
  function pending(over: Record<string, unknown> = {}) {
    return {
      id: 'ev-1',
      status: INBOUND_STATUS.ACCEPTED,
      attempts: 0,
      event_type: 'appointment.created',
      resource_type: 'appointment',
      external_id: 'EXT-A',
      tenant: { id: TENANT },
      connection: { id: CONNECTION },
      endpoint: {
        id: 'ep-1',
        status: WEBHOOK_ENDPOINT_STATUS.ACTIVE,
        allowed_events: ['appointment.created'],
      },
      // A payload staged by an OLDER build that still forwarded the caller's action:
      payload: { startAt: '2026-10-28T10:00:00+03:00', action: 'cancel', reason: 'smuggled' },
      ...over,
    };
  }

  it('appointment.created → lifecycle CREATE and the payload action is discarded', async () => {
    const t = build();
    t.events.findOne.mockResolvedValueOnce(pending());
    await t.svc.process('ev-1');
    expect(t.upsert.upsertOne).toHaveBeenCalledTimes(1);
    const args = t.upsert.upsertOne.mock.calls[0];
    expect(args[5]).not.toHaveProperty('action');
    expect(args[6]).toEqual({ userId: 'user-1' });
    expect(args[7]).toEqual({ safe: false, lifecycle: UPSERT_LIFECYCLE.CREATE });
  });

  it('appointment.cancelled (allowed) → lifecycle CANCEL with action from the event map', async () => {
    const t = build();
    t.events.findOne.mockResolvedValueOnce(
      pending({
        event_type: 'appointment.cancelled',
        endpoint: { id: 'ep-1', status: WEBHOOK_ENDPOINT_STATUS.ACTIVE, allowed_events: ['appointment.cancelled'] },
        payload: { reason: 'r' },
      }),
    );
    await t.svc.process('ev-1');
    const args = t.upsert.upsertOne.mock.calls[0];
    expect(args[5]).toMatchObject({ action: 'cancel' });
    expect(args[7]).toEqual({ safe: false, lifecycle: UPSERT_LIFECYCLE.CANCEL });
  });

  it('an event type removed from the allow-list after acceptance is NOT applied', async () => {
    const t = build();
    t.events.findOne.mockResolvedValueOnce(
      pending({ endpoint: { id: 'ep-1', status: WEBHOOK_ENDPOINT_STATUS.ACTIVE, allowed_events: ['customer.upserted'] } }),
    );
    await t.svc.process('ev-1');
    expect(t.upsert.upsertOne).not.toHaveBeenCalled();
    const saved = t.events.save.mock.calls.at(-1)![0];
    expect(saved.status).toBe(INBOUND_STATUS.REJECTED);
    expect(saved.rejection_reason).toBe(INBOUND_REJECTION.EVENT_NOT_ALLOWED);
    expect(saved.payload).toBeNull();
  });

  it('an inactive or deleted endpoint is NOT applied', async () => {
    for (const endpoint of [null, { id: 'ep-1', status: WEBHOOK_ENDPOINT_STATUS.INACTIVE, allowed_events: ['appointment.created'] }]) {
      const t = build();
      t.events.findOne.mockResolvedValueOnce(pending({ endpoint }));
      await t.svc.process('ev-1');
      expect(t.upsert.upsertOne).not.toHaveBeenCalled();
      expect(t.events.save.mock.calls.at(-1)![0].rejection_reason).toBe(INBOUND_REJECTION.ENDPOINT_INACTIVE);
    }
  });

  it('an unknown persisted event type is NOT applied', async () => {
    const t = build();
    t.events.findOne.mockResolvedValueOnce(pending({ event_type: 'appointment.deleted' }));
    await t.svc.process('ev-1');
    expect(t.upsert.upsertOne).not.toHaveBeenCalled();
  });

  it('non-appointment events carry no lifecycle', async () => {
    const t = build();
    t.events.findOne.mockResolvedValueOnce(
      pending({
        event_type: 'customer.upserted',
        resource_type: 'customer',
        endpoint: { id: 'ep-1', status: WEBHOOK_ENDPOINT_STATUS.ACTIVE, allowed_events: ['customer.upserted'] },
        payload: { full_name: 'S' },
      }),
    );
    await t.svc.process('ev-1');
    expect(t.upsert.upsertOne.mock.calls[0][7]).toEqual({ safe: false, lifecycle: undefined });
  });
});
