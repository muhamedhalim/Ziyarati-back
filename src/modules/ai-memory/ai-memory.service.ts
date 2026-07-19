import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThan, Repository } from 'typeorm';

import { AiMemory } from '../../entities/AI Agent/AiMemory';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';
import { AI_EMBEDDING_PROVIDER } from '../ai/providers/ai-provider.interface';
import type { AiEmbeddingProvider } from '../ai/providers/ai-provider.interface';
import { AiMemoryVectorService } from './ai-memory-vector.service';
import { RememberDto, RecallDto, MemoryFilterDto } from './dto/memory.dto';

export interface RecalledMemory {
  id: string;
  type: string;
  content: string;
  importance: number;
  score: number;
  customerId?: string | null;
}

/**
 * Long-term AI memory (Feature 5). Stores only IMPORTANT, reusable facts and
 * recalls them semantically. Reuses the shared embedding provider
 * (`AI_EMBEDDING_PROVIDER`) + the pgvector sidecar (`AiMemoryVectorService`) —
 * NO embedding or vector logic is duplicated. Expiry is honoured at recall time
 * (expired memories are never returned) and physically purged by `cleanupExpired`.
 * Every operation is tenant-scoped.
 */
@Injectable()
export class AiMemoryService {
  private readonly logger = new Logger(AiMemoryService.name);

  constructor(
    @InjectRepository(AiMemory)
    private readonly memories: Repository<AiMemory>,
    @Inject(AI_EMBEDDING_PROVIDER)
    private readonly embedder: AiEmbeddingProvider,
    private readonly vector: AiMemoryVectorService,
    private readonly dataSource: DataSource,
  ) {}

  /** Persist a memory + (best-effort) its embedding. Only store what matters. */
  async remember(tenantId: string, dto: RememberDto): Promise<AiMemory> {
    const memory = await this.memories.save(
      this.memories.create({
        tenant: { id: tenantId } as Tenant,
        customer_id: dto.customerId,
        ai_conversation_id: dto.aiConversationId,
        type: dto.type,
        content: dto.content,
        importance: dto.importance ?? 1,
        metadata: dto.metadata,
        expires_at: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      }),
    );
    await this.embedMemory(tenantId, memory).catch((err) =>
      this.logger.warn(`memory embed failed (${memory.id}): ${(err as Error).message}`),
    );
    return memory;
  }

  /**
   * Semantic recall of the most relevant memories for a query (Feature 5).
   * Falls back to keyword overlap when embeddings/pgvector are unavailable, so
   * callers always get a ranked result. Expired memories are excluded.
   */
  async recall(
    tenantId: string,
    dto: RecallDto,
    attribution: { channel?: string; aiConversationId?: string; idempotencyKey?: string } = {},
  ): Promise<RecalledMemory[]> {
    const topK = dto.limit ?? 5;

    if (this.embedder.isConfigured() && this.vector.isAvailable()) {
      try {
        const { vectors } = await this.embedder.embed(tenantId, [dto.query], {
          kind: 'QUERY', feature: 'memory_recall', route: 'ai.memory.recall',
          channel: attribution.channel ?? 'INTERNAL',
          aiConversationId: attribution.aiConversationId,
          idempotencyKey: attribution.idempotencyKey,
        });
        const queryVec = vectors[0];
        if (queryVec) {
          const matches = await this.vector.search(tenantId, queryVec, topK, dto.customerId);
          if (matches.length) return this.hydrate(tenantId, matches);
        }
      } catch (err) {
        this.logger.warn(`memory vector recall failed (${(err as Error).message}) — keyword fallback`);
      }
    }
    return this.keywordRecall(tenantId, dto, topK);
  }

  /** Paginated memory list (management + the memory viewer). */
  async list(tenantId: string, filter: MemoryFilterDto) {
    const qb = this.memories
      .createQueryBuilder('m')
      .leftJoin('m.tenant', 't')
      .where('t.id = :tenantId', { tenantId });
    if (filter.type) qb.andWhere('m.type = :type', { type: filter.type });
    if (filter.customerId) qb.andWhere('m.customer_id = :cid', { cid: filter.customerId });
    if (filter.activeOnly === 'true') qb.andWhere('(m.expires_at IS NULL OR m.expires_at > now())');
    if (filter.search?.trim()) qb.andWhere('m.content ILIKE :q', { q: `%${filter.search.trim()}%` });

    const [data, total] = await qb
      .orderBy('m.importance', 'DESC')
      .addOrderBy('m.created_at', 'DESC')
      .skip((filter.page - 1) * filter.limit)
      .take(filter.limit)
      .getManyAndCount();
    return { data, total, page: filter.page, limit: filter.limit };
  }

  /** Delete a memory (its embedding is removed by the FK cascade). */
  async forget(tenantId: string, id: string): Promise<{ id: string }> {
    const memory = await this.memories.findOne({ where: { id, tenant: { id: tenantId } } });
    if (!memory) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Memory not found' });
    await this.memories.delete(id);
    return { id };
  }

  /** Purge expired memories (optionally tenant-scoped). Returns the deleted count. */
  async cleanupExpired(tenantId?: string): Promise<{ deleted: number }> {
    const where = tenantId
      ? { tenant: { id: tenantId }, expires_at: LessThan(new Date()) }
      : { expires_at: LessThan(new Date()) };
    const res = await this.memories.delete(where);
    return { deleted: res.affected ?? 0 };
  }

  /**
   * Derive + store a heuristic conversation summary (Feature 5). Uses the last
   * user turns from `ai_messages` — no LLM call, so no provider logic is
   * duplicated (an LLM summary can be persisted via `remember(type:'summary')`).
   */
  async summarizeConversation(
    tenantId: string,
    aiConversationId: string,
    customerId?: string,
  ): Promise<AiMemory | null> {
    const rows = await this.dataSource.query(
      `SELECT content FROM ai_messages
        WHERE ai_conversation_id = $1 AND role = 'user'
        ORDER BY created_at DESC LIMIT 6`,
      [aiConversationId],
    );
    if (!rows.length) return null;
    const summary = rows
      .reverse()
      .map((r: { content: string }) => r.content)
      .join(' · ')
      .slice(0, 1000);
    return this.remember(tenantId, {
      type: 'summary',
      content: `Conversation summary: ${summary}`,
      importance: 2,
      aiConversationId,
      customerId,
    });
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private async embedMemory(tenantId: string, memory: AiMemory): Promise<void> {
    if (!this.embedder.isConfigured() || !this.vector.isAvailable()) return;
    const { vectors } = await this.embedder.embed(tenantId, [memory.content], {
      kind: 'MEMORY', feature: 'memory_write', route: 'ai.memory.remember', channel: 'INTERNAL',
      idempotencyKey: `memory:${tenantId}:${memory.id}`,
    });
    const vec = vectors[0];
    if (vec) await this.vector.upsert(memory.id, tenantId, vec, memory.customer_id);
  }

  private async hydrate(
    tenantId: string,
    matches: { memoryId: string; score: number }[],
  ): Promise<RecalledMemory[]> {
    const byId = new Map(matches.map((m) => [m.memoryId, m.score]));
    const rows = await this.memories.find({
      where: { id: In(matches.map((m) => m.memoryId)), tenant: { id: tenantId } },
    });
    return rows
      .map((m) => ({
        id: m.id,
        type: m.type,
        content: m.content,
        importance: m.importance,
        customerId: m.customer_id ?? null,
        score: byId.get(m.id) ?? 0,
      }))
      .sort((a, b) => b.score - a.score);
  }

  private async keywordRecall(tenantId: string, dto: RecallDto, topK: number): Promise<RecalledMemory[]> {
    const terms = Array.from(
      new Set(
        dto.query.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((t) => t.length > 2),
      ),
    );
    const qb = this.memories.createQueryBuilder('m')
      .leftJoin('m.tenant', 't')
      .where('t.id=:tenantId', { tenantId })
      .andWhere('(m.expires_at IS NULL OR m.expires_at > now())');
    if (dto.customerId) qb.andWhere('(m.customer_id=:customerId OR m.customer_id IS NULL)', { customerId: dto.customerId });
    else qb.andWhere('m.customer_id IS NULL');
    const candidates = await qb.orderBy('m.importance', 'DESC').addOrderBy('m.created_at', 'DESC').take(200).getMany();
    return candidates
      .map((m) => {
        const lc = m.content.toLowerCase();
        const hits = terms.filter((t) => lc.includes(t)).length;
        const score = terms.length ? hits / terms.length : 0;
        return { id: m.id, type: m.type, content: m.content, importance: m.importance, customerId: m.customer_id ?? null, score };
      })
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score || b.importance - a.importance)
      .slice(0, topK);
  }
}
