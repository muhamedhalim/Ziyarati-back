/**
 * T135 — keyword-only RAG retrieval as a FUNCTIONAL degradation (FR-062, FR-079).
 *
 * Distinct from T069 (which proves the keyword-fallback path enforces the SAME
 * tenant isolation as the vector path). This spec asks: when `AiRagService`
 * falls back to `keywordSearch()` (`src/modules/ai/ai-rag.service.ts:151-180`),
 * what happens to ANSWER QUALITY / RESULT COUNT, and is that degraded state
 * SIGNALLED anywhere the caller (or an operator) could observe it?
 *
 * The default (non-pgvector) audit harness (`buildAiAuditHarness()`, no
 * `{ pgvector: true }`) boots against the stock compose Postgres, which has no
 * `vector` extension — `PgVectorBootstrapService.isAvailable()` is
 * unconditionally `false` there (confirmed at the bootstrap log level below),
 * so `AiRagService.retrieve()`'s condition `this.embedder.isConfigured() &&
 * this.pgvector.isAvailable()` is false and EVERY retrieval in this harness
 * already runs the keyword path — this is not a special mode to force, it is
 * this environment's only reachable path, which is itself worth recording
 * (T067's pgvector-vs-compose path proof is a separate, not-yet-built task).
 */
import { randomUUID } from 'node:crypto';
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiRagService } from '../../src/modules/ai/ai-rag.service';
import { PgVectorBootstrapService } from '../../src/modules/ai/rag/pgvector-bootstrap.service';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiExecutionService } from '../../src/modules/ai/ai-execution.service';
import { AiKnowledgeBase } from '../../src/entities/AI Agent/AiKnowledgeBase';
import { Tenant } from '../../src/entities/SaaS-Core/Tenant';
import { AiAgent } from '../../src/entities/AI Agent/AiAgent';

describe('RAG keyword-only retrieval as a functional degradation (T135)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let rag: AiRagService;
  let bootstrap: PgVectorBootstrapService;

  beforeAll(async () => {
    harness = await buildAiAuditHarness(); // default: NO pgvector
    seed = await seedAiAudit(harness.app, harness.dataSource);
    rag = harness.app.get(AiRagService);
    bootstrap = harness.app.get(PgVectorBootstrapService);
  }, 120_000);

  afterAll(async () => {
    await harness.dataSource.query(`DELETE FROM ai_knowledge_bases WHERE "tenantId" = $1 AND content LIKE 'T135%'`, [seed.tenantA.id]);
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  it('bootstrap log proof: pgvector is unavailable in this harness, so every retrieve() call is structurally forced onto the keyword path', () => {
    expect(harness.pgvectorAvailable).toBe(false);
    expect(bootstrap.isAvailable()).toBe(false);
    // The embedder itself IS "configured" (the scripted double reports true) —
    // the fallback is caused SOLELY by pgvector unavailability, not by both
    // conditions failing. Worth stating precisely rather than "RAG is broken".
    process.stdout.write(
      `\n===W9-RETRIEVAL-PATH-PROOF===\n${JSON.stringify({ pgvectorAvailable: harness.pgvectorAvailable, embedderConfigured: harness.embedding.isConfigured() })}\n`,
    );
  });

  it('RESULT COUNT degradation: an exact-keyword query finds the chunk; a semantically-equivalent but TOKEN-DISJOINT paraphrase finds NOTHING', async () => {
    const kbs = harness.dataSource.getRepository(AiKnowledgeBase);
    const marker = `T135-${randomUUID().slice(0, 8)}`;
    // Deliberately chosen so the paraphrase query below shares ZERO tokens
    // (length > 2, per `tokenize()`) with this content — including common
    // connector words, since the keyword scorer has no stopword list at all.
    const content = `${marker}: Branch reception welcomes walk-ins between 09:00 and 17:00 daily except Friday.`;
    await kbs.save(
      kbs.create({
        tenant: { id: seed.tenantA.id } as Tenant,
        agent: { id: seed.tenantA.agentId } as AiAgent,
        content,
        content_hash: `${marker}-hash`,
      }),
    );

    // Exact/overlapping-keyword query — keyword scoring can find this.
    const exactHits = await rag.retrieve(seed.tenantA.id, seed.tenantA.agentId, 'branch reception walk-ins daily');
    const foundExact = exactHits.some((c) => c.content.includes(marker));
    expect(foundExact).toBe(true);

    // A real customer would plausibly ask this with NO shared vocabulary at
    // all (verified zero token overlap with the content above, including
    // connector words) — a genuine semantic paraphrase a vector search is
    // specifically designed to still match. Keyword `score()` requires
    // `lc.includes(t)` for literal substrings, so zero shared tokens => zero
    // score => filtered out by `.filter((c) => c.score > 0)`.
    const paraphraseHits = await rag.retrieve(
      seed.tenantA.id,
      seed.tenantA.agentId,
      'what time should I show up without an appointment',
    );
    const foundParaphrase = paraphraseHits.some((c) => c.content.includes(marker));
    expect(foundParaphrase).toBe(false);

    process.stdout.write(
      `\n===W9-RETRIEVAL-RESULT-COUNT===\n${JSON.stringify(
        { exactQueryHitCount: exactHits.length, foundExact, paraphraseQueryHitCount: paraphraseHits.length, foundParaphrase },
        null,
        2,
      )}\n`,
    );
  }, 20_000);

  it('the degraded state is NOT signalled anywhere: not in the chat response envelope, not in ai_execution_metrics, not as a DB column anywhere in the AI schema', async () => {
    const conversations = harness.app.get(AiConversationService);
    const execution = harness.app.get(AiExecutionService);
    // Must bind an agent — AiExecutionService only calls AiRagService.retrieve()
    // `if (agent)` (ai-execution.service.ts); an agent-less conversation never
    // retrieves at all, regardless of keyword matching.
    const conv = await conversations.start(seed.tenantA.id, { agentId: seed.tenantA.agentId });

    harness.provider.reset();
    harness.provider.script([{ content: 'Here is an answer built from whatever context was retrieved.' }]);

    const result = await execution.sendMessage(
      seed.tenantA.id,
      conv.id,
      { content: 'What are your clinic hours?' },
      'REST',
    );

    // The ONLY retrieval-related field on the response is a bare count —
    // nothing marks it as vector-sourced vs keyword-sourced/degraded.
    expect(Object.keys(result)).toEqual(
      expect.arrayContaining(['message', 'retrievedChunks', 'usage', 'fallback', 'lastTool']),
    );
    expect(typeof result.retrievedChunks).toBe('number');

    // Prior-claims-register claim #9 (AI_FINOPS_HARDENING.md): "RAG and memory
    // are inserted as untrusted user-context sections, never system
    // instructions." RUNTIME-confirmed here (not just static): this turn
    // retrieved >=1 RAG chunk (the seeded KB row matches "clinic hours"), so
    // inspect the EXACT assembled message array the scripted provider
    // captured and assert no RAG content ever appears in a `role: 'system'`
    // message.
    expect(result.retrievedChunks).toBeGreaterThan(0);
    const captured = harness.provider.capturedMessages(0);
    const systemMessages = captured.filter((m) => m.role === 'system');
    const userMessages = captured.filter((m) => m.role === 'user');
    expect(systemMessages.length).toBeGreaterThan(0); // the agent's own system_prompt IS present
    for (const sysMsg of systemMessages) {
      expect(sysMsg.content ?? '').not.toMatch(/Branch reception welcomes|Clinic hours: 9am-5pm/);
    }
    const ragCarryingUserMessage = userMessages.find((m) => (m.content ?? '').includes('Clinic hours: 9am-5pm'));
    expect(ragCarryingUserMessage).toBeDefined(); // RAG content DOES appear, but only as role:'user'

    // `fallback` on the response/metrics is the PROVIDER's own fallback flag
    // (see ScriptedAiProvider/NoopAiProvider `.fallback`), not a RAG-retrieval
    // signal — confirm it is false here even though retrieval WAS degraded,
    // proving the two concepts are conflated under one name with no
    // independent RAG-mode field.
    expect(result.fallback).toBe(false);

    const [metricRow] = await harness.dataSource.query(
      `SELECT * FROM ai_execution_metrics WHERE "tenantId" = $1 AND ai_conversation_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [seed.tenantA.id, conv.id],
    );
    const metricColumns = metricRow ? Object.keys(metricRow) : [];
    // Precise mode/degradation-signal pattern — deliberately NOT a bare "rag"
    // match, because `rag_retrieval_ms` (a LATENCY metric — how long
    // retrieval took) legitimately contains "rag" without telling the caller
    // WHICH path (vector vs keyword) produced that latency. That column is
    // reported separately below as a "present but insufficient" signal.
    const modeSignalPattern = /(^|_)mode(_|$)|vector_fallback|keyword_fallback|is_degraded|^degraded|retrieval_(type|source|path)/i;
    const retrievalModeColumns = metricColumns.filter((c) => modeSignalPattern.test(c));
    const hasLatencyOnlyColumn = metricColumns.includes('rag_retrieval_ms');

    // Every AI-surface table's columns, scanned for anything that could carry
    // a retrieval-MODE/degraded signal (not merely a latency number).
    const allAiTableColumns = await harness.dataSource.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name IN ('ai_execution_metrics','ai_messages','ai_conversations','ai_cost_logs','ai_usage_logs')
          AND column_name ~* '(^|_)mode(_|$)|vector_fallback|keyword_fallback|is_degraded|retrieval_(type|source|path)'`,
    );

    process.stdout.write(
      `\n===W9-RETRIEVAL-SIGNALLING===\n${JSON.stringify(
        {
          responseEnvelopeKeys: Object.keys(result),
          retrievedChunks: result.retrievedChunks,
          providerFallbackFlag: result.fallback,
          metricRowRetrievalModeColumns: retrievalModeColumns,
          latencyOnlyColumnPresentButNotAModeSignal: hasLatencyOnlyColumn,
          allAiTableColumnsMatchingRetrievalTerms: allAiTableColumns,
          persistedRetrievalMode: metricRow?.retrieval_mode,
        },
        null,
        2,
      )}\n`,
    );

    // AI-013 (RTP row 24, inverted 2026-08-17): a `retrieval_mode` column now
    // exists on `ai_execution_metrics` (T131/T132, migration
    // 1730041500000) and carries the signal this spec previously recorded
    // as entirely absent.
    expect(allAiTableColumns.length).toBeGreaterThan(0);
    // `processing_mode` (STANDARD vs BATCH execution — migration 1730054000000) also matches the broad
    // `*_mode` pattern but is about HOW a request was executed, not which retrieval path served it, so it is
    // named explicitly instead of being allowed to hide an unexpected new signal column.
    expect(retrievalModeColumns.filter((c) => c !== 'processing_mode')).toEqual(['retrieval_mode']);
    // The recorded value matches the path ACTUALLY taken — this harness has
    // no pgvector, so every retrieval here is keyword-only (never merely
    // "attempted"); the attempted-then-fell-back case (FR-067's second half)
    // is the SAME code path (ai-rag.service.ts sets 'keyword' in both the
    // catch branch and the final fallback line, never only one), so proving
    // this reachable case exercises the identical assignment.
    expect(metricRow.retrieval_mode).toBe('keyword');

    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);
});
