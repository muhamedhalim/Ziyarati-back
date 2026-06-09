import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, Repository } from 'typeorm';

import { AiKnowledgeBase } from '../../entities/AI Agent/AiKnowledgeBase';
import { AiAgent } from '../../entities/AI Agent/AiAgent';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateKnowledgeBaseDto } from './dto/create-knowledge-base.dto';
import { UpdateKnowledgeBaseDto } from './dto/update-knowledge-base.dto';
import { KnowledgeBaseFilterDto } from './dto/knowledge-base-filter.dto';

/**
 * AI knowledge base.
 *
 * Schema note: `ai_knowledge_bases` requires `agent` + `content` and has no
 * name/status/enabled column (embedding is commented out). So a row is a
 * knowledge CHUNK belonging to an agent; statuses/enable-disable are not
 * persisted, and "search" is a content match (keyword) — vector retrieval would
 * replace this without changing callers.
 *
 * Tenant isolation: every query filters `tenant: { id: tenantId }`; the agent is
 * validated against the tenant.
 */
@Injectable()
export class AiKnowledgeBaseService {
  constructor(
    @InjectRepository(AiKnowledgeBase)
    private readonly kb: Repository<AiKnowledgeBase>,
    @InjectRepository(AiAgent) private readonly agents: Repository<AiAgent>,
  ) {}

  async create(tenantId: string, dto: CreateKnowledgeBaseDto): Promise<AiKnowledgeBase> {
    await this.assertAgent(tenantId, dto.agentId);
    const entry = this.kb.create({
      tenant: { id: tenantId } as Tenant,
      agent: { id: dto.agentId } as AiAgent,
      content: dto.content,
      source_type: dto.sourceType,
      source_id: dto.sourceId,
    });
    return this.kb.save(entry);
  }

  async findAll(tenantId: string, filter: KnowledgeBaseFilterDto) {
    const where: FindOptionsWhere<AiKnowledgeBase> = { tenant: { id: tenantId } };
    if (filter.agentId) where.agent = { id: filter.agentId };
    if (filter.search) where.content = ILike(`%${filter.search}%`);

    const [data, total] = await this.kb.findAndCount({
      where,
      relations: { agent: true },
      order: { created_at: 'DESC' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return { data, total, page: filter.page, limit: filter.limit };
  }

  async findOne(tenantId: string, id: string): Promise<AiKnowledgeBase> {
    const entry = await this.kb.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { agent: true },
    });
    if (!entry) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Knowledge base entry not found' });
    return entry;
  }

  async update(tenantId: string, id: string, dto: UpdateKnowledgeBaseDto): Promise<AiKnowledgeBase> {
    const entry = await this.findOne(tenantId, id);
    if (dto.content !== undefined) entry.content = dto.content;
    if (dto.sourceType !== undefined) entry.source_type = dto.sourceType;
    if (dto.sourceId !== undefined) entry.source_id = dto.sourceId;
    return this.kb.save(entry);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const entry = await this.findOne(tenantId, id);
    await this.kb.remove(entry);
  }

  /**
   * Rebuild-embeddings abstraction. No vector column is active in the schema, so
   * this is an architecture seam: it acknowledges the request and reports the
   * chunk count. A real implementation would enqueue an embedding job.
   */
  async rebuildEmbeddings(tenantId: string, agentId: string) {
    await this.assertAgent(tenantId, agentId);
    const chunks = await this.kb.count({ where: { tenant: { id: tenantId }, agent: { id: agentId } } });
    return { accepted: true, agentId, chunks, note: 'Embedding rebuild is an abstraction seam (no vector store configured).' };
  }

  private async assertAgent(tenantId: string, agentId: string): Promise<void> {
    if (!(await this.agents.exists({ where: { id: agentId, tenant: { id: tenantId } } }))) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'AI agent not found in this tenant' });
    }
  }
}
