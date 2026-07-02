import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Feature catalog — the GLOBAL definition of a feature (name, description,
 * category, default value). Complements the per-tenant `feature_flags` override
 * table: a tenant's effective status is its override if present, else this
 * definition's `default_enabled`. Features live in the DB (not hardcoded), so
 * new features are added by inserting rows — the catalog is unbounded.
 */
@Entity('feature_definitions')
export class FeatureDefinition {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column()
  feature_key!: string;

  @Column()
  name!: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  /** Grouping bucket for the admin UI (e.g. Core, Communication, Growth, AI). */
  @Column({ default: 'General' })
  category!: string;

  /** Effective value for a tenant that has no explicit override. */
  @Column({ default: false })
  default_enabled!: boolean;

  /** Soft-hide a feature from management without deleting overrides. */
  @Column({ default: true })
  is_active!: boolean;

  /** `public` (tenant-visible) or `internal` (platform-only). */
  @Column({ default: 'public' })
  visibility!: string;

  @Column({ default: false })
  is_beta!: boolean;

  @Column({ default: false })
  is_deprecated!: boolean;

  /**
   * Optional link to a metered usage quota (AI_TOKENS | WHATSAPP_MESSAGES |
   * APPOINTMENTS | CAMPAIGNS). The LIMIT is read from the subscription plan and
   * the USED value from SubscriptionUsage — never duplicated here.
   */
  @Column({ nullable: true })
  usage_metric?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
