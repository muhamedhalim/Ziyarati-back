import { IntegrationWriteService } from './integration-write.service';
import {
  CONFLICT_REASON,
  INTEGRATION_RESOURCE,
  UPSERT_OUTCOME,
} from '../integration-platform.constants';
import { AppError, ErrorCode } from '../../../common/errors';

function build(upsertResult: Record<string, unknown>) {
  const connections = {
    requireActive: jest.fn().mockResolvedValue({ id: 'c1' }),
    conflictPolicyOf: jest.fn().mockReturnValue('reject_and_report'),
    markSuccess: jest.fn().mockResolvedValue(undefined),
  };
  const idempotency = {
    hashPayload: jest.fn().mockReturnValue('h'),
    begin: jest.fn().mockResolvedValue({ recordId: 'idem-1' }),
    complete: jest.fn().mockResolvedValue(undefined),
    fail: jest.fn().mockResolvedValue(undefined),
  };
  const upsert = { upsertOne: jest.fn().mockResolvedValue(upsertResult) };
  const admission = {
    assertPayloadSize: jest.fn(),
    admit: jest.fn().mockResolvedValue(undefined),
  };
  const serviceAccount = { resolveActorUserId: jest.fn().mockResolvedValue('user-1') };
  const ctx = { getUser: jest.fn().mockReturnValue({ id: 'apikey:k1' }) };
  const svc = new IntegrationWriteService(
    connections as never,
    idempotency as never,
    upsert as never,
    admission as never,
    serviceAccount as never,
    ctx as never,
  );
  return { svc, connections, idempotency, upsert, admission };
}

const call = (svc: IntegrationWriteService, key?: string) =>
  svc.upsertViaApi('t1', INTEGRATION_RESOURCE.CUSTOMER, 'c1', 'EXT-1', { full_name: 'A' }, key, {});

describe('upsertViaApi — conflicted is an explicit 409, never a 200 (F01)', () => {
  it('maps a conflicted outcome to 409 CONFLICT with structured context and releases the key', async () => {
    const t = build({
      outcome: UPSERT_OUTCOME.CONFLICTED,
      externalId: 'EXT-1',
      internalId: 'cu-1',
      changedFields: ['full_name'],
      reason: CONFLICT_REASON.FIELD_DIVERGENCE,
    });
    const err = (await call(t.svc, 'k-1').catch((e) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe(ErrorCode.CONFLICT);
    expect(err.publicContext).toEqual({
      outcome: 'conflicted',
      reason: 'field_divergence',
      externalId: 'EXT-1',
      internalId: 'cu-1',
      changedFields: ['full_name'],
    });
    expect(t.idempotency.fail).toHaveBeenCalledWith('idem-1');
    expect(t.idempotency.complete).not.toHaveBeenCalled();
    expect(t.connections.markSuccess).not.toHaveBeenCalled();
  });

  it('explains an unmatched staff record as queued for review', async () => {
    const t = build({
      outcome: UPSERT_OUTCOME.CONFLICTED,
      externalId: 'EXT-1',
      internalId: null,
      changedFields: ['title'],
      reason: CONFLICT_REASON.STAFF_REQUIRES_ACCOUNT,
    });
    const err = (await call(t.svc).catch((e) => e)) as AppError;
    expect(err.code).toBe(ErrorCode.CONFLICT);
    expect(err.message).toMatch(/queued for the clinic to review/);
    expect((err.publicContext as Record<string, unknown>).reason).toBe('staff_requires_account');
  });

  it.each([UPSERT_OUTCOME.CREATED, UPSERT_OUTCOME.UPDATED, UPSERT_OUTCOME.LINKED, UPSERT_OUTCOME.SKIPPED])(
    'still returns 200 with the outcome for %s',
    async (outcome) => {
      const t = build({ outcome, externalId: 'EXT-1', internalId: 'cu-1' });
      const r = await call(t.svc, 'k-2');
      expect(r.status).toBe(200);
      expect(r.body.outcome).toBe(outcome);
      expect(t.idempotency.complete).toHaveBeenCalledWith('idem-1', 200, expect.objectContaining({ outcome }));
    },
  );
});

describe('upsertViaApi — Idempotency-Key is validated before any work (F07)', () => {
  it('accepts exactly 255 characters', async () => {
    const t = build({ outcome: UPSERT_OUTCOME.CREATED, externalId: 'EXT-1', internalId: 'cu-1' });
    await expect(call(t.svc, 'k'.repeat(255))).resolves.toMatchObject({ status: 200 });
  });

  it('rejects 256 characters with a 400 and does no work at all', async () => {
    const t = build({ outcome: UPSERT_OUTCOME.CREATED, externalId: 'EXT-1', internalId: 'cu-1' });
    await expect(call(t.svc, 'k'.repeat(256))).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(t.admission.admit).not.toHaveBeenCalled();
    expect(t.idempotency.begin).not.toHaveBeenCalled();
    expect(t.upsert.upsertOne).not.toHaveBeenCalled();
  });

  it('rejects whitespace/control characters', async () => {
    const t = build({ outcome: UPSERT_OUTCOME.CREATED, externalId: 'EXT-1', internalId: 'cu-1' });
    await expect(call(t.svc, 'bad key')).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });
});
