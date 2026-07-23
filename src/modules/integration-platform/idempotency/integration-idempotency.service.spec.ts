import { AppError, ErrorCode } from '../../../common/errors';
import { IntegrationIdempotencyService } from './integration-idempotency.service';

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
});
