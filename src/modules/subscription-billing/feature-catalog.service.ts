import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, ILike, Repository } from 'typeorm';

import { FeatureDefinition } from '../../entities/SaaS-Core/FeatureDefinition';
import {
  AUTHORITATIVE_FLAG_SOURCES,
  FeatureFlag,
} from '../../entities/SaaS-Core/FeatureFlag';
import { FeaturePlan } from '../../entities/SaaS-Core/FeaturePlan';
import { FeatureDependency } from '../../entities/SaaS-Core/FeatureDependency';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { User } from '../../entities/Auth&RBAC/User';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { FeatureFlagService } from './feature-flag.service';
import {
  FeatureAdminState,
  FeatureResolverService,
} from './feature-resolver.service';
import {
  FEATURE_KEYS,
  FEATURE_REGISTRY,
  FeatureKey,
  dependencyClosure,
  isFeatureKey,
} from './feature-registry';
import { FeatureFlagSource } from '../../entities/SaaS-Core/FeatureFlag';
import { AccessCacheService } from './access-cache.service';
import {
  BulkSetTenantFeaturesDto,
  QueryFeatureDefinitionsDto,
  UpsertFeatureDefinitionDto,
} from './dto/feature-catalog.dto';

// Re-exported so the audit record, the console payload and this service all
// name the same three states from one definition.
export type { FeatureAdminState };

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
    private readonly cache: AccessCacheService,
    private readonly dataSource: DataSource,
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
    if (dto.defaultEnabled !== undefined)
      def.default_enabled = dto.defaultEnabled;
    if (dto.isActive !== undefined) def.is_active = dto.isActive;
    if (dto.visibility !== undefined) def.visibility = dto.visibility;
    if (dto.isBeta !== undefined) def.is_beta = dto.isBeta;
    if (dto.isDeprecated !== undefined) def.is_deprecated = dto.isDeprecated;
    if (dto.usageMetric !== undefined) def.usage_metric = dto.usageMetric;
    const saved = await this.definitions.save(def);
    // `default_enabled` / `is_active` feed `isFeatureOn` for every tenant that
    // has no explicit flag row.
    this.cache.invalidateAll();

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
    // Plan entitlement is consulted by EVERY tenant's decision (precedence rule
    // 4), so this is one of the few genuinely platform-wide busts.
    this.cache.invalidateAll();
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
          this.dependencies.create({
            feature_key: featureKey,
            requires_key: r,
          }),
        ),
      );
    }
    this.cache.invalidateAll();
    await this.audit('FEATURE_DEPS_SET', actor, featureKey, {
      requires: unique,
    });
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
    const key = this.toFeatureKey(featureKey);

    // NOTE: this used to REFUSE the toggle when the feature's dependencies
    // were not already satisfied for the tenant. That check is now not just
    // unnecessary but wrong: `AccessControlService` grants a feature override
    // together with its registry-declared dependency closure, so enabling
    // WhatsApp for a tenant with no subscription is exactly the supported
    // workflow — and the old check refused it, because `conversations` and
    // `crm` were reported missing for precisely the reason the operator was
    // trying to fix.
    const previous = await this.featureFlags.isEnabled(tenantId, key);
    const flag = await this.featureFlags.set(tenantId, key, enabled, {
      source: FeatureFlagSource.PLATFORM_ADMIN,
      actorId: actor.id,
    });
    await this.audit(
      'FEATURE_FLAG_SET',
      actor,
      tenantId,
      {
        featureKey: key,
        enabled,
        grants: enabled ? [key, ...dependencyClosure(key)] : [],
      },
      { featureKey: key, enabled: previous },
    );
    return flag;
  }

  /**
   * Suspend or lift the suspension of one capability for one tenant.
   *
   * This is the operator's kill-switch, and it is the ONLY control that
   * outranks a paid subscription. Four properties it must have, and how each is
   * obtained:
   *
   *  - **Reachable.** `FeatureFlagService.setSuspension` existed with no route
   *    to it, so the precedence rule was enforced but the switch could not be
   *    thrown. This endpoint is that route.
   *  - **Justified.** A suspension without a reason is unauditable six months
   *    later, so one is required to suspend (never to lift — an operator
   *    restoring service should not be made to explain themselves first).
   *  - **Durably recorded.** Unlike every other catalog write, the audit here
   *    is NOT best-effort: the flag write and the audit row commit in ONE
   *    transaction, so a failed audit rolls the suspension back. An
   *    entitlement kill-switch with no record of who threw it and why is worse
   *    than no kill-switch.
   *  - **Immediate.** Invalidated across replicas after the commit, so the
   *    suspension takes effect on the next request everywhere rather than when
   *    a TTL happens to lapse.
   *
   * Refuses `alwaysOn` capabilities. Billing, support and the workspace shell
   * are exempt from gating by design — a blocked clinic must still be able to
   * pay and ask for help — so a suspension there would be silently ignored by
   * the policy. Refusing loudly beats accepting a control that does nothing.
   */
  async setTenantFeatureSuspension(
    tenantId: string,
    featureKey: string,
    suspended: boolean,
    reason: string | undefined,
    actor: CatalogActor,
  ): Promise<FeatureFlag> {
    await this.assertTenant(tenantId);
    const key = this.toFeatureKey(featureKey);
    this.assertSuspendable(key, suspended, reason);

    const before = await this.flags.findOne({
      where: { tenant: { id: tenantId }, feature_key: key },
    });

    const saved = await this.dataSource.transaction(async (manager) => {
      const flag = await this.featureFlags.setSuspension(
        tenantId,
        key,
        suspended,
        { actorId: actor.id, reason: reason?.trim(), manager },
      );
      // STRICT: no try/catch. If this write fails the transaction aborts and
      // the suspension never happened — see the docblock.
      await manager.getRepository(AuditLog).save(
        manager.getRepository(AuditLog).create({
          user: actor.id ? ({ id: actor.id } as User) : undefined,
          action: suspended ? 'FEATURE_FLAG_SUSPEND' : 'FEATURE_FLAG_UNSUSPEND',
          entity_type: 'feature_flag',
          entity_id: tenantId,
          old_values: {
            featureKey: key,
            suspended: before?.is_suspended ?? false,
            reason: before?.suspended_reason ?? null,
          },
          new_values: {
            featureKey: key,
            suspended,
            reason: suspended ? (reason?.trim() ?? null) : null,
            source: flag.source,
          },
          ip_address: actor.ip,
        }),
      );
      return flag;
    });

    // Again after COMMIT: the bust inside the transaction cannot stop another
    // replica from repopulating its cache from the pre-commit state in the
    // window between the two.
    this.cache.invalidate(tenantId);
    return saved;
  }

  // ── The three-way administrative control ─────────────────────────────────

  /**
   * Move one capability to one of the three states a super-admin controls.
   *
   * Exists because the console has to move a tenant BETWEEN states, and the two
   * boolean endpoints cannot do that atomically. `suspended → granted` is a
   * lift plus a grant; run as two requests there is a window in which the
   * capability is neither suspended nor granted, and every route for it answers
   * NO_ACTIVE_SUBSCRIPTION to a clinic the operator is in the middle of
   * enabling. Both writes commit together here, or neither does.
   *
   * Composes {@link FeatureFlagService.set} and
   * {@link FeatureFlagService.setSuspension} — it does not reimplement either,
   * and it makes no access decision of its own. `AccessControlService` remains
   * the only thing that reads these rows and decides what they mean.
   *
   * A suspension deliberately LEAVES any existing grant in place: the two
   * columns say different things (`is_enabled` = "was this given?",
   * `is_suspended` = "is this blocked?"), and clearing the grant on suspend
   * would silently destroy the state to return to when the block is lifted.
   */
  async setTenantFeatureState(
    tenantId: string,
    featureKey: string,
    state: FeatureAdminState,
    reason: string | undefined,
    actor: CatalogActor,
  ): Promise<FeatureFlag> {
    await this.assertTenant(tenantId);
    const key = this.toFeatureKey(featureKey);
    this.assertSuspendable(key, state === 'suspended', reason);

    const before = await this.flags.findOne({
      where: { tenant: { id: tenantId }, feature_key: key },
    });
    const previous = this.adminStateOf(before);

    const saved = await this.dataSource.transaction(async (manager) => {
      const flag = await this.applyState(
        tenantId,
        key,
        state,
        reason,
        actor,
        before,
        manager,
      );
      // STRICT, like `setTenantFeatureSuspension`: this endpoint can set a
      // suspension, and an entitlement kill-switch with no record of who threw
      // it is worse than no kill-switch. A failed audit rolls the change back.
      await manager.getRepository(AuditLog).save(
        manager.getRepository(AuditLog).create({
          user: actor.id ? ({ id: actor.id } as User) : undefined,
          action: 'FEATURE_FLAG_STATE_SET',
          entity_type: 'feature_flag',
          entity_id: tenantId,
          old_values: { featureKey: key, state: previous },
          new_values: {
            featureKey: key,
            state,
            reason: state === 'suspended' ? (reason?.trim() ?? null) : null,
            // What a grant actually opens, recorded so the audit answers
            // "what did this change?" without re-deriving the closure later.
            grants: state === 'granted' ? [key, ...dependencyClosure(key)] : [],
          },
          ip_address: actor.ip,
        }),
      );
      return flag;
    });

    // Again after COMMIT — the bust inside the transaction cannot stop another
    // replica repopulating its cache from pre-commit state in between.
    this.cache.invalidate(tenantId);
    return saved;
  }

  /**
   * Apply one state to many capabilities.
   *
   * Validates the WHOLE batch before writing any of it (same reason as
   * {@link bulkSetTenantFeatures}: a partial apply leaves the tenant in a state
   * neither the operator nor the audit record describes), then applies every
   * key inside ONE transaction so the batch is all-or-nothing.
   */
  async bulkSetTenantFeatureState(
    tenantId: string,
    featureKeys: string[],
    state: FeatureAdminState,
    reason: string | undefined,
    actor: CatalogActor,
  ): Promise<{ updated: number }> {
    await this.assertTenant(tenantId);
    const keys = [...new Set(featureKeys)].map((k) => this.toFeatureKey(k));
    for (const key of keys) {
      this.assertSuspendable(key, state === 'suspended', reason);
    }

    const before = await this.flags.find({
      where: { tenant: { id: tenantId } },
    });
    const byKey = new Map(before.map((f) => [f.feature_key, f]));

    await this.dataSource.transaction(async (manager) => {
      for (const key of keys) {
        await this.applyState(
          tenantId,
          key,
          state,
          reason,
          actor,
          byKey.get(key) ?? null,
          manager,
        );
      }
      await manager.getRepository(AuditLog).save(
        manager.getRepository(AuditLog).create({
          user: actor.id ? ({ id: actor.id } as User) : undefined,
          action: 'FEATURE_FLAG_STATE_BULK',
          entity_type: 'feature_flag',
          entity_id: tenantId,
          old_values: {
            states: keys.map((k) => ({
              featureKey: k,
              state: this.adminStateOf(byKey.get(k) ?? null),
            })),
          },
          new_values: {
            state,
            featureKeys: keys,
            reason: state === 'suspended' ? (reason?.trim() ?? null) : null,
          },
          ip_address: actor.ip,
        }),
      );
    });

    this.cache.invalidate(tenantId);
    return { updated: keys.length };
  }

  async bulkSetTenantFeatures(
    tenantId: string,
    dto: BulkSetTenantFeaturesDto,
    actor: CatalogActor,
  ): Promise<{ updated: number }> {
    await this.assertTenant(tenantId);
    // Validate the WHOLE batch before writing any of it — a partial apply
    // would leave the tenant in a state neither the operator nor the audit
    // record describes.
    const updates = dto.updates.map((u) => ({
      featureKey: this.toFeatureKey(u.featureKey),
      enabled: u.enabled,
    }));

    const before = await this.featureFlags.getStates(tenantId);
    for (const u of updates) {
      await this.featureFlags.set(tenantId, u.featureKey, u.enabled, {
        source: FeatureFlagSource.PLATFORM_ADMIN,
        actorId: actor.id,
      });
    }
    await this.audit(
      'FEATURE_FLAG_BULK',
      actor,
      tenantId,
      { count: updates.length, updates },
      {
        updates: updates.map((u) => ({
          featureKey: u.featureKey,
          enabled: before.get(u.featureKey)?.granted ?? false,
        })),
      },
    );
    return { updated: updates.length };
  }

  // ── Registry sync (idempotent, every boot) ───────────────────────────────

  /**
   * Reconciles `feature_definitions` + `feature_dependencies` with
   * {@link FEATURE_REGISTRY}.
   *
   * This replaces the old `seedDefaults`, which only ran when the table was
   * EMPTY. That "seed once" behaviour is why the catalog silently fell behind
   * the code: `@RequireFeature` gained routes for capabilities no row ever
   * described, so a super-admin had no toggle for them, and `FeatureGuard` —
   * which looks a feature up by key — refused every request for a key with no
   * definition. Syncing on every boot means adding a capability to the registry
   * is the ONLY step required for it to appear in `/platform/feature-flags`.
   *
   * What the code owns vs what the operator owns: a NEW row is written entirely
   * from the registry, but on an EXISTING row only the descriptive fields are
   * refreshed. `default_enabled`, `is_active` and `visibility` are left as the
   * operator set them — clobbering those on every restart would silently undo
   * deliberate platform configuration.
   */
  async syncRegistry(): Promise<{ created: number; updated: number }> {
    let created = 0;
    let updated = 0;

    for (const key of FEATURE_KEYS) {
      const spec = FEATURE_REGISTRY[key];
      const existing = await this.definitions.findOne({
        where: { feature_key: key },
      });

      if (!existing) {
        await this.definitions.save(
          this.definitions.create({
            feature_key: key,
            name: spec.name,
            description: spec.description,
            category: spec.category,
            default_enabled: spec.defaultEnabled,
            is_active: true,
            visibility: spec.visibility ?? 'public',
            is_deprecated: spec.isDeprecated ?? false,
            usage_metric: spec.usageMetric,
          }),
        );
        created++;
        continue;
      }

      existing.name = spec.name;
      existing.description = spec.description;
      existing.category = spec.category;
      existing.is_deprecated = spec.isDeprecated ?? false;
      existing.usage_metric = spec.usageMetric;
      await this.definitions.save(existing);
      updated++;
    }

    await this.syncDependencies();

    this.logger.log(
      `Feature registry synced: ${created} created, ${updated} refreshed, ${FEATURE_KEYS.length} total`,
    );
    return { created, updated };
  }

  /**
   * Mirrors each spec's `dependsOn` into `feature_dependencies`, so the
   * resolver's `missingDependencies` view and the policy's override closure
   * are computed from the same edges rather than two lists that can disagree.
   * Only registry keys are touched — edges a super-admin added for a key that
   * is not in the registry are left alone.
   */
  private async syncDependencies(): Promise<void> {
    for (const key of FEATURE_KEYS) {
      const wanted = [...FEATURE_REGISTRY[key].dependsOn];
      const current = await this.dependencies.find({
        where: { feature_key: key },
      });
      const currentKeys = current.map((d) => d.requires_key).sort();
      if (JSON.stringify(currentKeys) === JSON.stringify([...wanted].sort())) {
        continue; // already correct — no write
      }
      await this.dependencies.delete({ feature_key: key });
      if (wanted.length) {
        await this.dependencies.save(
          wanted.map((r) =>
            this.dependencies.create({ feature_key: key, requires_key: r }),
          ),
        );
      }
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async assertTenant(tenantId: string): Promise<void> {
    const exists = await this.tenants.exists({ where: { id: tenantId } });
    if (!exists) throw new AppError(ErrorCode.TENANT_NOT_FOUND);
  }

  /**
   * The two rules a suspension must satisfy, shared by both endpoints that can
   * set one so they cannot drift apart.
   *
   * Always-on capabilities are refused rather than silently ignored: the policy
   * admits them unconditionally, so accepting a suspension there would hand the
   * operator a control that does nothing. A reason is required to suspend, and
   * never to lift — an operator restoring service should not have to explain
   * themselves first.
   */
  private assertSuspendable(
    key: FeatureKey,
    suspending: boolean,
    reason: string | undefined,
  ): void {
    if (FEATURE_REGISTRY[key].alwaysOn) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message:
          `"${key}" is an always-on capability and cannot be suspended — a tenant blocked from ` +
          'everything must still be able to reach billing and support. Suspend the specific ' +
          'capability you mean to block instead.',
        publicContext: { featureKey: key },
      });
    }
    if (suspending && !reason?.trim()) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'A reason is required when suspending a capability',
        publicContext: { featureKey: key },
      });
    }
  }

  /**
   * The administrative state a stored row represents — the same derivation
   * `FeatureResolverService` reports to the console, so the audit record and
   * the screen the operator was looking at agree.
   *
   * A row from a non-authoritative source (the tenant's own `/feature-flags`)
   * is `inherit`: it is recorded, but it grants nothing.
   */
  private adminStateOf(flag: FeatureFlag | null): FeatureAdminState {
    if (!flag) return 'inherit';
    if (flag.is_suspended) return 'suspended';
    const authoritative = AUTHORITATIVE_FLAG_SOURCES.includes(flag.source);
    return authoritative && flag.is_enabled ? 'granted' : 'inherit';
  }

  /**
   * The state transition itself, inside a caller's transaction.
   *
   * Suspension is cleared only when one is actually set — a needless write
   * would stamp `updated_by` and churn `updated_at` on a row nothing changed
   * about, which makes the row-level audit trail lie about when it last moved.
   */
  private async applyState(
    tenantId: string,
    key: FeatureKey,
    state: FeatureAdminState,
    reason: string | undefined,
    actor: CatalogActor,
    before: FeatureFlag | null,
    manager: EntityManager,
  ): Promise<FeatureFlag> {
    if (state === 'suspended') {
      return this.featureFlags.setSuspension(tenantId, key, true, {
        actorId: actor.id,
        reason: reason?.trim(),
        manager,
      });
    }

    if (before?.is_suspended) {
      await this.featureFlags.setSuspension(tenantId, key, false, {
        actorId: actor.id,
        manager,
      });
    }
    // `granted` writes the authoritative override the policy acts on;
    // `inherit` writes `is_enabled: false`, which means "not granted" and
    // hands the decision back to the subscription — it is NOT a denial.
    return this.featureFlags.set(tenantId, key, state === 'granted', {
      source: FeatureFlagSource.PLATFORM_ADMIN,
      actorId: actor.id,
      manager,
    });
  }

  /**
   * Refuses a key that is not a real platform capability.
   *
   * Without this, `PUT …/tenants/:id/features` accepted ANY string matching
   * `/^[a-z0-9._-]+$/` and wrote a row for it. A typo produced a flag that
   * looked enabled in the UI and granted nothing, which is precisely how
   * "the override is on but the feature still 403s" happens.
   */
  private toFeatureKey(featureKey: string): FeatureKey {
    if (isFeatureKey(featureKey)) return featureKey;
    throw new AppError(ErrorCode.BAD_REQUEST, {
      message: `Unknown feature "${featureKey}". Known features: ${FEATURE_KEYS.join(', ')}`,
      publicContext: { featureKey },
    });
  }

  private async assertDefinition(featureKey: string): Promise<void> {
    const exists = await this.definitions.exists({
      where: { feature_key: featureKey },
    });
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
    oldValues?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditLogs.save(
        this.auditLogs.create({
          user: actor.id ? ({ id: actor.id } as User) : undefined,
          action,
          entity_type: 'feature_flag',
          entity_id: entityId,
          // Recording the PREVIOUS value too: an entitlement audit that only
          // says what a flag became cannot answer "what did this change?",
          // which is the question every access-control incident starts with.
          old_values: oldValues,
          new_values: newValues,
          ip_address: actor.ip,
        }),
      );
    } catch (err) {
      this.logger.warn(
        `Feature audit write failed (${action}): ${(err as Error)?.message}`,
      );
    }
  }
}
