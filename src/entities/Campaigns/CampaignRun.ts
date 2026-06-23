import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { Campaign } from './Campaign';
import { CampaignExecution } from '../enums';

/**
 * Execution aggregate — ONE attempt to send a campaign to its audience.
 *
 * A campaign can have many runs over time (initial send, retry-failed re-runs).
 * All runtime tracking that used to be (wrongly) inferred from the campaign now
 * lives here: the system execution state, the fixed audience size, and the
 * materialized per-outcome counters that make analytics O(1) and completion a
 * cheap arithmetic check.
 *
 * Tenant column is duplicated here (defense-in-depth) so worker queries can
 * scope by tenant without a join back through the campaign.
 */
@Entity('campaign_runs')
@Index(['tenant', 'campaign', 'created_at'])
@Index(['execution'])
export class CampaignRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Campaign, { onDelete: 'CASCADE' })
  campaign!: Campaign;

  @Column({
    type: 'enum',
    enum: CampaignExecution,
    default: CampaignExecution.IDLE,
  })
  execution!: CampaignExecution;

  /** Audience size resolved at launch — the fixed denominator for rates. */
  @Column('int', { default: 0 })
  total_recipients!: number;

  // ── Materialized counters (updated atomically per recipient transition) ──
  @Column('int', { default: 0 }) queued!: number;
  @Column('int', { default: 0 }) sent!: number;
  @Column('int', { default: 0 }) delivered!: number;
  @Column('int', { default: 0 }) read!: number;
  @Column('int', { default: 0 }) failed!: number;
  @Column('int', { default: 0 }) skipped!: number;

  /** De-dup key for the launch → outbox → fan-out chain (idempotent re-runs). */
  @Column('uuid')
  idempotency_key!: string;

  /** Optimistic-concurrency guard for counter/state updates. */
  @VersionColumn()
  version!: number;

  @Column({ type: 'timestamptz', nullable: true })
  started_at?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  finished_at?: Date;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at?: Date;
}
