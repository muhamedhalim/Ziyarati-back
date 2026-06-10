import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, Repository } from 'typeorm';

import { SystemSetting } from '../../entities/System&Lookup/SystemSetting';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateSystemSettingDto } from './dto/create-system-setting.dto';
import { UpdateSystemSettingDto } from './dto/update-system-setting.dto';
import { QuerySystemSettingsDto } from './dto/query-system-settings.dto';

/**
 * PLATFORM-OWNED global settings (`system_settings`).
 *
 * NOT tenant-scoped — these control platform-wide behavior and are managed only
 * by super admins (enforced at the controller via RolesGuard). The entity has no
 * tenant column, so a setting is NEVER associated with a tenant. `key` is unique;
 * `value` is free-form JSON.
 */
@Injectable()
export class SystemSettingService {
  constructor(
    @InjectRepository(SystemSetting)
    private readonly settings: Repository<SystemSetting>,
  ) {}

  async create(dto: CreateSystemSettingDto): Promise<SystemSetting> {
    await this.assertKeyUnique(dto.key);
    return this.settings.save(
      this.settings.create({ key: dto.key, value: dto.value }),
    );
  }

  async update(id: string, dto: UpdateSystemSettingDto): Promise<SystemSetting> {
    const setting = await this.get(id);
    if (dto.key && dto.key !== setting.key) {
      await this.assertKeyUnique(dto.key);
      setting.key = dto.key;
    }
    if (dto.value !== undefined) setting.value = dto.value;
    return this.settings.save(setting);
  }

  async remove(id: string) {
    const setting = await this.get(id);
    await this.settings.remove(setting);
    return { id, deleted: true };
  }

  async get(id: string): Promise<SystemSetting> {
    const setting = await this.settings.findOne({ where: { id } });
    if (!setting) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'System setting not found' });
    }
    return setting;
  }

  async list(query: QuerySystemSettingsDto) {
    const where: FindOptionsWhere<SystemSetting> = {};
    if (query.key) where.key = ILike(`%${query.key}%`);

    const [data, total] = await this.settings.findAndCount({
      where,
      order: { key: 'ASC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data, total, page: query.page, limit: query.limit };
  }

  private async assertKeyUnique(key: string): Promise<void> {
    const existing = await this.settings.findOne({ where: { key } });
    if (existing) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'A system setting with this key already exists',
      });
    }
  }
}
