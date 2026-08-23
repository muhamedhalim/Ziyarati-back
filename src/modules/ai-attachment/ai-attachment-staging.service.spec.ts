import { AiAttachmentStagingService } from './ai-attachment-staging.service';
import { AppRedisService } from '../../queue/app-redis.service';
import { ErrorCode } from '../../common/errors';
import type { AppError } from '../../common/errors';
import type { ConversationAttachment } from '../ai-orchestrator/ai-channel.constants';
import { ATTACHMENT_UPLOAD_MAX_PER_WINDOW } from './ai-attachment.constants';

/**
 * The isolation boundary for anonymous attachments.
 *
 * Worth stating plainly, because it is not the boundary the rest of the
 * product uses: every guest is minted into the SAME synthetic discovery
 * tenant, so a tenant prefix separates nothing here. Guest A cannot reach
 * guest B's upload because the Redis key is derived from the OWNER's subject —
 * structural, not a comparison someone could forget to write. These tests pin
 * that, plus single-use redemption and the fail-closed limiter.
 */
const GUEST_A = 'guest-a-subject';
const GUEST_B = 'guest-b-subject';

function descriptor(id: string): ConversationAttachment {
  return {
    id,
    promptName: 'report.pdf',
    mimeType: 'application/pdf',
    size: 1024,
    storageKey: 'tenant/guest-chat-attachments/x.pdf',
    text: 'Haemoglobin 9.1 g/dL',
    status: 'ready',
    at: '2026-08-23T00:00:00.000Z',
  };
}

/** An in-memory stand-in that records the exact keys the service addresses. */
function makeRedis() {
  const store = new Map<string, string>();
  const counters = new Map<string, number>();
  return {
    store,
    counters,
    application: {
      set: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      getdel: jest.fn(async (key: string) => {
        const value = store.get(key) ?? null;
        store.delete(key);
        return value;
      }),
      del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    },
    rateLimiter: {
      defineCommand: jest.fn(),
      aiAttachmentUploadRecord: jest.fn(async (key: string) => {
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        return next;
      }),
    },
  };
}

function build(redis: ReturnType<typeof makeRedis>) {
  return new AiAttachmentStagingService(
    redis as unknown as AppRedisService,
  );
}

describe('AiAttachmentStagingService', () => {
  let redis: ReturnType<typeof makeRedis>;
  let service: AiAttachmentStagingService;

  beforeEach(() => {
    redis = makeRedis();
    service = build(redis);
  });

  describe('ownership is structural, not compared', () => {
    it('gives two guests different keys for the same attachment id', async () => {
      await service.stage(GUEST_A, descriptor('id-1'));
      await service.stage(GUEST_B, descriptor('id-1'));
      expect(redis.store.size).toBe(2);
    });

    it("refuses to hand guest B the attachment guest A staged", async () => {
      await service.stage(GUEST_A, descriptor('id-1'));

      const stolen = await service.redeem(GUEST_B, ['id-1']);

      expect(stolen.attachments).toEqual([]);
      // Reported exactly as an expired or invented id would be — so this is
      // not an oracle for "does another visitor's attachment exist".
      expect(stolen.missing).toEqual(['id-1']);
      // And guest A's copy is untouched: a failed theft must not consume it.
      const owner = await service.redeem(GUEST_A, ['id-1']);
      expect(owner.attachments).toHaveLength(1);
    });

    it('never puts the raw subject in a Redis key', async () => {
      await service.stage(GUEST_A, descriptor('id-1'));
      const [key] = [...redis.store.keys()];
      expect(key).not.toContain(GUEST_A);
      // Keys surface in MONITOR/SLOWLOG/RDB dumps — same reason the WS rate
      // limiter hashes its identity.
      expect(key).toMatch(/[0-9a-f]{64}/);
    });
  });

  describe('redemption is single use', () => {
    it('consumes the descriptor, so it cannot be bound to a second conversation', async () => {
      await service.stage(GUEST_A, descriptor('id-1'));

      const first = await service.redeem(GUEST_A, ['id-1']);
      const replay = await service.redeem(GUEST_A, ['id-1']);

      expect(first.attachments).toHaveLength(1);
      expect(replay.attachments).toEqual([]);
      expect(replay.missing).toEqual(['id-1']);
    });

    it('does not report an already-bound file as missing on a follow-up turn', async () => {
      // "And what about the second page?" — the staging key is long gone by
      // then, but the file IS in the conversation. Reporting it missing would
      // make the assistant tell the visitor their file had vanished.
      const result = await service.redeem(GUEST_A, ['id-1'], ['id-1']);
      expect(result.missing).toEqual([]);
      expect(result.attachments).toEqual([]);
    });

    it('deduplicates repeated ids in one request', async () => {
      await service.stage(GUEST_A, descriptor('id-1'));
      const result = await service.redeem(GUEST_A, ['id-1', 'id-1', 'id-1']);
      expect(result.attachments).toHaveLength(1);
      expect(result.missing).toEqual([]);
    });
  });

  describe('malformed custody degrades to missing, never to a prompt', () => {
    it('rejects a stored blob that is not a valid descriptor', async () => {
      await service.stage(GUEST_A, descriptor('id-1'));
      const [key] = [...redis.store.keys()];
      redis.store.set(key, JSON.stringify({ id: 'id-1', text: 42 }));

      const result = await service.redeem(GUEST_A, ['id-1']);

      expect(result.attachments).toEqual([]);
      expect(result.missing).toEqual(['id-1']);
    });

    it('rejects unparseable JSON', async () => {
      await service.stage(GUEST_A, descriptor('id-1'));
      const [key] = [...redis.store.keys()];
      redis.store.set(key, 'not json');

      const result = await service.redeem(GUEST_A, ['id-1']);
      expect(result.missing).toEqual(['id-1']);
    });
  });

  describe('the upload limiter fails CLOSED', () => {
    it('allows uploads up to the window limit', async () => {
      for (let i = 0; i < ATTACHMENT_UPLOAD_MAX_PER_WINDOW; i += 1) {
        await expect(service.assertUploadAllowed(GUEST_A)).resolves.toBeUndefined();
      }
    });

    it('refuses the one after that with RATE_LIMITED', async () => {
      for (let i = 0; i < ATTACHMENT_UPLOAD_MAX_PER_WINDOW; i += 1) {
        await service.assertUploadAllowed(GUEST_A);
      }
      await expect(service.assertUploadAllowed(GUEST_A)).rejects.toMatchObject({
        code: ErrorCode.RATE_LIMITED,
      });
    });

    it('counts each guest separately', async () => {
      for (let i = 0; i < ATTACHMENT_UPLOAD_MAX_PER_WINDOW; i += 1) {
        await service.assertUploadAllowed(GUEST_A);
      }
      await expect(service.assertUploadAllowed(GUEST_B)).resolves.toBeUndefined();
    });

    it('refuses rather than admits when Redis cannot be consulted', async () => {
      // Every accepted upload can trigger a paid vision call on an endpoint
      // with no login in front of it. With no limiter to ask, "no" is the
      // only safe answer.
      redis.rateLimiter.aiAttachmentUploadRecord.mockRejectedValueOnce(
        new Error('connection refused'),
      );
      await expect(service.assertUploadAllowed(GUEST_A)).rejects.toMatchObject({
        code: ErrorCode.SERVICE_UNAVAILABLE,
      });
    });

    it('refuses to stage when Redis cannot be written', async () => {
      redis.application.set.mockRejectedValueOnce(new Error('connection refused'));
      const err = (await service
        .stage(GUEST_A, descriptor('id-1'))
        .catch((e: AppError) => e)) as AppError;
      expect(err.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
    });
  });

  describe('a Redis fault during redemption does not kill the turn', () => {
    it('reports the file as missing instead of throwing', async () => {
      // The visitor still asked a question. Failing the whole turn would be a
      // worse outcome than answering it while saying the file did not arrive.
      redis.application.getdel.mockRejectedValueOnce(new Error('read timeout'));
      const result = await service.redeem(GUEST_A, ['id-1']);
      expect(result.missing).toEqual(['id-1']);
      expect(result.attachments).toEqual([]);
    });
  });

  describe('discard', () => {
    it('removes the caller´s own staged file', async () => {
      await service.stage(GUEST_A, descriptor('id-1'));
      await expect(service.discard(GUEST_A, 'id-1')).resolves.toBe(true);
      expect(redis.store.size).toBe(0);
    });

    it('cannot remove another guest´s file', async () => {
      await service.stage(GUEST_A, descriptor('id-1'));
      await expect(service.discard(GUEST_B, 'id-1')).resolves.toBe(false);
      expect(redis.store.size).toBe(1);
    });
  });
});
