import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';

import { AiTrainingFile } from '../../entities/AI Agent/AiTrainingFile';
import { AiAgent } from '../../entities/AI Agent/AiAgent';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { UploadTrainingFileDto } from './dto/upload-training-file.dto';
import { UpdateTrainingFileDto } from './dto/update-training-file.dto';
import { TrainingFileFilterDto } from './dto/training-file-filter.dto';
import { TRAINING_FILE_STATUS } from './ai.constants';

/**
 * AI training files (metadata + ingestion status).
 *
 * Tenant isolation: every query filters `tenant: { id: tenantId }`; the agent is
 * validated against the tenant. No storage is implemented — `file_url` is stored
 * as provided; processing is an abstraction seam that transitions the status
 * (a real ingestion pipeline would extract text → knowledge-base chunks).
 */
@Injectable()
export class AiTrainingFileService {
  constructor(
    @InjectRepository(AiTrainingFile)
    private readonly files: Repository<AiTrainingFile>,
    @InjectRepository(AiAgent) private readonly agents: Repository<AiAgent>,
  ) {}

  async upload(tenantId: string, dto: UploadTrainingFileDto): Promise<AiTrainingFile> {
    if (dto.agentId) await this.assertAgent(tenantId, dto.agentId);
    const file = this.files.create({
      tenant: { id: tenantId } as Tenant,
      agent: dto.agentId ? ({ id: dto.agentId } as AiAgent) : undefined,
      file_name: dto.fileName,
      file_url: dto.fileUrl,
      file_type: dto.fileType,
      status: TRAINING_FILE_STATUS.UPLOADED,
    });
    return this.files.save(file);
  }

  async findAll(tenantId: string, filter: TrainingFileFilterDto) {
    const where: FindOptionsWhere<AiTrainingFile> = { tenant: { id: tenantId } };
    if (filter.agentId) where.agent = { id: filter.agentId };
    if (filter.status) where.status = filter.status;

    const [data, total] = await this.files.findAndCount({
      where,
      relations: { agent: true },
      order: { created_at: 'DESC' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return { data, total, page: filter.page, limit: filter.limit };
  }

  async findOne(tenantId: string, id: string): Promise<AiTrainingFile> {
    const file = await this.files.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { agent: true },
    });
    if (!file) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Training file not found' });
    return file;
  }

  async update(tenantId: string, id: string, dto: UpdateTrainingFileDto): Promise<AiTrainingFile> {
    const file = await this.findOne(tenantId, id);
    if (dto.fileName !== undefined) file.file_name = dto.fileName;
    if (dto.status !== undefined) file.status = dto.status;
    return this.files.save(file);
  }

  /** Ingestion seam: transitions UPLOADED/FAILED → INDEXED (simulated success). */
  async process(tenantId: string, id: string): Promise<AiTrainingFile> {
    const file = await this.findOne(tenantId, id);
    // A real pipeline: PROCESSING → extract text → create KB chunks → INDEXED/FAILED.
    file.status = TRAINING_FILE_STATUS.INDEXED;
    return this.files.save(file);
  }

  /** Reprocess a FAILED file (architecture seam). */
  async reprocess(tenantId: string, id: string): Promise<AiTrainingFile> {
    const file = await this.findOne(tenantId, id);
    if (file.status !== TRAINING_FILE_STATUS.FAILED) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Only failed files can be reprocessed (current: "${file.status}")`,
      });
    }
    file.status = TRAINING_FILE_STATUS.INDEXED;
    return this.files.save(file);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const file = await this.findOne(tenantId, id);
    await this.files.remove(file);
  }

  private async assertAgent(tenantId: string, agentId: string): Promise<void> {
    if (!(await this.agents.exists({ where: { id: agentId, tenant: { id: tenantId } } }))) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'AI agent not found in this tenant' });
    }
  }
}
