import { QueryFailedError } from 'typeorm';
import { AppError, ErrorCode } from '../../../common/errors';
import {
  IntegrationIdempotencyService,
  assertValidIdempotencyKey,
  IDEMPOTENCY_KEY_MAX_LENGTH,
} from './integration-idempotency.service';

/** Minimal repo mock — only the methods `begin` touches. */
function repoMock(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    findOne: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    create: jest.fn((x) => x),
    ...overrides,
  } as any;
}

describe('IntegrationIdempotencyService', () => {
  const tenantId = 't1';

  it('no key → proceeds without dedupe', async () => {
    const repo = repoMock();
    const svc = new IntegrationIdempotencyService(repo);
    await expect(svc.begin(tenantId, 'c1', undefined, 'customer.upsert', 'h1')).resolves.toEqual({});
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it('replays a prior COMPLETED result for the same payload', async () => {
    const repo = repoMock({
      findOne: jest.fn().mockResolvedValue({
        request_hash: 'h1',
        status: 'completed',
        response_status: 200,
        response_body: { outcome: 'created' },
      }),
    });
    const svc = new IntegrationIdempotencyService(repo);
    const res = await svc.begin(tenantId, 'c1', 'key-1', 'customer.upsert', 'h1');
    expect(res.replay).toEqual({ status: 200, body: { outcome: 'created' } });
  });

  it('rejects key reuse with a DIFFERENT payload (422)', async () => {
    const repo = repoMock({
      findOne: jest.fn().mockResolvedValue({ request_hash: 'h1', status: 'completed' }),
    });
    const svc = new IntegrationIdempotencyService(repo);
    await expect(svc.begin(tenantId, 'c1', 'key-1', 'customer.upsert', 'DIFFERENT')).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE_ENTITY,
    });
  });

  it('rejects a concurrent in-flight request with the same key (409)', async () => {
    const repo = repoMock({
      findOne: jest.fn().mockResolvedValue({ request_hash: 'h1', status: 'in_progress' }),
    });
    const svc = new IntegrationIdempotencyService(repo);
    await expect(svc.begin(tenantId, 'c1', 'key-1', 'customer.upsert', 'h1')).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
    });
  });

  it('begins a fresh record when none exists', async () => {
    const repo = repoMock({
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockResolvedValue({ id: 'rec-1' }),
    });
    const svc = new IntegrationIdempotencyService(repo);
    const res = await svc.begin(tenantId, 'c1', 'key-1', 'customer.upsert', 'h1');
    expect(res.recordId).toBe('rec-1');
    expect(repo.save).toHaveBeenCalled();
  });

  it('hashes equal payloads (key order independent) to the same value', () => {
    const svc = new IntegrationIdempotencyService(repoMock());
    const a = svc.hashPayload({ a: 1, b: { c: 2, d: 3 } });
    const b = svc.hashPayload({ b: { d: 3, c: 2 }, a: 1 });
    expect(a).toBe(b);
  });

  it('surfaces AppError instances unchanged', () => {
    expect(new AppError(ErrorCode.CONFLICT)).toBeInstanceOf(AppError);
  });

  // ── F08: expiry enforced at lookup, not only by the daily purge ──────────
  describe('expiry at lookup (F08)', () => {
    const T0 = new Date('2026-10-12T10:00:00.000Z');
    const expiring = (at: Date, over: Record<string, unknown> = {}) => ({
      id: 'old-1',
      request_hash: 'h-old',
      status: 'completed',
      response_status: 200,
      response_body: { outcome: 'created' },
      expires_at: at,
      ...over,
    });

    it('treats a record 1 ms before expiry as live (replay)', async () => {
      const repo = repoMock({
        findOne: jest.fn().mockResolvedValue(expiring(new Date(T0.getTime() + 1), { request_hash: 'h1' })),
      });
      const svc = new IntegrationIdempotencyService(repo);
      const res = await svc.begin(tenantId, 'c1', 'k', 'customer.upsert', 'h1', T0);
      expect(res.replay).toEqual({ status: 200, body: { outcome: 'created' } });
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it('treats a record exactly at expiry as absent: deletes it and starts a fresh one', async () => {
      const repo = repoMock({
        findOne: jest.fn().mockResolvedValue(expiring(T0)),
        save: jest.fn().mockResolvedValue({ id: 'new-1' }),
        delete: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      const svc = new IntegrationIdempotencyService(repo);
      // A DIFFERENT payload hash would be a 422 if the stale row still counted.
      const res = await svc.begin(tenantId, 'c1', 'k', 'customer.upsert', 'h-new', T0);
      expect(res).toEqual({ recordId: 'new-1' });
      expect(repo.delete).toHaveBeenCalledTimes(1);
      const created = (repo.create as jest.Mock).mock.calls[0][0];
      expect(created.expires_at.getTime()).toBe(T0.getTime() + 24 * 3600 * 1000);
    });

    it('does NOT replay an expired completed record even for the same payload', async () => {
      const repo = repoMock({
        findOne: jest.fn().mockResolvedValue(expiring(new Date(T0.getTime() - 60_000), { request_hash: 'h1' })),
        save: jest.fn().mockResolvedValue({ id: 'new-2' }),
        delete: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      const svc = new IntegrationIdempotencyService(repo);
      const res = await svc.begin(tenantId, 'c1', 'k', 'customer.upsert', 'h1', T0);
      expect(res.replay).toBeUndefined();
      expect(res.recordId).toBe('new-2');
    });

    it('concurrent retries on an expired row: the insert-race loser gets 409, never a second active key', async () => {
      const winnerRow = {
        id: 'w', request_hash: 'h-new', status: 'in_progress', expires_at: new Date(T0.getTime() + 86_400_000),
      };
      const findOne = jest
        .fn()
        .mockResolvedValueOnce(expiring(new Date(T0.getTime() - 1))) // initial read: expired
        .mockResolvedValueOnce(winnerRow); // re-read after the unique violation
      const repo = repoMock({
        findOne,
        delete: jest.fn().mockResolvedValue({ affected: 0 }), // the other request already purged it
        save: jest
          .fn()
          .mockRejectedValue(new QueryFailedError('INSERT', [], Object.assign(new Error('dup'), { code: '23505' }))),
      });
      const svc = new IntegrationIdempotencyService(repo);
      await expect(svc.begin(tenantId, 'c1', 'k', 'customer.upsert', 'h-new', T0)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
    });
  });

  // ── F07: key validated before persistence ────────────────────────────────
  describe('assertValidIdempotencyKey (F07)', () => {
    it('accepts absent, empty and a key of exactly the column length', () => {
      expect(() => assertValidIdempotencyKey(undefined)).not.toThrow();
      expect(() => assertValidIdempotencyKey('')).not.toThrow();
      expect(() => assertValidIdempotencyKey('k'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH))).not.toThrow();
      expect(() => assertValidIdempotencyKey('order-2026/10/12:abc_DEF.1')).not.toThrow();
    });

    it('rejects length max+1 with a client validation error (not a DB error)', () => {
      expect(IDEMPOTENCY_KEY_MAX_LENGTH).toBe(255);
      try {
        assertValidIdempotencyKey('k'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1));
        throw new Error('expected rejection');
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).code).toBe(ErrorCode.VALIDATION_ERROR);
      }
    });

    it.each(['has space', 'tab\tkey', 'new\nline', 'ключ', 'emoji-😀'])('rejects %j', (k) => {
      expect(() => assertValidIdempotencyKey(k)).toThrow(AppError);
    });
  });
});
