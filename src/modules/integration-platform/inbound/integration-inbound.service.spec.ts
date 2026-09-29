import { QueryFailedError } from 'typeorm';

import { IntegrationInboundService } from './integration-inbound.service';
import { IntegrationWebhookEndpointService } from './integration-webhook-endpoint.service';
import { computeInboundSignature } from './inbound-signature';
import {
  CONNECTION_STATUS,
  DEFAULT_WEBHOOK_SIGNATURE_SCHEME,
  INBOUND_HEADER,
  INBOUND_REJECTION,
  INBOUND_STATUS,
  WEBHOOK_ENDPOINT_STATUS,
  WEBHOOK_SIGNATURE_SCHEME,
  WebhookSignatureScheme,
} from '../integration-platform.constants';
import { ErrorCode } from '../../../common/errors';

const SECRET = 'a'.repeat(64);
const TENANT = 'tenant-1';
const CONNECTION = 'conn-1';
const V1 = WEBHOOK_SIGNATURE_SCHEME.HMAC_SHA256_TIMESTAMPED;
const V2 = WEBHOOK_SIGNATURE_SCHEME.HMAC_SHA256_TIMESTAMPED_V2;

function build(
  scheme: WebhookSignatureScheme,
  opts: { alreadySeen?: boolean } = {},
) {
  const endpoint = {
    id: 'ep-1',
    tenant: { id: TENANT },
    signature_scheme: scheme,
    tolerance_seconds: 300,
    allowed_events: ['customer.upserted', 'appointment.created'],
    status: WEBHOOK_ENDPOINT_STATUS.ACTIVE,
    // No provider → the compiled scheme verifies (no adapter override).
    connection: {
      id: CONNECTION,
      status: CONNECTION_STATUS.ACTIVE,
      provider: 'none',
      deleted_at: null,
    },
  };
  const endpoints = {
    findByConnectionId: jest.fn().mockResolvedValue(endpoint),
    secretOf: jest.fn().mockReturnValue(SECRET),
    recordOutcome: jest.fn().mockResolvedValue(undefined),
  };
  const events = {
    findOne: jest
      .fn()
      .mockResolvedValue(opts.alreadySeen ? { id: 'prev' } : null),
    create: jest.fn((x) => x),
    save: jest.fn().mockResolvedValue({}),
  };
  const mgr = {
    create: jest.fn((_entity, x) => x),
    save: jest.fn().mockResolvedValue({ id: 'ev-1' }),
  };
  const dataSource = {
    transaction: jest.fn(async (cb: (m: typeof mgr) => unknown) => cb(mgr)),
  };
  const admission = { admit: jest.fn().mockResolvedValue(undefined) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };

  const svc = new IntegrationInboundService(
    events as never,
    endpoints as never,
    {} as never, // connections
    admission as never,
    {} as never, // idempotency
    {} as never, // upsert
    {} as never, // serviceAccount
    audit as never,
    {} as never, // queue
    dataSource as never,
  );
  return { svc, events, endpoints, dataSource, mgr, audit };
}

interface Send {
  scheme: WebhookSignatureScheme;
  body?: Record<string, unknown>;
  /** What the partner SIGNED (defaults to what it sends). */
  signedMeta?: { eventId?: string; eventType?: string };
  /** What is actually sent in the headers. */
  sendEventId?: string | null;
  sendEventType?: string | null;
  ts?: string;
}

function request(s: Send) {
  const body = JSON.stringify(
    s.body ?? { externalId: 'EXT-1', data: { full_name: 'Sara' } },
  );
  const ts = s.ts ?? String(Math.floor(Date.now() / 1000));
  const eventId = s.sendEventId === undefined ? 'evt-1' : s.sendEventId;
  const eventType =
    s.sendEventType === undefined ? 'customer.upserted' : s.sendEventType;
  const signedMeta = s.signedMeta ?? {
    eventId: eventId ?? undefined,
    eventType: eventType ?? undefined,
  };
  const signature = computeInboundSignature(
    s.scheme,
    SECRET,
    ts,
    body,
    // v2 needs both to sign; a v1 signature ignores them.
    s.scheme === V2
      ? {
          eventId: signedMeta.eventId ?? 'x',
          eventType: signedMeta.eventType ?? 'x',
        }
      : {},
  );
  const headers: Record<string, string> = {
    [INBOUND_HEADER.SIGNATURE]: signature,
    [INBOUND_HEADER.TIMESTAMP]: ts,
  };
  if (eventId !== null) headers[INBOUND_HEADER.EVENT_ID] = eventId;
  if (eventType !== null) headers[INBOUND_HEADER.EVENT_TYPE] = eventType;
  return { body, headers };
}

async function rejection(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as { code: string; publicContext?: { reason?: string } };
  }
  throw new Error('expected the delivery to be rejected');
}

describe('IntegrationInboundService.receive — SEC-01', () => {
  describe('v2 scheme', () => {
    it('accepts a delivery whose event id and type were signed (202) and persists it once', async () => {
      const { svc, dataSource } = build(V2);
      const { body, headers } = request({ scheme: V2 });
      const receipt = await svc.receive(CONNECTION, body, headers);
      expect(receipt.status).toBe(202);
      expect(receipt.body).toMatchObject({
        eventId: 'evt-1',
        status: INBOUND_STATUS.ACCEPTED,
      });
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('REJECTS a captured delivery replayed with a NEW event id (403 invalid_signature, nothing stored)', async () => {
      const { svc, dataSource, events } = build(V2);
      // The attacker keeps the captured signature but edits the unsigned-in-v1 header.
      const captured = request({ scheme: V2 });
      const replay = {
        ...captured.headers,
        [INBOUND_HEADER.EVENT_ID]: 'evt-NEW',
      };
      const err = await rejection(
        svc.receive(CONNECTION, captured.body, replay),
      );
      expect(err.code).toBe(ErrorCode.FORBIDDEN);
      expect(err.publicContext?.reason).toBe(
        INBOUND_REJECTION.INVALID_SIGNATURE,
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(events.save).not.toHaveBeenCalled(); // unauthenticated → no history row
    });

    it('REJECTS a swapped event type on a captured delivery', async () => {
      const { svc, dataSource } = build(V2);
      const captured = request({
        scheme: V2,
        sendEventType: 'customer.upserted',
      });
      const swapped = {
        ...captured.headers,
        [INBOUND_HEADER.EVENT_TYPE]: 'appointment.created',
      };
      const err = await rejection(
        svc.receive(CONNECTION, captured.body, swapped),
      );
      expect(err.publicContext?.reason).toBe(
        INBOUND_REJECTION.INVALID_SIGNATURE,
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('names the missing header instead of a bare "invalid signature"', async () => {
      const noId = build(V2);
      const a = request({
        scheme: V2,
        sendEventId: null,
        signedMeta: { eventId: 'evt-1', eventType: 'customer.upserted' },
      });
      expect(
        (await rejection(noId.svc.receive(CONNECTION, a.body, a.headers)))
          .publicContext?.reason,
      ).toBe(INBOUND_REJECTION.MISSING_EVENT_ID);

      const noType = build(V2);
      const b = request({
        scheme: V2,
        sendEventType: null,
        signedMeta: { eventId: 'evt-1', eventType: 'customer.upserted' },
      });
      expect(
        (await rejection(noType.svc.receive(CONNECTION, b.body, b.headers)))
          .publicContext?.reason,
      ).toBe(INBOUND_REJECTION.MISSING_EVENT_TYPE);
    });

    it('rejects a v1-signed request sent to a v2 endpoint (no downgrade)', async () => {
      const { svc, dataSource } = build(V2);
      const { body, headers } = request({ scheme: V1 });
      const err = await rejection(svc.receive(CONNECTION, body, headers));
      expect(err.publicContext?.reason).toBe(
        INBOUND_REJECTION.INVALID_SIGNATURE,
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe('header / body consistency (every scheme)', () => {
    it('rejects an event-id header that disagrees with the signed body (422 header_body_mismatch, recorded)', async () => {
      const { svc, events, dataSource } = build(V1);
      const { body, headers } = request({
        scheme: V1,
        body: {
          eventId: 'evt-in-body',
          externalId: 'EXT-1',
          data: { full_name: 'Sara' },
        },
        sendEventId: 'evt-swapped-in-header',
      });
      const err = await rejection(svc.receive(CONNECTION, body, headers));
      expect(err.code).toBe(ErrorCode.UNPROCESSABLE_ENTITY);
      expect(err.publicContext?.reason).toBe(
        INBOUND_REJECTION.HEADER_BODY_MISMATCH,
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
      // Authenticated (valid MAC) → the partner gets a history row to debug from.
      expect(events.save).toHaveBeenCalledTimes(1);
    });

    it('rejects an event-type header that disagrees with the signed body', async () => {
      const { svc, dataSource } = build(V1);
      const { body, headers } = request({
        scheme: V1,
        body: { event: 'customer.upserted', externalId: 'EXT-1', data: {} },
        sendEventType: 'appointment.created',
      });
      const err = await rejection(svc.receive(CONNECTION, body, headers));
      expect(err.publicContext?.reason).toBe(
        INBOUND_REJECTION.HEADER_BODY_MISMATCH,
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('accepts headers that AGREE with the body, and a body that states nothing (legacy partners keep working)', async () => {
      const agree = build(V1);
      const a = request({
        scheme: V1,
        body: {
          eventId: 'evt-1',
          event: 'customer.upserted',
          externalId: 'E',
          data: {},
        },
      });
      expect(
        (await agree.svc.receive(CONNECTION, a.body, a.headers)).status,
      ).toBe(202);

      const silent = build(V1);
      const b = request({ scheme: V1 });
      expect(
        (await silent.svc.receive(CONNECTION, b.body, b.headers)).status,
      ).toBe(202);
    });

    it('applies the same check under v2 (a signed header still may not contradict the body)', async () => {
      const { svc } = build(V2);
      const { body, headers } = request({
        scheme: V2,
        body: { eventId: 'evt-in-body', externalId: 'EXT-1', data: {} },
        sendEventId: 'evt-1',
      });
      const err = await rejection(svc.receive(CONNECTION, body, headers));
      expect(err.publicContext?.reason).toBe(
        INBOUND_REJECTION.HEADER_BODY_MISMATCH,
      );
    });
  });

  describe('replay pre-check (does not depend on the unique index existing)', () => {
    it('acks 200 duplicate WITHOUT processing when the event id was already received', async () => {
      const { svc, dataSource, mgr } = build(V2, { alreadySeen: true });
      const { body, headers } = request({ scheme: V2 });
      const receipt = await svc.receive(CONNECTION, body, headers);
      expect(receipt.status).toBe(200);
      expect(receipt.body).toMatchObject({
        status: INBOUND_STATUS.DUPLICATE,
        reason: INBOUND_REJECTION.REPLAYED,
        eventId: 'evt-1',
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(mgr.save).not.toHaveBeenCalled();
    });

    it('looks the event up by (tenant, endpoint, event id) — the same key as the unique index', async () => {
      const { svc, events } = build(V2);
      const { body, headers } = request({ scheme: V2 });
      await svc.receive(CONNECTION, body, headers);
      expect(events.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tenant: { id: TENANT },
            endpoint: { id: 'ep-1' },
            provider_event_id: 'evt-1',
          },
        }),
      );
    });

    it('the unique index remains the race guard: a concurrent duplicate is still acked 200', async () => {
      const { svc, dataSource } = build(V2);
      dataSource.transaction.mockRejectedValueOnce(
        new QueryFailedError(
          'insert',
          [],
          Object.assign(new Error('dup'), { code: '23505' }),
        ),
      );
      const { body, headers } = request({ scheme: V2 });
      const receipt = await svc.receive(CONNECTION, body, headers);
      expect(receipt.status).toBe(200);
      expect(receipt.body.status).toBe(INBOUND_STATUS.DUPLICATE);
    });

    it('does not run before authentication: an unsigned request never reveals whether an id was seen', async () => {
      const { svc, events } = build(V2, { alreadySeen: true });
      const { body, headers } = request({ scheme: V2 });
      const bad = { ...headers, [INBOUND_HEADER.SIGNATURE]: 'sha256=deadbeef' };
      await rejection(svc.receive(CONNECTION, body, bad));
      expect(events.findOne).not.toHaveBeenCalled();
    });
  });
});

describe('new-endpoint default scheme', () => {
  it('is v2, so a freshly created endpoint signs the event id and type', () => {
    expect(DEFAULT_WEBHOOK_SIGNATURE_SCHEME).toBe(V2);
    const svc = Object.create(IntegrationWebhookEndpointService.prototype) as {
      assertScheme(s: string | undefined): string;
    };
    expect(svc.assertScheme(undefined)).toBe(V2);
  });

  it('still lets a caller pick a legacy scheme explicitly, and refuses an unknown one', () => {
    const svc = Object.create(IntegrationWebhookEndpointService.prototype) as {
      assertScheme(s: string | undefined): string;
    };
    expect(svc.assertScheme(V1)).toBe(V1);
    expect(() => svc.assertScheme('md5')).toThrow();
  });
});
