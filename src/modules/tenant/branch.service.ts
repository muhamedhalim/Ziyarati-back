import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Branch } from '../../entities/SaaS-Core/Branch';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { AppError, ErrorCode } from '../../common/errors';

/**
 * Branches are a child aggregate of Tenant. EVERY method is scoped to a
 * `tenantId` (supplied by the controller from the authenticated principal), so
 * one clinic can never read or mutate another clinic's branches.
 */
@Injectable()
export class BranchService {
  constructor(
    @InjectRepository(Branch) private readonly branches: Repository<Branch>,
  ) {}

  create(tenantId: string, dto: CreateBranchDto): Promise<Branch> {
    const branch = this.branches.create({
      tenant: { id: tenantId } as Tenant,
      name: dto.name,
      address: dto.address,
      city_id: dto.cityId,
      phone: dto.phone,
      whatsapp_phone: dto.whatsappPhone,
      timezone: dto.timezone ?? 'UTC',
      is_active: true,
    });
    return this.branches.save(branch);
  }

  findAll(tenantId: string): Promise<Branch[]> {
    return this.branches.find({
      where: { tenant: { id: tenantId } },
      order: { created_at: 'ASC' },
    });
  }

  async findOne(tenantId: string, id: string): Promise<Branch> {
    const branch = await this.branches.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!branch) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Branch not found' });
    }
    return branch;
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateBranchDto,
  ): Promise<Branch> {
    const branch = await this.findOne(tenantId, id);
    Object.assign(branch, {
      name: dto.name ?? branch.name,
      address: dto.address ?? branch.address,
      city_id: dto.cityId ?? branch.city_id,
      phone: dto.phone ?? branch.phone,
      whatsapp_phone: dto.whatsappPhone ?? branch.whatsapp_phone,
      timezone: dto.timezone ?? branch.timezone,
      is_active: dto.isActive ?? branch.is_active,
    });
    return this.branches.save(branch);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const branch = await this.findOne(tenantId, id);
    await this.branches.softRemove(branch);
  }
}
