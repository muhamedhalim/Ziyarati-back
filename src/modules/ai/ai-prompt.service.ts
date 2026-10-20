import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, IsNull, Repository } from 'typeorm';

import { AiPrompt } from '../../entities/AI Agent/AiPrompt';
import { AiAgent } from '../../entities/AI Agent/AiAgent';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { AI_DIRECTIVE_LIMITS } from './ai.constants';
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
 *
 * These rows are the clinic's "directives": while `is_active`, they are loaded
 * on every AI turn by `findActiveForTurn` and added to the system prompt (see
 * `composeClinicDirectives`). Toggling or deleting one therefore changes the
 * very next reply, with no cache in between.
 */
@Injectable()
export class AiPromptService {
  constructor(
    @InjectRepository(AiPrompt) private readonly prompts: Repository<AiPrompt>,
    @InjectRepository(AiAgent) private readonly agents: Repository<AiAgent>,
  ) {}

  async create(tenantId: string, dto: CreateAiPromptDto): Promise<AiPrompt> {
    if (dto.agentId) await this.assertAgent(tenantId, dto.agentId);
    await this.assertRoom(tenantId, dto.isActive ?? true);
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
    if (dto.isActive !== undefined) {
      if (dto.isActive && !prompt.is_active) await this.assertRoom(tenantId, true, false);
      prompt.is_active = dto.isActive;
    }
    return this.prompts.save(prompt);
  }

  async setActive(tenantId: string, id: string, active: boolean): Promise<AiPrompt> {
    const prompt = await this.findOne(tenantId, id);
    if (active && !prompt.is_active) await this.assertRoom(tenantId, true, false);
    prompt.is_active = active;
    return this.prompts.save(prompt);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const prompt = await this.findOne(tenantId, id);
    await this.prompts.remove(prompt);
  }

  /**
   * The directives that govern ONE AI turn: this tenant's active rows that are
   * either clinic-wide (no agent) or assigned to the agent running the turn,
   * oldest first, capped at the per-clinic active limit.
   *
   * `tenantId` is always the server-resolved tenant of the turn (the
   * conversation's tenant, or the validated selected clinic on the public
   * widget) — never a value from the request. One indexed-by-FK read per turn,
   * deliberately uncached so deactivating or deleting a directive takes effect on
   * the next reply.
   */
  async findActiveForTurn(tenantId: string, agentId?: string | null): Promise<string[]> {
    const base: FindOptionsWhere<AiPrompt> = { tenant: { id: tenantId }, is_active: true };
    const where: FindOptionsWhere<AiPrompt>[] = [{ ...base, agent: IsNull() }];
    if (agentId) where.push({ ...base, agent: { id: agentId } });
    const rows = await this.prompts.find({
      where,
      select: { id: true, content: true, created_at: true },
      order: { created_at: 'ASC', id: 'ASC' },
      take: AI_DIRECTIVE_LIMITS.MAX_ACTIVE,
    });
    return rows.map((r) => r.content);
  }

  /** Per-clinic bounds: how many directives exist, and how many reach the model. */
  private async assertRoom(tenantId: string, willBeActive: boolean, isNew = true): Promise<void> {
    if (isNew) {
      const total = await this.prompts.count({ where: { tenant: { id: tenantId } } });
      if (total >= AI_DIRECTIVE_LIMITS.MAX_TOTAL) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: `A clinic can keep at most ${AI_DIRECTIVE_LIMITS.MAX_TOTAL} directives. Delete one first.`,
        });
      }
    }
    if (!willBeActive) return;
    const active = await this.prompts.count({ where: { tenant: { id: tenantId }, is_active: true } });
    if (active >= AI_DIRECTIVE_LIMITS.MAX_ACTIVE) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `At most ${AI_DIRECTIVE_LIMITS.MAX_ACTIVE} directives can be active at once. Deactivate one first.`,
      });
    }
  }

  private async assertAgent(tenantId: string, agentId: string): Promise<void> {
    if (!(await this.agents.exists({ where: { id: agentId, tenant: { id: tenantId } } }))) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'AI agent not found in this tenant' });
    }
  }
}
