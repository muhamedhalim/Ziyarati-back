import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';

import {
  AUTHORITATIVE_FLAG_SOURCES,
  FeatureFlag,
  FeatureFlagSource,
} from '../../entities/SaaS-Core/FeatureFlag';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { FeatureKey } from './feature-registry';
import { AccessCacheService } from './access-cache.service';

/** The administrative state of one capability for one tenant. */
export interface FlagState {
  /** An authoritative grant exists (super-admin or paid upgrade). */
  granted: boolean;
  /** Explicit administrative denial — outranks everything. */
  suspended: boolean;
  source: FeatureFlagSource;
}

export interface SetFlagOptions {
  /**
   * WHO is writing. Required, and not defaulted, because the whole point of
   * the column is that a caller cannot accidentally write a row that grants
   * access — an omitted source used to be indistinguishable from a
   * super-admin grant.
   */
  source: FeatureFlagSource;
  actorId?: string;
  manager?: EntityManager;
}

/**
 * Per-tenant feature flags (`feature_flags`, unique on (tenant, feature_key)).
 *
 * This is a STORE, not a policy. It answers "what did an administrator record
 * for this tenant?"; whether that produces access is
 * `AccessControlService`'s decision alone.
 *
 * Tenant isolation: every query filters `tenant: { id: tenantId }`, and the
 * tenant id always comes from the authenticated principal or a super-admin
 * route param — never from a request body.
 */
@Injectable()
export class FeatureFlagService {
  constructor(
    @InjectRepository(FeatureFlag)
    private readonly flags: Repository<FeatureFlag>,
    private readonly cache: AccessCacheService,
  ) {}

  /** All feature flags configured for the tenant (every source). */
  list(tenantId: string): Promise<FeatureFlag[]> {
    return this.flags.find({
      where: { tenant: { id: tenantId } },
      order: { feature_key: 'ASC' },
    });
  }

  /**
   * Upsert a (tenant, feature_key) flag.
   *
   * `manager` lets the write commit atomically with a caller's own transaction
   * (e.g. `BillingUpgradeEntitlementListener` applying a feature grant in the
   * same transaction as the payment's status flip).
   */
  async set(
    tenantId: string,
    featureKey: FeatureKey,
    isEnabled: boolean,
    opts: SetFlagOptions,
  ): Promise<FeatureFlag> {
    const repo = opts.manager
      ? opts.manager.getRepository(FeatureFlag)
      : this.flags;
    let flag = await repo.findOne({
      where: { tenant: { id: tenantId }, feature_key: featureKey },
    });
    if (flag) {
      flag.is_enabled = isEnabled;
      flag.source = opts.source;
      flag.updated_by = opts.actorId ?? null;
    } else {
      flag = repo.create({
        tenant: { id: tenantId } as Tenant,
        feature_key: featureKey,
        is_enabled: isEnabled,
        source: opts.source,
        updated_by: opts.actorId ?? null,
      });
    }
    const saved = await repo.save(flag);
    // A grant that is still cached is a grant that has not taken effect.
    // Invalidated AFTER the write so a concurrent read can only ever repopulate
    // the cache from committed state.
    this.cache.invalidate(tenantId);
    return saved;
  }

  /**
   * Set or clear the administrative suspension of a capability.
   *
   * Kept separate from {@link set} because the two say different things: a
   * cleared grant means "this tenant was never given this", while a suspension
   * means "this tenant is deliberately blocked from this", and only the latter
   * may override a paid plan. Collapsing them — which is what the original
   * `is_enabled = false` did — meant a stray toggle silently de-provisioned a
   * paying clinic.
   */
  async setSuspension(
    tenantId: string,
    featureKey: FeatureKey,
    suspended: boolean,
    opts: { actorId?: string; reason?: string; manager?: EntityManager },
  ): Promise<FeatureFlag> {
    const repo = opts.manager
      ? opts.manager.getRepository(FeatureFlag)
      : this.flags;
    let flag = await repo.findOne({
      where: { tenant: { id: tenantId }, feature_key: featureKey },
    });
    if (!flag) {
      flag = repo.create({
        tenant: { id: tenantId } as Tenant,
        feature_key: featureKey,
        is_enabled: false,
        source: FeatureFlagSource.PLATFORM_ADMIN,
      });
    }
    flag.is_suspended = suspended;
    flag.suspended_reason = suspended ? (opts.reason ?? null) : null;
    flag.suspended_by = suspended ? (opts.actorId ?? null) : null;
    flag.suspended_at = suspended ? new Date() : null;
    flag.updated_by = opts.actorId ?? null;
    const saved = await repo.save(flag);
    // A suspension is the incident kill-switch: it must take effect on every
    // replica now, not when a TTL happens to lapse.
    this.cache.invalidate(tenantId);
    return saved;
  }

  /**
   * The administrative state of every capability for a tenant, in ONE query.
   *
   * `AccessControlService` needs the whole picture per request (the asked-for
   * key plus its dependency closure), and issuing one query per key turned a
   * single gate into an N-query fan-out.
   */
  async getStates(
    tenantId: string,
    manager?: EntityManager,
  ): Promise<Map<string, FlagState>> {
    const repo = manager ? manager.getRepository(FeatureFlag) : this.flags;
    const rows = await repo.find({ where: { tenant: { id: tenantId } } });
    const out = new Map<string, FlagState>();
    for (const row of rows) {
      out.set(row.feature_key, {
        // A tenant-written row is recorded but carries no authority — that is
        // what stops a clinic self-granting paid features.
        granted:
          row.is_enabled && AUTHORITATIVE_FLAG_SOURCES.includes(row.source),
        // A suspension is honoured regardless of who recorded it: only
        // super-admin routes can write one, and honouring it can only ever
        // remove access, never add it.
        suspended: row.is_suspended,
        source: row.source,
      });
    }
    return out;
  }

  /**
   * Whether an AUTHORITATIVE grant exists for this capability. This is the
   * read the access policy uses — never the raw row.
   */
  async isGranted(
    tenantId: string,
    featureKey: FeatureKey,
    manager?: EntityManager,
  ): Promise<boolean> {
    const repo = manager ? manager.getRepository(FeatureFlag) : this.flags;
    const flag = await repo.findOne({
      where: {
        tenant: { id: tenantId },
        feature_key: featureKey,
        source: In([...AUTHORITATIVE_FLAG_SOURCES]),
      },
    });
    return flag?.is_enabled === true && flag.is_suspended === false;
  }

  /**
   * RAW row read, ignoring provenance — for the tenant-facing
   * `GET /feature-flags/check`, which is a UI hint. NOT an authorization
   * check: use {@link isGranted} for anything that gates behaviour.
   */
  async isEnabled(
    tenantId: string,
    featureKey: string,
    manager?: EntityManager,
  ): Promise<boolean> {
    const repo = manager ? manager.getRepository(FeatureFlag) : this.flags;
    const flag = await repo.findOne({
      where: { tenant: { id: tenantId }, feature_key: featureKey },
    });
    return flag?.is_enabled ?? false;
  }

  /** Service-level guard: throws 403 if the feature is not granted. */
  async assertEnabled(tenantId: string, featureKey: FeatureKey): Promise<void> {
    if (!(await this.isGranted(tenantId, featureKey))) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: `The "${featureKey}" feature is not enabled for your subscription`,
        publicContext: { featureKey },
      });
    }
  }
}
