import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { FeatureFlag } from '../../entities/SaaS-Core/FeatureFlag';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

/**
 * Per-tenant feature flags (the `feature_flags` table is tenant-scoped with a
 * unique (tenant, feature_key)). Controls runtime access to modules such as
 * appointments, AI, WhatsApp, etc.
 *
 * Tenant isolation: every query filters `tenant: { id: tenantId }`; the tenant
 * always comes from the authenticated principal.
 */
@Injectable()
export class FeatureFlagService {
  constructor(
    @InjectRepository(FeatureFlag)
    private readonly flags: Repository<FeatureFlag>,
  ) {}

  /** All feature flags configured for the tenant. */
  list(tenantId: string): Promise<FeatureFlag[]> {
    return this.flags.find({
      where: { tenant: { id: tenantId } },
      order: { feature_key: 'ASC' },
    });
  }

  /** Upsert a (tenant, feature_key) flag. */
  async set(
    tenantId: string,
    featureKey: string,
    isEnabled: boolean,
  ): Promise<FeatureFlag> {
    let flag = await this.flags.findOne({
      where: { tenant: { id: tenantId }, feature_key: featureKey },
    });
    if (flag) {
      flag.is_enabled = isEnabled;
    } else {
      flag = this.flags.create({
        tenant: { id: tenantId } as Tenant,
        feature_key: featureKey,
        is_enabled: isEnabled,
      });
    }
    return this.flags.save(flag);
  }

  /** Returns whether a feature is enabled for the tenant (default: false). */
  async isEnabled(tenantId: string, featureKey: string): Promise<boolean> {
    const flag = await this.flags.findOne({
      where: { tenant: { id: tenantId }, feature_key: featureKey },
    });
    return flag?.is_enabled ?? false;
  }

  /** Service-level guard: throws 403 if the feature is not enabled. */
  async assertEnabled(tenantId: string, featureKey: string): Promise<void> {
    if (!(await this.isEnabled(tenantId, featureKey))) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: `The "${featureKey}" feature is not enabled for your subscription`,
        publicContext: { featureKey },
      });
    }
  }
}
