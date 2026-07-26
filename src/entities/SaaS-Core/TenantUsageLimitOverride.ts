import {
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Tenant } from './Tenant';
import { User } from '../Auth&RBAC/User';
import { BillingUpgradeRequest } from '../BillingUpgrades/BillingUpgradeRequest';

/**
 * Per-tenant, per-metric override that RAISES a `SubscriptionPlan` usage limit
 * for one tenant without touching the shared plan row (mirrors `FeatureFlag`,
 * which is the equivalent override for boolean features). Consulted by
 * `UsageService` alongside the plan limit — the effective limit is
 * `max(planLimit, activeOverride.override_limit)`, so a tenant is never worse
 * off than its plan and a null plan limit (already unlimited) is unaffected.
 *
 * `metric` is a `USAGE_METRIC` key (see usage-metric.ts) — scope intentionally
 * limited to metered metrics for now (see billing-upgrade.constants.ts).
 *
 * At most one ACTIVE override per (tenant, metric) — enforced by a partial
 * unique index (see migration). Granting a second raise for the same metric
 * extends/replaces the existing row (TenantUsageLimitOverrideService), it
 * never inserts a duplicate.
 */
@Entity('tenant_usage_limit_overrides')
export class TenantUsageLimitOverride {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @ManyToOne(() => Tenant, { nullable: false, onDelete: 'CASCADE' })
  tenant!: Tenant;

  @Column({ length: 32 })
  metric!: string;

  @Column({ type: 'bigint' })
  override_limit!: string;

  @ManyToOne(() => BillingUpgradeRequest, { nullable: true, onDelete: 'SET NULL' })
  sourceRequest?: BillingUpgradeRequest;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  grantedBy?: User;

  /** null = permanent. */
  @Column({ type: 'timestamptz', nullable: true })
  expires_at?: Date;

  @Column({ default: true })
  is_active!: boolean;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
