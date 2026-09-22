import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SystemSetting } from '../../entities/System&Lookup/SystemSetting';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';

import {
  SETTINGS_REGISTRY,
  SettingDefinition,
  SettingKey,
} from './settings.registry';
import {
  PlatformAdminAuditService,
  PLATFORM_ADMIN_AUDIT_ACTION,
} from './platform-admin-audit.service';

/**
 * PLATFORM-OWNED global settings (`system_settings`).
 *
 * NOT tenant-scoped — these control platform-wide behavior and are managed only
 * by super admins (enforced at the controller via RolesGuard). The entity has no
 * tenant column, so a setting is NEVER associated with a tenant. `key` is unique;
 * `value` is free-form JSON.
 *
 * Typed settings (keys defined in SETTINGS_REGISTRY) are validated against their
 * schema on every write.
 */
@Injectable()
export class SystemSettingService {
  /**
   * Short-lived in-memory cache to avoid a DB hit on every request.
   *
   * Multi-replica note (L7 — docs/CACHING_QUEUES_AUDIT.md): this cache is
   * PER-PROCESS and `.delete()`/write-invalidation only clears the replica
   * that handled the write. With >1 API replica, the others keep serving the
   * old value for up to `CACHE_TTL_MS`. Accepted deliberately: these are
   * platform-wide settings changed rarely by a super admin, not per-request
   * tenant data, so a bounded 30s propagation lag across replicas is a much
   * cheaper trade-off than a Redis-backed cross-replica cache (extra
   * round-trip on every settings read) for something this low-churn.
   */
  private readonly typedCache = new Map<
    string,
    { value: unknown; expiresAt: number }
  >();
  private static readonly CACHE_TTL_MS = 30_000;

  constructor(
    @InjectRepository(SystemSetting)
    private readonly settings: Repository<SystemSetting>,
    private readonly audit: PlatformAdminAuditService,
    private readonly tenantContext: TenantContextService,
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

    this.typedCache.set(key, {
      value,
      expiresAt: Date.now() + SystemSettingService.CACHE_TTL_MS,
    });
    return value;
  }

  /**
   * Upsert a typed setting by key, validated against the registry schema.
   * Invalidates the cache entry so subsequent reads reflect the new value.
   */
  async upsertByKey(key: SettingKey, value: unknown): Promise<SystemSetting> {
    this.validateValue(key, value);

    const existing = await this.settings.findOne({ where: { key } });
    const before = existing ? { key: existing.key, value: existing.value } : null;
    let result: SystemSetting;

    if (existing) {
      existing.value = value;
      result = await this.settings.save(existing);
    } else {
      result = await this.settings.save(this.settings.create({ key, value }));
    }

    this.typedCache.delete(key);
    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.SETTING_UPSERT,
      userId: this.actorId(),
      entityType: 'system_setting',
      entityId: result.id,
      before,
      after: { key: result.key, value: result.value },
    });
    return result;
  }

  /**
   * Returns all registry-defined settings merged with their current DB values
   * (or registry defaults when a key has no row yet).
   *
   * F-22: `source` distinguishes "a super admin deliberately set this" from
   * "nobody has ever touched it, this is just the code default" — for
   * `ai.default_model` specifically, that is the difference between "we chose
   * gpt-5.6-terra" and "the platform silently runs terra because no one has
   * looked". Without it, `value` alone can't tell the two apart.
   */
  async listTyped(): Promise<Array<SettingDefinition & { value: unknown; source: 'override' | 'default' }>> {
    return Promise.all(
      Object.values(SettingKey).map(async (key) => {
        const def = SETTINGS_REGISTRY[key];
        const [value, row] = await Promise.all([
          this.getTyped(key),
          this.settings.findOne({ where: { key } }),
        ]);
        return { ...def, value, source: row ? ('override' as const) : ('default' as const) };
      }),
    );
  }

  /** Returns the full registry definition for the frontend to introspect. */
  getRegistry(): typeof SETTINGS_REGISTRY {
    return SETTINGS_REGISTRY;
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
          throw new BadRequestException(
            `Setting "${key}" must be ≥ ${def.min}`,
          );
        if (def.max !== undefined && value > def.max)
          throw new BadRequestException(
            `Setting "${key}" must be ≤ ${def.max}`,
          );
        if (def.step !== undefined && def.step > 0) {
          // Tolerance, not exact modulo: (value - min) / step lands on an
          // integer only up to float error (e.g. 0.3 / 0.1 === 2.9999999999999996).
          const steps = (value - (def.min ?? 0)) / def.step;
          if (Math.abs(steps - Math.round(steps)) > 1e-9)
            throw new BadRequestException(
              `Setting "${key}" must be a multiple of ${def.step}`,
            );
        }
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

  /** The acting super admin, when this call has an HTTP caller (ALS-scoped). */
  private actorId(): string | undefined {
    return this.tenantContext.getUser()?.id;
  }
}
