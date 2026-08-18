import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  Index,
  CreateDateColumn,
} from 'typeorm';

import { ResourcePriceCatalog } from './ResourcePriceCatalog';
import { User } from '../Auth&RBAC/User';

/**
 * Append-only price-change audit trail (Pricing Catalog plan, Phase 2.1).
 * One row per changed FIELD per admin write to `resource_price_catalog` —
 * mirrors `PlatformAdminAuditService`'s before/after pattern but scoped
 * narrowly to this one table, so the platform Pricing tab's "Price history"
 * view (plan §19) can render a clean per-item timeline without filtering a
 * global audit log.
 */
@Entity('resource_price_change_events')
export class ResourcePriceChangeEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @ManyToOne(() => ResourcePriceCatalog, { nullable: false, onDelete: 'CASCADE' })
  catalogItem!: ResourcePriceCatalog;

  @Column({ length: 64 })
  item_key!: string;

  @Column({ length: 32 })
  field!: string;

  @Column({ type: 'text', nullable: true })
  from_value?: string;

  @Column({ type: 'text', nullable: true })
  to_value?: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  actor?: User;

  @Column({ length: 255, nullable: true })
  actor_email?: string;

  @Index()
  @CreateDateColumn()
  created_at!: Date;
}
