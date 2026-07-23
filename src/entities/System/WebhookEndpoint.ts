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

/**
 * A tenant-registered outbound webhook subscription (Phase 2 — Integration
 * platform). The clinic's own external system receives signed HTTP POSTs
 * whenever one of `events` fires for this tenant.
 *
 * `secret_ciphertext` is stored ENCRYPTED (EncryptionService, AES-256-GCM) —
 * unlike `ApiKey.key_hash`, this must be reversible: the plaintext secret is
 * needed at delivery time to HMAC-sign the outgoing payload. The plaintext
 * itself is only ever returned once, at creation/rotation.
 */
@Entity('webhook_endpoints')
@Index(['tenant'])
export class WebhookEndpoint {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, { nullable: false, onDelete: 'CASCADE' })
  tenant!: Tenant;

  @Column({ type: 'varchar', length: 100, nullable: true })
  name?: string;

  @Column({ type: 'varchar', length: 2048 })
  url!: string;

  @Column({ type: 'text' })
  secret_ciphertext!: string;

  /** First few characters of the plaintext secret — safe to display. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  secret_prefix?: string;

  /** Subscribed event-type strings — validated against WEBHOOK_EVENTS at write time. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  events!: string[];

  @Column({ default: true })
  is_active!: boolean;

  /**
   * Soft-delete marker. "Delete" from the dashboard sets this (+ is_active
   * false) instead of removing the row — deleting an endpoint must not
   * silently destroy its delivery history / audit evidence, which still
   * joins to this row. All tenant-facing reads filter `deleted_at IS NULL`.
   */
  @Column({ type: 'timestamptz', nullable: true })
  deleted_at?: Date;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
