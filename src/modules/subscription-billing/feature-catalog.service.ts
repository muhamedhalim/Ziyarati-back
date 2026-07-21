import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';

import { FeatureDefinition } from '../../entities/SaaS-Core/FeatureDefinition';
import { FeatureFlag } from '../../entities/SaaS-Core/FeatureFlag';
import { FeaturePlan } from '../../entities/SaaS-Core/FeaturePlan';
import { FeatureDependency } from '../../entities/SaaS-Core/FeatureDependency';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { User } from '../../entities/Auth&RBAC/User';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { FeatureFlagService } from './feature-flag.service';
import { FeatureResolverService } from './feature-resolver.service';
import {
  BulkSetTenantFeaturesDto,
  QueryFeatureDefinitionsDto,
  UpsertFeatureDefinitionDto,
} from './dto/feature-catalog.dto';

export interface CatalogActor {
  id?: string;
  ip?: string;
}

/**
 * Super-admin feature catalog + cross-tenant management. Extends the existing
 * per-tenant feature-flag system: the catalog (`feature_definitions`) supplies
 * global defaults/metadata, while the actual toggle reuses
 * {@link FeatureFlagService.set} (the same `feature_flags` override store the
 * runtime `FeatureGuard` reads). Every change is written to `audit_logs`.
 */
@Injectable()
export class FeatureCatalogService {
  private readonly logger = new Logger(FeatureCatalogService.name);

  constructor(
    @InjectRepository(FeatureDefinition)
    private readonly definitions: Repository<FeatureDefinition>,
    @InjectRepository(FeatureFlag)
    private readonly flags: Repository<FeatureFlag>,
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
    @InjectRepository(FeaturePlan)
    private readonly featurePlans: Repository<FeaturePlan>,
    @InjectRepository(FeatureDependency)
    private readonly dependencies: Repository<FeatureDependency>,
    private readonly featureFlags: FeatureFlagService,
    private readonly resolver: FeatureResolverService,
  ) {}

  // ── Catalog ──────────────────────────────────────────────────────────────

  listDefinitions(q: QueryFeatureDefinitionsDto): Promise<FeatureDefinition[]> {
    const where: Record<string, unknown> = {};
    if (q.category) where.category = q.category;
    if (q.search) where.name = ILike(`%${q.search}%`);
    return this.definitions.find({
      where,
      order: { category: 'ASC', name: 'ASC' },
    });
  }

  async upsertDefinition(
    dto: UpsertFeatureDefinitionDto,
    actor: CatalogActor,
  ): Promise<FeatureDefinition> {
    let def = await this.definitions.findOne({
      where: { feature_key: dto.featureKey },
    });
    const isNew = !def;
    if (!def) def = this.definitions.create({ feature_key: dto.featureKey });
    def.name = dto.name;
    def.description = dto.description;
    def.category = dto.category ?? def.category ?? 'General';
    if (dto.defaultEnabled !== undefined) def.default_enabled = dto.defaultEnabled;
    if (dto.isActive !== undefined) def.is_active = dto.isActive;
    if (dto.visibility !== undefined) def.visibility = dto.visibility;
    if (dto.isBeta !== undefined) def.is_beta = dto.isBeta;
    if (dto.isDeprecated !== undefined) def.is_deprecated = dto.isDeprecated;
    if (dto.usageMetric !== undefined) def.usage_metric = dto.usageMetric;
    const saved = await this.definitions.save(def);

    await this.audit('FEATURE_DEFINITION_UPSERT', actor, saved.id, {
      featureKey: dto.featureKey,
      new: isNew,
    });
    return saved;
  }

  // ── Per-tenant effective view ────────────────────────────────────────────

  /**
   * Full effective resolution for a tenant — delegates to the single
   * {@link FeatureResolverService} (subscription + plan + dependencies + quota).
   */
  async getTenantFeatures(tenantId: string) {
    await this.assertTenant(tenantId);
    return this.resolver.resolveTenant(tenantId);
  }

  // ── Plan availability + dependency graph (super-admin) ───────────────────

  async setPlans(featureKey: string, planIds: string[], actor: CatalogActor) {
    await this.assertDefinition(featureKey);
    await this.featurePlans.delete({ feature_key: featureKey });
    if (planIds.length) {
      await this.featurePlans.save(
        planIds.map((pid) =>
          this.featurePlans.create({ feature_key: featureKey, plan_id: pid }),
        ),
      );
    }
    await this.audit('FEATURE_PLANS_SET', actor, featureKey, { planIds });
    return { featureKey, planIds };
  }

  async setDependencies(
    featureKey: string,
    requires: string[],
    actor: CatalogActor,
  ) {
    await this.assertDefinition(featureKey);
    const unique = [...new Set(requires)];
    for (const req of unique) {
      if (req === featureKey) {
        throw new AppError(ErrorCode.BAD_REQUEST, {
          message: 'A feature cannot depend on itself',
        });
      }
      // Reject a cycle: the new prerequisite must not (transitively) require us.
      const reachable = await this.resolver.dependenciesOf(req);
      if (reachable.includes(featureKey)) {
        throw new AppError(ErrorCode.BAD_REQUEST, {
          message: `Circular dependency: "${req}" already requires "${featureKey}"`,
          publicContext: { featureKey, requires: req },
        });
      }
    }
    await this.dependencies.delete({ feature_key: featureKey });
    if (unique.length) {
      await this.dependencies.save(
        unique.map((r) =>
          this.dependencies.create({ feature_key: featureKey, requires_key: r }),
        ),
      );
    }
    await this.audit('FEATURE_DEPS_SET', actor, featureKey, { requires: unique });
    return { featureKey, requires: unique };
  }

  // ── Toggling (reuses FeatureFlagService.set) ─────────────────────────────

  async setTenantFeature(
    tenantId: string,
    featureKey: string,
    enabled: boolean,
    actor: CatalogActor,
  ): Promise<FeatureFlag> {
    await this.assertTenant(tenantId);

    // Enabling requires all dependencies to already be satisfied for this tenant.
    if (enabled) {
      const resolution = await this.resolver.resolveTenant(tenantId);
      const target = resolution.features.find((f) => f.featureKey === featureKey);
      if (target && target.missingDependencies.length > 0) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: `Cannot enable "${featureKey}": missing dependencies: ${target.missingDependencies.join(', ')}.`,
          publicContext: { featureKey, missing: target.missingDependencies },
        });
      }
    }

    const flag = await this.featureFlags.set(tenantId, featureKey, enabled);
    await this.audit('FEATURE_FLAG_SET', actor, tenantId, { featureKey, enabled });
    return flag;
  }

  async bulkSetTenantFeatures(
    tenantId: string,
    dto: BulkSetTenantFeaturesDto,
    actor: CatalogActor,
  ): Promise<{ updated: number }> {
    await this.assertTenant(tenantId);
    for (const u of dto.updates) {
      await this.featureFlags.set(tenantId, u.featureKey, u.enabled);
    }
    await this.audit('FEATURE_FLAG_BULK', actor, tenantId, {
      count: dto.updates.length,
      updates: dto.updates,
    });
    return { updated: dto.updates.length };
  }

  // ── Bootstrap seed (idempotent) ──────────────────────────────────────────

  /** Seeds a starter catalog when empty. New features are added via the API. */
  async seedDefaults(catalog: Omit<UpsertFeatureDefinitionDto, never>[]): Promise<void> {
    const count = await this.definitions.count();
    if (count > 0) return;
    await this.definitions.save(
      catalog.map((c) =>
        this.definitions.create({
          feature_key: c.featureKey,
          name: c.name,
          description: c.description,
          category: c.category ?? 'General',
          default_enabled: c.defaultEnabled ?? false,
          is_active: c.isActive ?? true,
        }),
      ),
    );
    this.logger.log(`Seeded ${catalog.length} feature definitions`);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async assertTenant(tenantId: string): Promise<void> {
    const exists = await this.tenants.exists({ where: { id: tenantId } });
    if (!exists) throw new AppError(ErrorCode.TENANT_NOT_FOUND);
  }

  private async assertDefinition(featureKey: string): Promise<void> {
    const exists = await this.definitions.exists({ where: { feature_key: featureKey } });
    if (!exists) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: `Feature "${featureKey}" is not in the catalog`,
      });
    }
  }

  private async audit(
    action: string,
    actor: CatalogActor,
    entityId: string,
    newValues: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditLogs.save(
        this.auditLogs.create({
          user: actor.id ? ({ id: actor.id } as User) : undefined,
          action,
          entity_type: 'feature_flag',
          entity_id: entityId,
          new_values: newValues,
          ip_address: actor.ip,
        }),
      );
    } catch (err) {
      this.logger.warn(`Feature audit write failed (${action}): ${(err as Error)?.message}`);
    }
  }
}
