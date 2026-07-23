import { IntegrationAdmissionService } from './integration-admission.service';
import { ADMISSION_OP, MAX_UPSERT_PAYLOAD_BYTES } from '../integration-platform.constants';
import { ErrorCode } from '../../../common/errors';

const config = { get: jest.fn().mockReturnValue(undefined) } as any;
const countRepo = (n: number) => ({ count: jest.fn().mockResolvedValue(n) } as any);

function make(limiter: any, importCount = 0, syncCount = 0) {
  return new IntegrationAdmissionService(limiter, config, countRepo(importCount), countRepo(syncCount));
}

describe('IntegrationAdmissionService', () => {
  describe('admit — rate limiting', () => {
    it('allows when every scope is under budget', async () => {
      const limiter = { consume: jest.fn().mockResolvedValue({ allowed: true }) };
      const svc = make(limiter);
      await expect(
        svc.admit(ADMISSION_OP.WRITE, { tenantId: 't1', keyId: 'k1', connectionId: 'c1' }),
      ).resolves.toBeUndefined();
      // key + tenant + connection scopes.
      expect(limiter.consume).toHaveBeenCalledTimes(3);
    });

    it('skips the per-key scope when there is no API key (dashboard caller)', async () => {
      const limiter = { consume: jest.fn().mockResolvedValue({ allowed: true }) };
      const svc = make(limiter);
      await svc.admit(ADMISSION_OP.IMPORT_CREATE, { tenantId: 't1', connectionId: 'c1' });
      // import.create declares no per-key limit → tenant + connection only.
      expect(limiter.consume).toHaveBeenCalledTimes(2);
    });

    it('throws RATE_LIMITED (429) when a scope is over budget', async () => {
      const limiter = { consume: jest.fn().mockResolvedValue({ allowed: false, reason: 'RATE', retryAfterMs: 1000 }) };
      const svc = make(limiter);
      await expect(svc.admit(ADMISSION_OP.WRITE, { tenantId: 't1', keyId: 'k1' })).rejects.toMatchObject({
        code: ErrorCode.RATE_LIMITED,
      });
    });

    it('FAILS CLOSED (503, retryable) when the limiter is unavailable — never fail-open like the read API', async () => {
      const limiter = { consume: jest.fn().mockRejectedValue(new Error('redis down')) };
      const svc = make(limiter);
      for (const op of [
        ADMISSION_OP.WRITE,
        ADMISSION_OP.IMPORT_CREATE,
        ADMISSION_OP.SYNC_START,
        ADMISSION_OP.INBOUND_WEBHOOK,
        ADMISSION_OP.HEALTH_PROBE,
      ]) {
        await expect(svc.admit(op, { tenantId: 't1', keyId: 'k1', connectionId: 'c1' })).rejects.toMatchObject({
          code: ErrorCode.SERVICE_UNAVAILABLE,
        });
      }
    });

    it('rejects before any side effect — the limiter is consulted first', async () => {
      const limiter = { consume: jest.fn().mockRejectedValue(new Error('redis down')) };
      const svc = make(limiter);
      await expect(svc.admit(ADMISSION_OP.WRITE, { tenantId: 't1' })).rejects.toBeDefined();
      expect(limiter.consume).toHaveBeenCalled();
    });
  });

  describe('concurrency caps (DB-backed — correct even during a Redis outage)', () => {
    const okLimiter = { consume: jest.fn().mockResolvedValue({ allowed: true }) };

    it('allows an import when under the cap', async () => {
      await expect(make(okLimiter, 0).assertImportConcurrency('t1')).resolves.toBeUndefined();
    });

    it('rejects an import at the cap', async () => {
      await expect(make(okLimiter, 3).assertImportConcurrency('t1')).rejects.toMatchObject({
        code: ErrorCode.RATE_LIMITED,
      });
    });

    it('rejects a sync at the cap', async () => {
      await expect(make(okLimiter, 0, 5).assertSyncConcurrency('t1')).rejects.toMatchObject({
        code: ErrorCode.RATE_LIMITED,
      });
    });
  });

  describe('payload size', () => {
    const svc = () => make({ consume: jest.fn() });

    it('accepts a normal payload', () => {
      expect(() => svc().assertPayloadSize({ a: 1 }, MAX_UPSERT_PAYLOAD_BYTES)).not.toThrow();
    });

    it('rejects an oversized payload', () => {
      const big = { blob: 'x'.repeat(MAX_UPSERT_PAYLOAD_BYTES + 10) };
      expect(() => svc().assertPayloadSize(big, MAX_UPSERT_PAYLOAD_BYTES)).toThrow();
    });

    it('rejects an unserializable payload safely', () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(() => svc().assertPayloadSize(cyclic, MAX_UPSERT_PAYLOAD_BYTES)).toThrow();
    });
  });
});
