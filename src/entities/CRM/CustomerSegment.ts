import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { User } from '../Auth&RBAC/User';
import type {
  SegmentRule,
  SegmentMatch,
} from '../../modules/crm/segment.constants';

/**
 * Spec 014 (Clinic Platform Completion) — Phase 10 (US8, FR-S001-S012, data-model.md §1.6).
 *
 * A reusable rule-based audience. `rules` is a closed vocabulary (R8),
 * validated on write by `CustomerSegmentService`/`SegmentQueryBuilder` — this
 * entity does not itself constrain the jsonb shape (jsonb columns can't carry
 * a TypeORM-level structural check), it is the persisted result of that
 * validation.
 */
@Entity('customer_segments')
@Index(['tenant', 'name'], { unique: true, where: '"deleted_at" IS NULL' })
export class CustomerSegment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column({ length: 160 })
  name!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description?: string;

  @Column({ type: 'jsonb' })
  rules!: SegmentRule[];

  @Column({ type: 'varchar', length: 3 })
  match!: SegmentMatch;

  @ManyToOne(() => User, { nullable: true })
  created_by?: User;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at?: Date;

  @DeleteDateColumn()
  deleted_at?: Date;
}
