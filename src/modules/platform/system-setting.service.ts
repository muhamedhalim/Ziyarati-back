import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, Repository } from 'typeorm';

import { SystemSetting } from '../../entities/System&Lookup/SystemSetting';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateSystemSettingDto } from './dto/create-system-setting.dto';
import { UpdateSystemSettingDto } from './dto/update-system-setting.dto';
import { QuerySystemSettingsDto } from './dto/query-system-settings.dto';
import {
  KNOWN_SETTING_KEYS,
  SETTINGS_REGISTRY,
  SettingDefinition,
  SettingKey,
} from './settings.registry';

/**
 * PLATFORM-OWNED global settings (`system_settings`).
 *
 * NOT tenant-scoped — these control platform-wide behavior and are managed only
 * by super admins (enforced at the controller via RolesGuard). The entity has no
 * tenant column, so a setting is NEVER associated with a tenant. `key` is unique;
 * `value` is free-form JSON.
 *
 * Typed settings (keys defined in SETTINGS_REGISTRY) are validated against their
 * schema on every write. Raw (unregistered) keys remain free-form for developer
 * use via the advanced editor.
 */
@Injectable()
export class SystemSettingService {
  /** Short-lived in-memory cache to avoid a DB hit on every request. */
  private readonly typedCache = new Map<string, { value: unknown; expiresAt: number }>();
  private static readonly CACHE_TTL_MS = 30_000;

  constructor(
    @InjectRepository(SystemSetting)
    private readonly settings: Repository<SystemSetting>,
  ) {}

  // ──────────────────────────── Typed API ──────────────────────────────── //

  /**
   * Read a typed setting. Returns the registry default if the key has no row
   * yet. Cached for 30 s to avoid per-request DB pressure from guards.
   */
  async getTyped<T>(key: SettingKey): Promise<T> {
    const cached = this.typedCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value as T;
    }

    const def = SETTINGS_REGISTRY[key];
    const row = await this.settings.findOne({ where: { key } });
    const value = (row?.value ?? def.default) as T;

    this.typedCache.set(key, { value, expiresAt: Date.now() + SystemSettingService.CACHE_TTL_MS });
    return value;
  }

  /**
   * Upsert a typed setting by key, validated against the registry schema.
   * Invalidates the cache entry so subsequent reads reflect the new value.
   */
  async upsertByKey(key: SettingKey, value: unknown): Promise<SystemSetting> {
    this.validateValue(key, value);

    const existing = await this.settings.findOne({ where: { key } });
    let result: SystemSetting;

    if (existing) {
      existing.value = value;
      result = await this.settings.save(existing);
    } else {
      result = await this.settings.save(this.settings.create({ key, value }));
    }

    this.typedCache.delete(key);
    return result;
  }

  /**
   * Returns all registry-defined settings merged with their current DB values
   * (or registry defaults when a key has no row yet).
   */
  async listTyped(): Promise<Array<SettingDefinition & { value: unknown }>> {
    return Promise.all(
      Object.values(SettingKey).map(async (key) => {
        const def = SETTINGS_REGISTRY[key];
        const value = await this.getTyped(key);
        return { ...def, value };
      }),
    );
  }

  /** Returns the full registry definition for the frontend to introspect. */
  getRegistry(): typeof SETTINGS_REGISTRY {
    return SETTINGS_REGISTRY;
  }

  // ──────────────────────── Raw CRUD (legacy) ───────────────────────────── //

  async create(dto: CreateSystemSettingDto): Promise<SystemSetting> {
    await this.assertKeyUnique(dto.key);
    if (KNOWN_SETTING_KEYS.has(dto.key)) {
      this.validateValue(dto.key as SettingKey, dto.value);
    }
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
    if (dto.value !== undefined) {
      const finalKey = setting.key;
      if (KNOWN_SETTING_KEYS.has(finalKey)) {
        this.validateValue(finalKey as SettingKey, dto.value);
      }
      setting.value = dto.value;
    }
    const result = await this.settings.save(setting);
    this.typedCache.delete(setting.key);
    return result;
  }

  async remove(id: string) {
    const setting = await this.get(id);
    await this.settings.remove(setting);
    this.typedCache.delete(setting.key);
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

  // ─────────────────────────── Private helpers ──────────────────────────── //

  private validateValue(key: SettingKey, value: unknown): void {
    const def = SETTINGS_REGISTRY[key];
    if (!def) throw new BadRequestException(`Unknown setting key: "${key}"`);

    switch (def.type) {
      case 'boolean':
        if (typeof value !== 'boolean')
          throw new BadRequestException(`Setting "${key}" must be a boolean`);
        break;
      case 'number': {
        if (typeof value !== 'number' || Number.isNaN(value))
          throw new BadRequestException(`Setting "${key}" must be a number`);
        if (def.min !== undefined && value < def.min)
          throw new BadRequestException(`Setting "${key}" must be ≥ ${def.min}`);
        if (def.max !== undefined && value > def.max)
          throw new BadRequestException(`Setting "${key}" must be ≤ ${def.max}`);
        break;
      }
      case 'enum':
        if (!def.allowedValues?.includes(String(value)))
          throw new BadRequestException(
            `Setting "${key}" must be one of: ${def.allowedValues?.join(', ')}`,
          );
        break;
      case 'string':
        if (typeof value !== 'string')
          throw new BadRequestException(`Setting "${key}" must be a string`);
        break;
    }
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
