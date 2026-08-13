import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, MoreThan, Or, Repository } from 'typeorm';

import { TenantUsageLimitOverride } from '../../entities/SaaS-Core/TenantUsageLimitOverride';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { User } from '../../entities/Auth&RBAC/User';
import { BillingUpgradeRequest } from '../../entities/BillingUpgrades/BillingUpgradeRequest';
import { UsageMetric } from './usage-metric';

export interface GrantUsageLimitOverrideInput {
  overrideLimit: number;
  sourceRequestId?: string;
  grantedById?: string;
  /** null = permanent. */
  expiresAt?: Date | null;
}

/**
 * Per-tenant usage-limit overrides (`tenant_usage_limit_overrides`) — the
 * `FeatureFlag` equivalent for metered usage limits. Consulted by
 * `UsageService` alongside the plan limit; never a source of truth on its own.
 *
 * Tenant isolation: every query filters `tenant: { id: tenantId }`, sourced
 * from the caller (never trusted from client input).
 */
@Injectable()
export class TenantUsageLimitOverrideService {
  constructor(
    @InjectRepository(TenantUsageLimitOverride)
    private readonly overrides: Repository<TenantUsageLimitOverride>,
  ) {}

  /** The tenant's active, time-valid override for a metric (or null). */
  async getActive(
    tenantId: string,
    metric: UsageMetric | string,
    manager?: EntityManager,
  ): Promise<TenantUsageLimitOverride | null> {
    const repo = manager
      ? manager.getRepository(TenantUsageLimitOverride)
      : this.overrides;
    const rows = await repo.find({
      where: {
        tenant: { id: tenantId },
        metric,
        is_active: true,
        expires_at: Or(IsNull(), MoreThan(new Date())),
      },
      order: { created_at: 'DESC' },
      take: 1,
    });
    return rows[0] ?? null;
  }

  /**
   * Every active, time-valid override for a tenant, as a `metric -> limit` map
   * — used by `UsageService.getUnifiedBreakdown` to avoid one query per metric.
   */
  async getActiveMap(tenantId: string): Promise<Map<string, number>> {
    const rows = await this.overrides.find({
      where: {
        tenant: { id: tenantId },
        is_active: true,
        expires_at: Or(IsNull(), MoreThan(new Date())),
      },
    });
    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.metric, Number(row.override_limit));
    }
    return map;
  }

  /**
   * Grant a fresh limit raise, or extend the tenant's existing active override
   * for the same metric. Never LOWERS the limit or SHORTENS the expiry of an
   * existing grant — a new approval only ever raises the ceiling.
   */
  async grantOrExtend(
    tenantId: string,
    metric: UsageMetric | string,
    input: GrantUsageLimitOverrideInput,
    manager?: EntityManager,
  ): Promise<TenantUsageLimitOverride> {
    const repo = manager
      ? manager.getRepository(TenantUsageLimitOverride)
      : this.overrides;
    const existing = await this.getActive(tenantId, metric, manager);
    if (existing) {
      existing.override_limit = String(
        Math.max(Number(existing.override_limit), input.overrideLimit),
      );
      existing.expires_at = this.laterOf(existing.expires_at, input.expiresAt);
      if (input.sourceRequestId) {
        existing.sourceRequest = {
          id: input.sourceRequestId,
        } as BillingUpgradeRequest;
      }
      if (input.grantedById) {
        existing.grantedBy = { id: input.grantedById } as User;
      }
      return repo.save(existing);
    }
    return repo.save(
      repo.create({
        tenant: { id: tenantId } as Tenant,
        metric,
        override_limit: String(input.overrideLimit),
        sourceRequest: input.sourceRequestId
          ? ({ id: input.sourceRequestId } as BillingUpgradeRequest)
          : undefined,
        grantedBy: input.grantedById
          ? ({ id: input.grantedById } as User)
          : undefined,
        expires_at: input.expiresAt ?? undefined,
        is_active: true,
      }),
    );
  }

  /**
   * Permanent (undefined/null) always outranks a finite date — a raise never
   * SHORTENS an existing grant's expiry. Otherwise the later date wins.
   */
  private laterOf(existing?: Date, incoming?: Date | null): Date | undefined {
    if (existing === undefined) return undefined; // already permanent
    if (incoming === null || incoming === undefined) return undefined; // extending to permanent
    return existing > incoming ? existing : incoming;
  }
}
