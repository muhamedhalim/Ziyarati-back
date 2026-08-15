/**
 * T150 — retry-loop and provider-failure amplification (FR-070, FR-073, FR-076).
 *
 * Two complementary angles, per the task's own design note:
 *
 *  (a) Directly unit-tests `OpenAiRequestPolicy` (the ACTUAL retry-ceiling
 *      logic used by the real `OpenAiChatProvider`) against a synthetic
 *      always-failing operation — no network, no app boot. This is the part
 *      that actually proves the ceiling, since the scripted stub provider
 *      used everywhere else in this audit deliberately bypasses
 *      `OpenAiRequestPolicy` entirely (it is a test double with no retry
 *      logic of its own).
 *  (b) End-to-end: drives a real turn through `AiExecutionService` with the
 *      SCRIPTED provider failing, and asserts `AiExecutionService` does not
 *      layer its OWN unbounded retry loop on top of a provider failure — a
 *      different, complementary question from (a).
 */
import { Logger } from '@nestjs/common';

import {
  OpenAiRequestPolicy,
  isRetryableOpenAiError,
} from '../../src/modules/ai/providers/openai-request-policy';
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiExecutionService } from '../../src/modules/ai/ai-execution.service';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';

function retryableError(status: number): Error & { status: number } {
  const e = new Error(`synthetic ${status}`) as Error & { status: number };
  e.status = status;
  return e;
}

describe('AI abuse — retry-loop bounds (T150)', () => {
  describe('(a) OpenAiRequestPolicy — the ACTUAL retry ceiling, no network/app boot', () => {
    it('an always-failing 429 operation is attempted exactly maxRetries+1 times, never more', async () => {
      const maxRetries = 3;
      const policy = new OpenAiRequestPolicy(maxRetries, 1 /* baseDelayMs — tiny, this test only cares about the COUNT */, new Logger('test'));
      let attempts = 0;
      const alwaysFails = async () => {
        attempts += 1;
        throw retryableError(429);
      };

      await expect(policy.execute(alwaysFails, 'synthetic-429')).rejects.toThrow('synthetic 429');
      expect(attempts).toBe(maxRetries + 1);
    });

    it('an always-failing 500 (retryable 5xx) operation is also bounded at maxRetries+1', async () => {
      const maxRetries = 2;
      const policy = new OpenAiRequestPolicy(maxRetries, 1, new Logger('test'));
      let attempts = 0;
      const alwaysFails = async () => {
        attempts += 1;
        throw retryableError(500);
      };

      await expect(policy.execute(alwaysFails, 'synthetic-500')).rejects.toThrow('synthetic 500');
      expect(attempts).toBe(maxRetries + 1);
    });

    it('a NON-retryable error (e.g. 400) stops at attempt 1 — the ceiling is a MAXIMUM, not a guaranteed retry count', async () => {
      const policy = new OpenAiRequestPolicy(5, 1, new Logger('test'));
      let attempts = 0;
      const alwaysFails400 = async () => {
        attempts += 1;
        throw retryableError(400);
      };

      await expect(policy.execute(alwaysFails400, 'synthetic-400')).rejects.toThrow('synthetic 400');
      expect(attempts).toBe(1);
      expect(isRetryableOpenAiError(retryableError(400))).toBe(false);
      expect(isRetryableOpenAiError(retryableError(429))).toBe(true);
      expect(isRetryableOpenAiError(retryableError(500))).toBe(true);
      expect(isRetryableOpenAiError(retryableError(503))).toBe(true);
    });

    it('a SUCCEEDING operation after transient 429s still resolves once retried within the ceiling — the ceiling does not fire on success', async () => {
      const maxRetries = 3;
      const policy = new OpenAiRequestPolicy(maxRetries, 1, new Logger('test'));
      let attempts = 0;
      const failsTwiceThenSucceeds = async () => {
        attempts += 1;
        if (attempts <= 2) throw retryableError(429);
        return 'ok';
      };

      const { value, attempts: reportedAttempts } = await policy.execute(failsTwiceThenSucceeds, 'synthetic-recovers');
      expect(value).toBe('ok');
      expect(attempts).toBe(3);
      expect(reportedAttempts).toBe(3);
    });
  });

  describe('(b) AiExecutionService — no additional unbounded retry loop around a scripted provider failure', () => {
    let harness: AiAuditHarness;
    let seed: AiAuditSeed;

    beforeAll(async () => {
      harness = await buildAiAuditHarness();
      seed = await seedAiAudit(harness.app, harness.dataSource);
    }, 120_000);

    afterAll(async () => {
      await teardownAiAuditSeed(harness.dataSource, seed);
      await harness.close();
    }, 60_000);

    it('a scripted 429 provider failure results in EXACTLY ONE provider invocation for the turn — AiExecutionService does not retry it itself', async () => {
      const conversations = harness.app.get(AiConversationService);
      const execution = harness.app.get(AiExecutionService);
      const conv = await conversations.start(seed.tenantA.id, {});

      harness.provider.reset();
      harness.provider.scriptFailure({ kind: '429', retryAfterSeconds: 1 });

      await expect(
        execution.sendMessage(seed.tenantA.id, conv.id, { content: 'Trigger a provider failure.' }, 'REST'),
      ).rejects.toBeDefined();

      // The scripted double never retries internally (by design — it is a
      // test double, not `OpenAiChatProvider`). If AiExecutionService added
      // its own retry loop around a provider failure, this count would be > 1.
      expect(harness.provider.callCount).toBe(1);

      await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
      await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
    }, 30_000);

    it('a scripted timeout failure also results in exactly one provider invocation', async () => {
      const conversations = harness.app.get(AiConversationService);
      const execution = harness.app.get(AiExecutionService);
      const conv = await conversations.start(seed.tenantA.id, {});

      harness.provider.reset();
      harness.provider.scriptFailure({ kind: 'timeout' });

      await expect(
        execution.sendMessage(seed.tenantA.id, conv.id, { content: 'Trigger a timeout.' }, 'REST'),
      ).rejects.toBeDefined();

      expect(harness.provider.callCount).toBe(1);

      await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
      await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
    }, 30_000);
  });
});
