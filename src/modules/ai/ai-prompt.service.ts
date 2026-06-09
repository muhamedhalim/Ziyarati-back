import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, Repository } from 'typeorm';

import { AiPrompt } from '../../entities/AI Agent/AiPrompt';
import { AiAgent } from '../../entities/AI Agent/AiAgent';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateAiPromptDto } from './dto/create-ai-prompt.dto';
import { UpdateAiPromptDto } from './dto/update-ai-prompt.dto';
import { AiPromptFilterDto } from './dto/ai-prompt-filter.dto';

/**
 * AI prompts.
 *
 * Schema note: `ai_prompts` has only name/content/is_active/agent — there is NO
 * `type` or `version` column, so prompt type & versioning are not persisted
 * (would require a migration). Activate/deactivate ↔ `is_active`; "assign to
 * agent" ↔ setting `agent`.
 *
 * Tenant isolation: every query filters `tenant: { id: tenantId }`; the agent is
 * validated against the tenant.
 */
@Injectable()
export class AiPromptService {
  constructor(
    @InjectRepository(AiPrompt) private readonly prompts: Repository<AiPrompt>,
    @InjectRepository(AiAgent) private readonly agents: Repository<AiAgent>,
  ) {}

  async create(tenantId: string, dto: CreateAiPromptDto): Promise<AiPrompt> {
    if (dto.agentId) await this.assertAgent(tenantId, dto.agentId);
    const prompt = this.prompts.create({
      tenant: { id: tenantId } as Tenant,
      agent: dto.agentId ? ({ id: dto.agentId } as AiAgent) : undefined,
      name: dto.name,
      content: dto.content,
      is_active: dto.isActive ?? true,
    });
    return this.prompts.save(prompt);
  }

  async findAll(tenantId: string, filter: AiPromptFilterDto) {
    const where: FindOptionsWhere<AiPrompt> = { tenant: { id: tenantId } };
    if (filter.agentId) where.agent = { id: filter.agentId };
    if (filter.search) where.name = ILike(`%${filter.search}%`);
    if (filter.isActive !== undefined) where.is_active = filter.isActive === 'true';

    const [data, total] = await this.prompts.findAndCount({
      where,
      relations: { agent: true },
      order: { created_at: 'DESC' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return { data, total, page: filter.page, limit: filter.limit };
  }

  async findOne(tenantId: string, id: string): Promise<AiPrompt> {
    const prompt = await this.prompts.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { agent: true },
    });
    if (!prompt) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Prompt not found' });
    return prompt;
  }

  async update(tenantId: string, id: string, dto: UpdateAiPromptDto): Promise<AiPrompt> {
    const prompt = await this.findOne(tenantId, id);
    if (dto.agentId !== undefined) {
      if (dto.agentId) {
        await this.assertAgent(tenantId, dto.agentId);
        prompt.agent = { id: dto.agentId } as AiAgent;
      } else {
        prompt.agent = undefined;
      }
    }
    if (dto.name !== undefined) prompt.name = dto.name;
    if (dto.content !== undefined) prompt.content = dto.content;
    if (dto.isActive !== undefined) prompt.is_active = dto.isActive;
    return this.prompts.save(prompt);
  }

  async setActive(tenantId: string, id: string, active: boolean): Promise<AiPrompt> {
    const prompt = await this.findOne(tenantId, id);
    prompt.is_active = active;
    return this.prompts.save(prompt);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const prompt = await this.findOne(tenantId, id);
    await this.prompts.remove(prompt);
  }

  private async assertAgent(tenantId: string, agentId: string): Promise<void> {
    if (!(await this.agents.exists({ where: { id: agentId, tenant: { id: tenantId } } }))) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'AI agent not found in this tenant' });
    }
  }
}
