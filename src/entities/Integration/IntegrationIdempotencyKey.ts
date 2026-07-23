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
 * Retry-safe write dedupe (Phase 3 — two-way integrations). An external system
 * that retries a write presents the same `Idempotency-Key`; we return the stored
 * outcome instead of applying the change twice.
 *
 * `request_hash` is a SHA-256 of the normalised request body. If a key is reused
 * with a DIFFERENT payload, that is a client bug (or an attack) and the write is
 * rejected (422) rather than silently returning the wrong stored response.
 *
 * Unique on (tenant, idempotency_key): the key is unique per tenant. The row is
 * expiry-bounded so the table cannot grow unbounded.
 */
@Entity('integration_idempotency_keys')
@Index('UQ_integration_idempotency_key', ['tenant', 'idempotency_key'], { unique: true })
export class IntegrationIdempotencyKey {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, { nullable: false, onDelete: 'CASCADE' })
  tenant!: Tenant;

  @ManyToOne(() => IntegrationConnection, { nullable: true, onDelete: 'CASCADE' })
  connection?: IntegrationConnection | null;

  @Column({ type: 'varchar', length: 255 })
  idempotency_key!: string;

  /** Logical operation (e.g. `customers.upsert`) — for diagnostics/audit only. */
  @Column({ type: 'varchar', length: 120 })
  endpoint!: string;

  @Column({ type: 'varchar', length: 64 })
  request_hash!: string;

  /** in_progress | completed */
  @Column({ type: 'varchar', length: 20, default: 'in_progress' })
  status!: string;

  @Column({ type: 'int', nullable: true })
  response_status?: number | null;

  /** Client-safe stored response (ids + outcome only — never full records/secrets). */
  @Column({ type: 'jsonb', nullable: true })
  response_body?: Record<string, any> | null;

  @Column({ type: 'timestamptz' })
  expires_at!: Date;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
