import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

import { AiKnowledgeBase } from '../../../entities/AI Agent/AiKnowledgeBase';
import { AiAgent } from '../../../entities/AI Agent/AiAgent';
import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { AI_EMBEDDING_PROVIDER } from '../providers/ai-provider.interface';
import type { AiEmbeddingProvider } from '../providers/ai-provider.interface';
import { PgVectorBootstrapService } from '../rag/pgvector-bootstrap.service';
import { AI_KB_EMBEDDINGS_TABLE, toSqlVector } from '../rag/pgvector.util';
import { splitIntoChunks } from './text-splitter';

/**
 * Knowledge-base ingestion: create chunk rows AND store their embeddings in the
 * pgvector sidecar (`ai_kb_embeddings`). This is the only writer of embeddings.
 *
 * Degrades gracefully: when embeddings/pgvector are unavailable, chunk rows are
 * still created (so the keyword fallback works) and embedding is skipped. Safe to
 * re-run (`upsertEmbedding` is ON CONFLICT). pgvector confined to RAG + here.
 */
@Injectable()
export class AiKnowledgeIngestionService {
  private readonly logger = new Logger('AiKnowledgeIngestion');

  constructor(
    @InjectRepository(AiKnowledgeBase)
    private readonly kb: Repository<AiKnowledgeBase>,
    @Inject(AI_EMBEDDING_PROVIDER)
    private readonly embedder: AiEmbeddingProvider,
    private readonly pgvector: PgVectorBootstrapService,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  private canEmbed(): boolean {
    return this.embedder.isConfigured() && this.pgvector.isAvailable();
  }

  /** pgvector must be available to STORE batch-produced vectors. */
  canStoreEmbeddings(): boolean {
    return this.pgvector.isAvailable();
  }

  /** The embedding model batch jobs must request (matches the standard path). */
  currentEmbeddingModel(): string {
    return this.config.get<string>('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small');
  }

  /**
   * Prepare a document for ASYNC (batch) embedding: (re)create its chunk rows
   * WITHOUT vectors, reusing any identical already-embedded vector from another
   * source, and return the chunks that still need an embedding. The caller
   * (AiBatchService) submits those to the Batch API and writes the vectors back
   * via `saveEmbedding` once the batch completes.
   *
   * The chunk rows are committed here so the vectors have a home to attach to;
   * the owning training file stays PROCESSING until every pending item's vector
   * is saved (see the batch completion finalizer).
   */
  async prepareBatchDocument(
    tenantId: string,
    agentId: string,
    text: string,
    sourceId: string,
  ): Promise<{ chunks: number; reused: number; pending: Array<{ kbId: string; content: string }> }> {
    const parts = splitIntoChunks(text, { maxTokens: 500, overlapTokens: 60 });
    if (parts.length === 0) return { chunks: 0, reused: 0, pending: [] };

    const unique = [...new Map(parts.map((content) => {
      const h = this.hashContent(content);
      return [h.hash, { content, ...h }];
    })).values()];

    // Reuse a persisted vector for identical content owned by another source.
    const reusable = new Map<string, string>();
    const rows = await this.dataSource.query(
      `SELECT DISTINCT ON (kb.content_hash) kb.content_hash, kb.id
         FROM ai_knowledge_bases kb
         JOIN ${AI_KB_EMBEDDINGS_TABLE} e ON e.kb_id=kb.id
        WHERE kb."tenantId"=$1 AND kb."agentId"=$2
          AND kb.source_id IS DISTINCT FROM $3
          AND kb.content_hash = ANY($4::varchar[])
        ORDER BY kb.content_hash, kb.created_at ASC`,
      [tenantId, agentId, sourceId, unique.map((p) => p.hash)],
    ) as Array<{ content_hash: string; id: string }>;
    for (const row of rows) reusable.set(row.content_hash, row.id);

    return this.dataSource.transaction(async (m) => {
      await m.query(`DELETE FROM ai_kb_embeddings WHERE kb_id IN (SELECT id FROM ai_knowledge_bases WHERE "tenantId"=$1 AND source_id=$2)`, [tenantId, sourceId]);
      await m.query(`DELETE FROM ai_knowledge_bases WHERE "tenantId"=$1 AND source_id=$2`, [tenantId, sourceId]);
      let inserted = 0;
      let reused = 0;
      const pending: Array<{ kbId: string; content: string }> = [];
      for (let i = 0; i < unique.length; i += 1) {
        const insertedRows = await m.query(
          `INSERT INTO ai_knowledge_bases ("tenantId","agentId",content,content_hash,embedding_version,source_type,source_id)
           VALUES ($1,$2,$3,$4,$5,'training_file',$6)
           ON CONFLICT DO NOTHING RETURNING id`,
          [tenantId, agentId, unique[i].content, unique[i].hash, unique[i].version, sourceId],
        );
        if (!insertedRows[0]?.id) continue;
        inserted += 1;
        const kbId = insertedRows[0].id as string;
        if (reusable.has(unique[i].hash)) {
          const copied = await m.query(
            `INSERT INTO ${AI_KB_EMBEDDINGS_TABLE} (kb_id,tenant_id,agent_id,embedding)
             SELECT $1,$2,$3,embedding FROM ${AI_KB_EMBEDDINGS_TABLE} WHERE kb_id=$4
             ON CONFLICT (kb_id) DO NOTHING RETURNING kb_id`,
            [kbId, tenantId, agentId, reusable.get(unique[i].hash)],
          );
          if (copied[0]?.kb_id) { reused += 1; continue; }
        }
        pending.push({ kbId, content: unique[i].content });
      }
      return { chunks: inserted, reused, pending };
    });
  }

  /**
   * Persist a single embedding vector for a chunk (public seam used by
   * AiBatchService when applying batch results). Idempotent (ON CONFLICT).
   */
  async saveEmbedding(
    kbId: string,
    tenantId: string,
    agentId: string,
    vector: number[],
    manager = this.dataSource.manager,
  ): Promise<void> {
    await this.upsertEmbedding(kbId, tenantId, agentId, vector, manager);
  }

  /** Count chunk rows for a source that still lack an embedding. */
  async countUnembeddedChunks(tenantId: string, sourceId: string): Promise<number> {
    const rows = await this.dataSource.query(
      `SELECT count(*)::int AS n FROM ai_knowledge_bases kb
        LEFT JOIN ${AI_KB_EMBEDDINGS_TABLE} e ON e.kb_id=kb.id
       WHERE kb."tenantId"=$1 AND kb.source_id=$2 AND e.kb_id IS NULL`,
      [tenantId, sourceId],
    ) as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  }

  /**
   * Ids of a source's chunk rows that still lack an embedding, in a STABLE order
   * (by id). Used by the batch submission reconciler to re-derive a job's pending
   * items after a crash before items were persisted — deterministic order keeps
   * the (job, source, chunk_index) mapping consistent across retries.
   */
  async unembeddedChunkIds(tenantId: string, sourceId: string): Promise<string[]> {
    const rows = await this.dataSource.query(
      `SELECT kb.id FROM ai_knowledge_bases kb
        LEFT JOIN ${AI_KB_EMBEDDINGS_TABLE} e ON e.kb_id=kb.id
       WHERE kb."tenantId"=$1 AND kb.source_id=$2 AND e.kb_id IS NULL
       ORDER BY kb.id ASC`,
      [tenantId, sourceId],
    ) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /** Load chunk contents by id (tenant-scoped), for building batch requests. */
  async contentsByIds(tenantId: string, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.dataSource.query(
      `SELECT id, content FROM ai_knowledge_bases WHERE "tenantId"=$1 AND id = ANY($2::uuid[])`,
      [tenantId, ids],
    ) as Array<{ id: string; content: string }>;
    return new Map(rows.map((r) => [r.id, r.content]));
  }

  /** Create one chunk and (best-effort) embed it. */
  async ingestChunk(
    tenantId: string,
    agentId: string,
    content: string,
    source?: { type?: string; id?: string },
  ): Promise<AiKnowledgeBase> {
    const { hash, version } = this.hashContent(content);
    const existing = await this.kb.findOne({
      where: { tenant: { id: tenantId }, agent: { id: agentId }, content_hash: hash },
    });
    if (existing) return existing;

    let row: AiKnowledgeBase;
    try {
      row = await this.kb.save(this.kb.create({
        tenant: { id: tenantId } as Tenant, agent: { id: agentId } as AiAgent,
        content, content_hash: hash, embedding_version: version,
        source_type: source?.type, source_id: source?.id,
      }));
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err;
      const raced = await this.kb.findOneOrFail({
        where: { tenant: { id: tenantId }, agent: { id: agentId }, content_hash: hash },
      });
      return raced;
    }
    if (this.canEmbed()) {
      try {
        const { vectors } = await this.embedder.embed(tenantId, [content], {
          kind: 'CONTENT', feature: 'knowledge_index', route: 'ai.knowledge.create',
          idempotencyKey: `kb:${tenantId}:${agentId}:${hash}`,
        });
        await this.upsertEmbedding(row.id, tenantId, agentId, vectors[0]);
      } catch (err) {
        this.logger.warn(`Embedding failed for chunk ${row.id}: ${(err as Error).message}`);
      }
    }
    return row;
  }

  /** Split a document into chunks, batch-embed, and store. */
  async ingestDocument(
    tenantId: string,
    agentId: string,
    text: string,
    sourceId: string,
    options: { requireEmbedding?: boolean } = {},
  ): Promise<{ chunks: number; embedded: number; deduplicated: number }> {
    const parts = splitIntoChunks(text, { maxTokens: 500, overlapTokens: 60 });
    if (parts.length === 0) return { chunks: 0, embedded: 0, deduplicated: 0 };

    const unique = [...new Map(parts.map((content) => {
      const h = this.hashContent(content);
      return [h.hash, { content, ...h }];
    })).values()];
    if (options.requireEmbedding && !this.canEmbed()) {
      throw new Error('AI_EMBEDDING_UNAVAILABLE');
    }
    // Reuse a persisted vector for identical content owned by another source.
    // A source is deliberately excluded because its rows are replaced below.
    // This keeps source cleanup correct without paying to embed the same chunk.
    const reusable = new Map<string, string>();
    if (this.canEmbed()) {
      const rows = await this.dataSource.query(
        `SELECT DISTINCT ON (kb.content_hash) kb.content_hash, kb.id
           FROM ai_knowledge_bases kb
           JOIN ${AI_KB_EMBEDDINGS_TABLE} e ON e.kb_id=kb.id
          WHERE kb."tenantId"=$1 AND kb."agentId"=$2
            AND kb.source_id IS DISTINCT FROM $3
            AND kb.content_hash = ANY($4::varchar[])
          ORDER BY kb.content_hash, kb.created_at ASC`,
        [tenantId, agentId, sourceId, unique.map((p) => p.hash)],
      ) as Array<{ content_hash: string; id: string }>;
      for (const row of rows) reusable.set(row.content_hash, row.id);
    }
    const toEmbed = unique.filter((part) => !reusable.has(part.hash));
    const freshVectors = this.canEmbed() && toEmbed.length
      ? (await this.embedder.embed(tenantId, toEmbed.map((p) => p.content), {
          kind: 'CONTENT', feature: 'training_index', route: 'ai.training.process',
          idempotencyKey: `training:${tenantId}:${sourceId}:${createHash('sha256').update(text).digest('hex')}`,
        })).vectors
      : [];
    const vectorByHash = new Map(toEmbed.map((part, index) => [part.hash, freshVectors[index]]));

    return this.dataSource.transaction(async (m) => {
      // Reprocessing is a replace, never an append. The transaction guarantees
      // a failed insert/vector write leaves the previous complete index intact.
      await m.query(`DELETE FROM ai_kb_embeddings WHERE kb_id IN (SELECT id FROM ai_knowledge_bases WHERE "tenantId"=$1 AND source_id=$2)`, [tenantId, sourceId]);
      await m.query(`DELETE FROM ai_knowledge_bases WHERE "tenantId"=$1 AND source_id=$2`, [tenantId, sourceId]);
      let inserted = 0;
      let embedded = 0;
      for (let i = 0; i < unique.length; i += 1) {
        const rows = await m.query(
          `INSERT INTO ai_knowledge_bases ("tenantId","agentId",content,content_hash,embedding_version,source_type,source_id)
           VALUES ($1,$2,$3,$4,$5,'training_file',$6)
           ON CONFLICT DO NOTHING RETURNING id`,
          [tenantId, agentId, unique[i].content, unique[i].hash, unique[i].version, sourceId],
        );
        if (!rows[0]?.id) continue;
        inserted += 1;
        const vector = vectorByHash.get(unique[i].hash);
        if (vector) {
          await this.upsertEmbedding(rows[0].id, tenantId, agentId, vector, m);
          embedded += 1;
        } else if (reusable.has(unique[i].hash)) {
          const copied = await m.query(
            `INSERT INTO ${AI_KB_EMBEDDINGS_TABLE} (kb_id,tenant_id,agent_id,embedding)
             SELECT $1,$2,$3,embedding FROM ${AI_KB_EMBEDDINGS_TABLE} WHERE kb_id=$4
             ON CONFLICT (kb_id) DO NOTHING RETURNING kb_id`,
            [rows[0].id, tenantId, agentId, reusable.get(unique[i].hash)],
          );
          if (copied[0]?.kb_id) embedded += 1;
        }
      }
      if (options.requireEmbedding && embedded !== inserted) throw new Error('AI_EMBEDDING_INCOMPLETE');
      return { chunks: inserted, embedded, deduplicated: parts.length - inserted };
    });
  }

  /** Re-embed all of an agent's chunks (rebuild). Returns counts. */
  async reembedAgent(tenantId: string, agentId: string): Promise<{ chunks: number; embedded: number }> {
    const chunks = await this.kb.find({
      where: { tenant: { id: tenantId }, agent: { id: agentId } },
    });
    if (!this.canEmbed() || chunks.length === 0) {
      return { chunks: chunks.length, embedded: 0 };
    }
    const { vectors } = await this.embedder.embed(tenantId, chunks.map((c) => c.content), {
      kind: 'CONTENT', feature: 'knowledge_reindex', route: 'ai.knowledge.rebuild',
      idempotencyKey: `reembed:${tenantId}:${agentId}:${this.embeddingVersion()}`,
    });
    await this.dataSource.transaction(async (m) => {
      for (let i = 0; i < chunks.length; i++) {
        await this.upsertEmbedding(chunks[i].id, tenantId, agentId, vectors[i], m);
      }
    });
    return { chunks: chunks.length, embedded: chunks.length };
  }

  /** Re-embed a single chunk (e.g. after its content was edited). Best-effort. */
  async reembedChunk(
    tenantId: string,
    agentId: string,
    kbId: string,
    content: string,
  ): Promise<void> {
    if (!this.canEmbed()) return;
    try {
      const { hash, version } = this.hashContent(content);
      const updateResult = await this.kb.update({ id: kbId, tenant: { id: tenantId } }, { content_hash: hash, embedding_version: version });
      // AI-004: a foreign kbId matches zero rows under this tenant-scoped
      // update — stop here, or the unconditional upsert below would
      // overwrite another tenant's ai_kb_embeddings sidecar row.
      if (!updateResult.affected) return;
      const { vectors } = await this.embedder.embed(tenantId, [content], {
        kind: 'CONTENT', feature: 'knowledge_reindex', route: 'ai.knowledge.update',
        idempotencyKey: `kb:${tenantId}:${agentId}:${hash}`,
      });
      await this.upsertEmbedding(kbId, tenantId, agentId, vectors[0]);
    } catch (err) {
      this.logger.warn(`Re-embed failed for chunk ${kbId}: ${(err as Error).message}`);
    }
  }

  async cleanupSource(tenantId: string, sourceId: string): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      await m.query(`DELETE FROM ai_kb_embeddings WHERE kb_id IN (SELECT id FROM ai_knowledge_bases WHERE "tenantId"=$1 AND source_id=$2)`, [tenantId, sourceId]);
      await m.query(`DELETE FROM ai_knowledge_bases WHERE "tenantId"=$1 AND source_id=$2`, [tenantId, sourceId]);
    });
  }

  hashContent(content: string): { hash: string; version: string } {
    const normalized = content.normalize('NFKC').trim().replace(/\s+/g, ' ');
    const version = this.embeddingVersion();
    return { hash: createHash('sha256').update(`${version}\u0000${normalized}`).digest('hex'), version };
  }

  private embeddingVersion(): string {
    return `openai:${this.config.get<string>('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small')}:${this.config.get<string>('AI_EMBEDDING_VERSION', 'v1')}`;
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private async upsertEmbedding(
    kbId: string,
    tenantId: string,
    agentId: string,
    vector: number[],
    manager = this.dataSource.manager,
  ): Promise<void> {
    if (!vector) return;
    // AI-004 (R14 layer 2, defense in depth): the conflict clause updates
    // ONLY `embedding`. `tenant_id`/`agent_id` are ownership columns set
    // once at first insert and never rewritten on conflict — first-insert
    // is unaffected (the clause never fires), and legitimate re-embedding
    // by the rightful owner is a true no-op on these columns (their values
    // already match). A caller that reaches this with someone else's kbId
    // therefore can no longer repoint an existing row's ownership, even if
    // it lacks its own tenant-scoped guard (T039 is the primary guard for
    // `reembedChunk` specifically; this constrains the shared SQL itself).
    await manager.query(
      `
      INSERT INTO ${AI_KB_EMBEDDINGS_TABLE} (kb_id, tenant_id, agent_id, embedding)
      VALUES ($1, $2, $3, $4::vector)
      ON CONFLICT (kb_id) DO UPDATE
        SET embedding = EXCLUDED.embedding
      `,
      [kbId, tenantId, agentId, toSqlVector(vector)],
    );
  }
}
