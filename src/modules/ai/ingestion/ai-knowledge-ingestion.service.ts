import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

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
  ) {}

  private canEmbed(): boolean {
    return this.embedder.isConfigured() && this.pgvector.isAvailable();
  }

  /** Create one chunk and (best-effort) embed it. */
  async ingestChunk(
    tenantId: string,
    agentId: string,
    content: string,
    source?: { type?: string; id?: string },
  ): Promise<AiKnowledgeBase> {
    const row = await this.kb.save(
      this.kb.create({
        tenant: { id: tenantId } as Tenant,
        agent: { id: agentId } as AiAgent,
        content,
        source_type: source?.type,
        source_id: source?.id,
      }),
    );
    if (this.canEmbed()) {
      try {
        const { vectors } = await this.embedder.embed(tenantId, [content]);
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
  ): Promise<{ chunks: number; embedded: number }> {
    const parts = splitIntoChunks(text, { maxTokens: 500, overlapTokens: 60 });
    if (parts.length === 0) return { chunks: 0, embedded: 0 };

    const rows = await this.kb.save(
      parts.map((c) =>
        this.kb.create({
          tenant: { id: tenantId } as Tenant,
          agent: { id: agentId } as AiAgent,
          content: c,
          source_type: 'training_file',
          source_id: sourceId,
        }),
      ),
    );

    if (!this.canEmbed()) return { chunks: rows.length, embedded: 0 };

    const { vectors } = await this.embedder.embed(tenantId, parts); // one batched call
    let embedded = 0;
    await this.dataSource.transaction(async (m) => {
      for (let i = 0; i < rows.length; i++) {
        await this.upsertEmbedding(rows[i].id, tenantId, agentId, vectors[i], m);
        embedded++;
      }
    });
    return { chunks: rows.length, embedded };
  }

  /** Re-embed all of an agent's chunks (rebuild). Returns counts. */
  async reembedAgent(tenantId: string, agentId: string): Promise<{ chunks: number; embedded: number }> {
    const chunks = await this.kb.find({
      where: { tenant: { id: tenantId }, agent: { id: agentId } },
    });
    if (!this.canEmbed() || chunks.length === 0) {
      return { chunks: chunks.length, embedded: 0 };
    }
    const { vectors } = await this.embedder.embed(tenantId, chunks.map((c) => c.content));
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
      const { vectors } = await this.embedder.embed(tenantId, [content]);
      await this.upsertEmbedding(kbId, tenantId, agentId, vectors[0]);
    } catch (err) {
      this.logger.warn(`Re-embed failed for chunk ${kbId}: ${(err as Error).message}`);
    }
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
    await manager.query(
      `
      INSERT INTO ${AI_KB_EMBEDDINGS_TABLE} (kb_id, tenant_id, agent_id, embedding)
      VALUES ($1, $2, $3, $4::vector)
      ON CONFLICT (kb_id) DO UPDATE
        SET embedding = EXCLUDED.embedding,
            tenant_id = EXCLUDED.tenant_id,
            agent_id  = EXCLUDED.agent_id
      `,
      [kbId, tenantId, agentId, toSqlVector(vector)],
    );
  }
}
