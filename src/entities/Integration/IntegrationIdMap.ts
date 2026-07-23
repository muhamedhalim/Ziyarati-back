import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { IntegrationConnection } from './IntegrationConnection';

/**
 * Correlates an external system's own id for a record with our internal id
 * (Phase 3 — two-way integrations). This is a SEPARATE table on purpose: we
 * never add provider-specific columns to `customers`/`staff`/`services`/
 * `appointments`, so the same internal record can be mapped independently by
 * several connections.
 *
 * Two DB-level unique constraints (created in the migration) guarantee a clean
 * 1:1 correspondence WITHIN one connection:
 *   - (tenant, connection, resource_type, external_id)     — one internal per external
 *   - (tenant, connection, resource_type, internal_resource_id) — one external per internal
 * Both are tenant-scoped, so a cross-tenant mapping is structurally impossible.
 */
@Entity('integration_id_map')
@Index('IX_integration_id_map_lookup', ['tenant', 'connection', 'resource_type'])
export class IntegrationIdMap {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, { nullable: false, onDelete: 'CASCADE' })
  tenant!: Tenant;

  @ManyToOne(() => IntegrationConnection, { nullable: false, onDelete: 'CASCADE' })
  connection!: IntegrationConnection;

  /** customer | staff | service | appointment */
  @Column({ type: 'varchar', length: 20 })
  resource_type!: string;

  /** The external system's own identifier for the record. */
  @Column({ type: 'varchar', length: 255 })
  external_id!: string;

  /** Our internal record id. Not a typed relation — resource_type selects the table. */
  @Column({ type: 'uuid' })
  internal_resource_id!: string;

  /** Which side created/owns the record: `external` (imported) or `platform`. */
  @Column({ type: 'varchar', length: 20, default: 'external' })
  source!: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
