import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Unique,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Tenant } from './Tenant';

/**
 * Who wrote a feature-flag row — and therefore whether it may grant access.
 *
 * The row is written from two very different places: a super-admin acting on
 * `/platform/feature-flags`, and a tenant acting on its own `/feature-flags`.
 * Before this column existed the access resolver could not tell them apart, so
 * a clinic that obtained `featureflag.manage` (delegable into a tenant custom
 * role by any Owner holding `roles.manage`) could write its own grant and
 * bypass the paid plan entirely.
 */
export enum FeatureFlagSource {
  /** Super-admin via `/platform/feature-flags`. Grants access. */
  PLATFORM_ADMIN = 'PLATFORM_ADMIN',
  /** Applied by the billing-upgrade flow after a successful payment. Grants access. */
  BILLING_UPGRADE = 'BILLING_UPGRADE',
  /** Written by the tenant itself. A UI preference — grants NOTHING. */
  TENANT = 'TENANT',
}

/** The sources whose rows the access policy is allowed to act on. */
export const AUTHORITATIVE_FLAG_SOURCES: readonly FeatureFlagSource[] = [
  FeatureFlagSource.PLATFORM_ADMIN,
  FeatureFlagSource.BILLING_UPGRADE,
];

@Entity('feature_flags')
@Unique(['tenant', 'feature_key'])
export class FeatureFlag {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, (t) => t.featureFlags, { onDelete: 'CASCADE' })
  tenant!: Tenant;

  @Column()
  feature_key!: string;

  /**
   * The capability is granted to this tenant. `false` means "no override
   * here" — NOT "denied"; denial is {@link is_suspended}, so clearing a grant
   * can never be confused with an administrative block.
   */
  @Column({ default: false })
  is_enabled!: boolean;

  @Column({ type: 'varchar', length: 24, default: FeatureFlagSource.TENANT })
  source!: FeatureFlagSource;

  /**
   * Explicit administrative denial. Outranks EVERYTHING, including platform
   * FREE mode and a valid paid plan — it exists as an incident kill-switch, so
   * it must not be defeatable by the tenant's billing state.
   */
  @Column({ default: false })
  is_suspended!: boolean;

  @Column({ type: 'text', nullable: true })
  suspended_reason?: string | null;

  @Column({ type: 'uuid', nullable: true })
  suspended_by?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  suspended_at?: Date | null;

  /** Actor of the most recent mutation — the row-level half of the audit trail. */
  @Column({ type: 'uuid', nullable: true })
  updated_by?: string | null;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
