import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, Repository } from 'typeorm';

import { AiAgent } from '../../entities/AI Agent/AiAgent';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateAiAgentDto } from './dto/create-ai-agent.dto';
import { UpdateAiAgentDto } from './dto/update-ai-agent.dto';
import { AiAgentFilterDto } from './dto/ai-agent-filter.dto';
import { SystemSettingService } from '../platform/system-setting.service';
import { SettingKey } from '../platform/settings.registry';

/**
 * AI agents.
 *
 * Tenant isolation: every query filters `tenant: { id: tenantId }`; create stamps
 * it; the referenced branch is validated against the tenant.
 *
 * Schema note: `ai_agents` has only `is_active` + a soft-delete column (no status
 * enum). So activate/deactivate ↔ `is_active`; archive ↔ soft-delete; "draft" is
 * not a distinct persisted state.
 */
@Injectable()
export class AiAgentService {
  constructor(
    @InjectRepository(AiAgent) private readonly agents: Repository<AiAgent>,
    @InjectRepository(Branch) private readonly branches: Repository<Branch>,
    private readonly platformSettings: SystemSettingService,
  ) {}

  async create(tenantId: string, dto: CreateAiAgentDto): Promise<AiAgent> {
    if (dto.branchId) await this.assertBranch(tenantId, dto.branchId);
    const defaultTemp = await this.platformSettings.getTyped<number>(
      SettingKey.AI_DEFAULT_TEMP,
    );
    const agent = this.agents.create({
      tenant: { id: tenantId } as Tenant,
      branch: dto.branchId ? ({ id: dto.branchId } as Branch) : undefined,
      name: dto.name,
      // Only an EXPLICIT choice pins a model. Copying `ai.default_model` here
      // froze whatever the default was at creation time, so later changes on
      // /platform/system-settings never reached the agent (the router prefers
      // the agent's own model). NULL = "follow the platform default".
      model: dto.model,
      system_prompt: dto.systemPrompt,
      temperature: dto.temperature ?? defaultTemp,
      is_active: dto.isActive ?? true,
    });
    const saved = await this.agents.save(agent);
    return this.findOne(tenantId, saved.id);
  }

  async findAll(tenantId: string, filter: AiAgentFilterDto) {
    const where: FindOptionsWhere<AiAgent> = { tenant: { id: tenantId } };
    if (filter.search) where.name = ILike(`%${filter.search}%`);
    if (filter.model) where.model = filter.model;
    if (filter.isActive !== undefined) where.is_active = filter.isActive === 'true';

    const [data, total] = await this.agents.findAndCount({
      where,
      relations: { branch: true },
      order: { created_at: 'DESC' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return { data, total, page: filter.page, limit: filter.limit };
  }

  async findOne(tenantId: string, id: string): Promise<AiAgent> {
    const agent = await this.agents.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { branch: true },
    });
    if (!agent) throw new AppError(ErrorCode.NOT_FOUND, { message: 'AI agent not found' });
    return agent;
  }

  async update(tenantId: string, id: string, dto: UpdateAiAgentDto): Promise<AiAgent> {
    const agent = await this.findOne(tenantId, id);
    if (dto.branchId !== undefined) {
      if (dto.branchId) {
        await this.assertBranch(tenantId, dto.branchId);
        agent.branch = { id: dto.branchId } as Branch;
      } else {
        agent.branch = undefined;
      }
    }
    if (dto.name !== undefined) agent.name = dto.name;
    if (dto.model !== undefined) agent.model = dto.model;
    if (dto.systemPrompt !== undefined) agent.system_prompt = dto.systemPrompt;
    if (dto.temperature !== undefined) agent.temperature = dto.temperature;
    if (dto.isActive !== undefined) agent.is_active = dto.isActive;
    await this.agents.save(agent);
    return this.findOne(tenantId, id);
  }

  async setActive(tenantId: string, id: string, active: boolean): Promise<AiAgent> {
    const agent = await this.findOne(tenantId, id);
    agent.is_active = active;
    await this.agents.save(agent);
    return this.findOne(tenantId, id);
  }

  /** Archive = soft-delete (the entity's `deleted_at`). */
  async remove(tenantId: string, id: string): Promise<void> {
    const agent = await this.findOne(tenantId, id);
    await this.agents.softRemove(agent);
  }

  private async assertBranch(tenantId: string, branchId: string): Promise<void> {
    if (!(await this.branches.exists({ where: { id: branchId, tenant: { id: tenantId } } }))) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'Branch not found in this tenant' });
    }
  }
}
