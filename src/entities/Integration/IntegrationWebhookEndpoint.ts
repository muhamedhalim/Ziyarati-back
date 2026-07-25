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
 * The inbound webhook endpoint for ONE connection (Phase 4).
 *
 * An external system pushes changes to `/integrations/inbound/{connectionId}`;
 * this row holds everything needed to decide whether to accept a delivery:
 * the shared signing secret, which signature scheme to verify with, the event
 * ALLOWLIST, and the replay tolerance.
 *
 * `secret_ciphertext` is stored ENCRYPTED (AES-256-GCM) and is NEVER returned to
 * any client — the plaintext is shown exactly once, at creation/rotation, and
 * only `secret_prefix` (a non-reversible display fragment) is readable
 * afterwards. The signature SCHEME is a compiled enum, never tenant-supplied
 * code: a tenant chooses among verification strategies the platform implements.
 *
 * One endpoint per connection (DB unique on `connection`) so a delivery URL
 * unambiguously identifies both the tenant and the connection to verify against.
 */
@Entity('integration_webhook_endpoints')
@Index('IX_integration_webhook_endpoints_tenant', ['tenant'])
export class IntegrationWebhookEndpoint {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, { nullable: false, onDelete: 'CASCADE' })
  tenant!: Tenant;

  /**
   * CASCADE: an endpoint is meaningless without its connection, and the delivery
   * HISTORY lives on `integration_inbound_events` (whose connection FK is SET
   * NULL), so removing an endpoint never destroys the audit trail.
   */
  @ManyToOne(() => IntegrationConnection, { nullable: false, onDelete: 'CASCADE' })
  connection!: IntegrationConnection;

  /** active | inactive — inactive rejects deliveries with a safe reason code. */
  @Column({ type: 'varchar', length: 20, default: 'active' })
  status!: string;

  /** Encrypted shared signing secret. Never serialized to any client. */
  @Column({ type: 'text' })
  secret_ciphertext!: string;

  /** First characters of the plaintext secret — display only, not re-derivable. */
  @Column({ type: 'varchar', length: 16 })
  secret_prefix!: string;

  @Column({ type: 'timestamptz', nullable: true })
  secret_rotated_at?: Date | null;

  /** Compiled scheme key (see WEBHOOK_SIGNATURE_SCHEME) — never tenant code. */
  @Column({ type: 'varchar', length: 40, default: 'hmac_sha256_timestamped' })
  signature_scheme!: string;

  /**
   * Event types this endpoint accepts. Always a subset of the compiled
   * INBOUND_EVENTS allowlist — anything else is rejected before any processing.
   */
  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  allowed_events!: string[];

  /** Replay window in seconds (bounded by WEBHOOK_MAX_TOLERANCE_SECONDS). */
  @Column({ type: 'int', default: 300 })
  tolerance_seconds!: number;

  @Column({ type: 'int', default: 0 })
  accepted_count!: number;

  @Column({ type: 'int', default: 0 })
  rejected_count!: number;

  @Column({ type: 'timestamptz', nullable: true })
  last_accepted_at?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_rejected_at?: Date | null;

  /** Safe machine-readable code only (see INBOUND_REJECTION) — never caller text. */
  @Column({ type: 'varchar', length: 40, nullable: true })
  last_rejection_reason?: string | null;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
