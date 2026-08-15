/**
 * T152 — upload-size bounds for AI ingestion (FR-073).
 *
 * `AiTrainingFileService.uploadContent` (`src/modules/ai/ai-training-file.service.ts:89-133`)
 * checks `AI_TRAINING_FILE_MAX_BYTES` (default 10MB) BEFORE calling
 * `StorageService.upload` — so the rejection point is provably before any
 * object write, and (since indexing/embedding is triggered by a LATER,
 * separate `process()` call against a persisted `AiTrainingFile` row that
 * never gets created for a rejected upload) also provably before any
 * embedding work.
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiTrainingFileService } from '../../src/modules/ai/ai-training-file.service';

describe('AI abuse — upload-size bounds for AI ingestion (T152)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let files: AiTrainingFileService;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    files = harness.app.get(AiTrainingFileService);
  }, 120_000);

  afterAll(async () => {
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  it('an oversized upload (11MB, over the 10MB default) is rejected BEFORE storage write, with zero embedding work and zero persisted row', async () => {
    harness.embedding.reset();
    const oversizedBuffer = Buffer.alloc(11 * 1024 * 1024, 'A');

    await expect(
      files.uploadContent(
        seed.tenantA.id,
        {
          originalname: 'oversized-probe.txt',
          mimetype: 'text/plain',
          size: oversizedBuffer.length,
          buffer: oversizedBuffer,
        },
      ),
    ).rejects.toMatchObject({ code: expect.stringContaining('BAD_REQUEST') });

    expect(harness.embedding.capturedCalls.length).toBe(0);

    const rows = await harness.dataSource.query(
      `SELECT COUNT(*)::int AS count FROM ai_training_files WHERE "tenantId" = $1 AND file_name = $2`,
      [seed.tenantA.id, 'oversized-probe.txt'],
    );
    expect(rows[0].count).toBe(0);
  }, 30_000);

  it('sanity: a small, well-formed upload (under the limit) IS accepted and persisted, and a `size` field that LIES about being small (but a buffer that is actually oversized) is still caught by the real buffer-length check, not just the client-supplied `size`', async () => {
    harness.embedding.reset();
    const smallBuffer = Buffer.from('Small synthetic training content, well under any limit.', 'utf8');

    const accepted = await files.uploadContent(
      seed.tenantA.id,
      {
        originalname: 'small-probe.txt',
        mimetype: 'text/plain',
        size: smallBuffer.length,
        buffer: smallBuffer,
      },
    );
    expect(accepted.id).toBeTruthy();
    expect(accepted.file_name).toBe('small-probe.txt');

    // Attacker-controlled `size` field claims 1 byte, but the ACTUAL buffer is
    // oversized — `ai-training-file.service.ts:107-111`'s check is
    // `file.size > maxBytes || file.buffer.length > maxBytes` (OR, both
    // checked), so a lied-about `size` cannot smuggle a real oversized buffer
    // through on the `size` check alone.
    const oversizedBuffer = Buffer.alloc(11 * 1024 * 1024, 'B');
    await expect(
      files.uploadContent(
        seed.tenantA.id,
        {
          originalname: 'lied-size-probe.txt',
          mimetype: 'text/plain',
          size: 1, // lies
          buffer: oversizedBuffer, // truth
        },
      ),
    ).rejects.toMatchObject({ code: expect.stringContaining('BAD_REQUEST') });

    expect(harness.embedding.capturedCalls.length).toBe(0); // neither upload triggered embedding — process() is a separate, later step

    await harness.dataSource.query(`DELETE FROM ai_training_files WHERE id = $1`, [accepted.id]).catch(() => undefined);
  }, 30_000);
});
