/**
 * T123 — embedding-provider input filtering vs chat-provider input filtering,
 * for the SAME source record (FR-038).
 *
 * Boots in pgvector mode (`{ pgvector: true }`, per HARNESS_GUIDE.md — the
 * `zt-audit-pgvector` container is already provisioned) so the embedding
 * seam is genuinely exercised for a real knowledge-base document, then
 * compares the captured embedding-provider input against the captured
 * chat-provider input for a turn that retrieves the SAME document.
 *
 * Finding shape this test is built to surface either way: NEITHER layer
 * applies any content filtering/redaction today (both `AiRagService`/
 * `AiKnowledgeIngestionService` and `AiExecutionService` pass the chunk's
 * raw `content` through verbatim) — so "the same rules apply to both" is
 * structurally true only because there are no rules on either side. A
 * planted sensitive-shaped value is used to prove this empirically rather
 * than by code reading alone.
 */
import { randomUUID } from 'node:crypto';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiExecutionService } from '../../src/modules/ai/ai-execution.service';
import { AiKnowledgeIngestionService } from '../../src/modules/ai/ingestion/ai-knowledge-ingestion.service';

describe('W8 — embedding egress vs chat egress parity, same source record (T123)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let execution: AiExecutionService;
  let ingestion: AiKnowledgeIngestionService;

  const SENSITIVE_SHAPED_VALUE = 'PATIENT-RECORD-REF-9F3D2A-DOB-1990-01-01';
  const DOC_TEXT =
    `Synthetic sensitive-shaped reference (audit-only, never real PHI): ${SENSITIVE_SHAPED_VALUE}. ` +
    'This document explains the after-hours emergency triage contact procedure.';
  const MATCH_QUERY = 'What is the after-hours emergency triage contact procedure?';

  beforeAll(async () => {
    harness = await buildAiAuditHarness({ pgvector: true });
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    execution = harness.app.get(AiExecutionService);
    ingestion = harness.app.get(AiKnowledgeIngestionService);
  }, 180_000);

  afterAll(async () => {
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  it('the SAME source record: embedding input and chat-provider input are both raw and unfiltered (parity — no asymmetric redaction)', async () => {
    harness.embedding.reset();
    await ingestion.ingestDocument(seed.tenantA.id, seed.tenantA.agentId, DOC_TEXT, randomUUID());

    // Embedding-provider input.
    const embedCall = harness.embedding.capturedCalls.find((c) => c.texts.some((t) => t.includes(SENSITIVE_SHAPED_VALUE)));
    expect(embedCall).toBeDefined();
    const embeddingInputText = embedCall!.texts.find((t) => t.includes(SENSITIVE_SHAPED_VALUE))!;

    // Chat-provider input, for a turn that retrieves this SAME document.
    const conv = await conversations.start(seed.tenantA.id, { agentId: seed.tenantA.agentId });
    harness.provider.reset();
    harness.provider.script([{ content: 'Here is the after-hours procedure.' }]);
    await execution.sendMessage(seed.tenantA.id, conv.id, { content: MATCH_QUERY }, 'REST');
    const captured = harness.provider.capturedRequests[0];
    const chatMsg = captured.messages.find((m) => m.content?.includes(SENSITIVE_SHAPED_VALUE));
    expect(chatMsg).toBeDefined();

    // Field-by-field comparison for the SAME record.
    // 1. Content fidelity: the exact sensitive-shaped substring crosses BOTH
    //    seams byte-for-byte — neither redacts, masks, or truncates it.
    expect(embeddingInputText).toContain(SENSITIVE_SHAPED_VALUE);
    expect(chatMsg!.content).toContain(SENSITIVE_SHAPED_VALUE);
    expect(embeddingInputText).toContain(DOC_TEXT.split('.')[0]); // full sentence, not partial

    // 2. Tenant scope: the embedding call is tenant-stamped at the call site
    //    (tenantId argument to embed()); the chat message carries no explicit
    //    per-message tenant tag (tenancy is enforced at the SQL retrieval
    //    boundary, not per-token) — recorded as a structural difference, not
    //    a leak: both are still scoped correctly to tenant A only (proven by
    //    ai-w8-tenant-authored-secret.spec.ts's cross-tenant checks).
    expect(embedCall!.tenantId).toBe(seed.tenantA.id);

    // 3. Wrapping: the chat message is delimited (defense-in-depth prompt-
    //    injection boundary — W7); the embedding input is NOT delimited at
    //    all (raw chunk text only). This is the one real asymmetry found:
    //    the embedding provider receives LESS structural wrapping than the
    //    chat provider, but the same RAW SENSITIVE CONTENT either way.
    expect(chatMsg!.content).toContain('<knowledge>');
    expect(embeddingInputText.includes('<knowledge>')).toBe(false);

    process.stdout.write(
      `\n===T123-PARITY embeddingHasValue=true chatHasValue=true chatDelimited=true embeddingDelimited=false===\n`,
    );

    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 60_000);

  it('derived vectors retain tenant scope: the stored ai_kb_embeddings row for this document is stamped with tenant A only', async () => {
    const rows = await harness.dataSource.query(
      `SELECT DISTINCT e.tenant_id, e.agent_id FROM ai_kb_embeddings e
         JOIN ai_knowledge_bases k ON k.id = e.kb_id
        WHERE k.content LIKE $1`,
      [`%${SENSITIVE_SHAPED_VALUE}%`],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tenant_id).toBe(seed.tenantA.id);
      expect(row.agent_id).toBe(seed.tenantA.agentId);
    }
  }, 30_000);

  it('query embedding input (RAG retrieval) is likewise raw and unfiltered — same parity for the QUERY side, not just CONTENT ingestion', async () => {
    harness.embedding.reset();
    const conv = await conversations.start(seed.tenantA.id, { agentId: seed.tenantA.agentId });
    harness.provider.reset();
    harness.provider.script([{ content: 'ack' }]);
    const querySensitive = `My chart number is ${SENSITIVE_SHAPED_VALUE}, please help.`;
    await execution.sendMessage(seed.tenantA.id, conv.id, { content: querySensitive }, 'REST');

    const queryEmbedCall = harness.embedding.capturedCalls.find((c) => c.texts.includes(querySensitive));
    expect(queryEmbedCall).toBeDefined();
    expect(queryEmbedCall!.texts[0]).toBe(querySensitive); // verbatim, unfiltered

    const chatMsg = harness.provider.capturedRequests[0].messages.find((m) => m.content === querySensitive);
    expect(chatMsg).toBeDefined();

    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);
});
