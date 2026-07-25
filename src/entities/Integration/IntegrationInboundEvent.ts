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
import { IntegrationWebhookEndpoint } from './IntegrationWebhookEndpoint';

/**
 * One received inbound webhook delivery (Phase 4) — the replay guard, the work
 * item, and the delivery/rejection history, in one durable row.
 *
 * REPLAY / IDEMPOTENCY: a UNIQUE index on (tenant, endpoint, provider_event_id)
 * (see the migration) means the SECOND delivery of an event id cannot insert.
 * That is the guarantee — not a service-level "have I seen this?" check that two
 * concurrent deliveries could both pass. A duplicate is acked 200 (the provider
 * did nothing wrong) and recorded as `duplicate`.
 *
 * DURABILITY: the row is written BEFORE the queue job is enqueued, so an
 * accepted delivery can never be acknowledged and then vanish — if the enqueue
 * fails, the row still exists in `accepted` and the recovery sweep re-enqueues
 * it.
 *
 * WHAT IS STORED: `payload` holds ONLY the sanitized, allowlisted writable
 * fields plus the compiled read-only hints — protected/unknown fields are
 * stripped or rejected at the door, so credentials, payment fields and internal
 * ids are never persisted here. It is TRANSIENT staging: it is CLEARED the
 * moment the event reaches a terminal state, so the retained history contains
 * only safe metadata (ids, event type, status, a reason CODE, counters) and
 * never clinical free text such as appointment notes. `payload` is never
 * exposed by any read API.
 */
@Entity('integration_inbound_events')
@Index('IX_integration_inbound_events_lookup', ['tenant', 'endpoint', 'status'])
export class IntegrationInboundEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, { nullable: false, onDelete: 'CASCADE' })
  tenant!: Tenant;

  /** SET NULL so delivery history survives endpoint removal. */
  @ManyToOne(() => IntegrationWebhookEndpoint, { nullable: true, onDelete: 'SET NULL' })
  endpoint?: IntegrationWebhookEndpoint | null;

  /** SET NULL so delivery history survives connection removal. */
  @ManyToOne(() => IntegrationConnection, { nullable: true, onDelete: 'SET NULL' })
  connection?: IntegrationConnection | null;

  /**
   * The provider's own id for this event — the replay key. Required: an event
   * without one is rejected, because it could not be deduplicated.
   */
  @Column({ type: 'varchar', length: 255 })
  provider_event_id!: string;

  /** Event type from the compiled INBOUND_EVENTS allowlist. */
  @Column({ type: 'varchar', length: 60 })
  event_type!: string;

  /** customer | staff | service | appointment (derived from the event type). */
  @Column({ type: 'varchar', length: 20, nullable: true })
  resource_type?: string | null;

  /** The external system's id for the affected record. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  external_id?: string | null;

  /** accepted | processing | processed | conflicted | failed | rejected | duplicate */
  @Column({ type: 'varchar', length: 20, default: 'accepted' })
  status!: string;

  /** Safe machine-readable code (see INBOUND_REJECTION) — never caller text. */
  @Column({ type: 'varchar', length: 40, nullable: true })
  rejection_reason?: string | null;

  /**
   * Sanitized, allowlisted staging payload. Cleared on reaching a terminal
   * state; never returned by any read API. See the class docstring.
   */
  @Column({ type: 'jsonb', nullable: true })
  payload?: Record<string, unknown> | null;

  /** Signature timestamp the caller presented (seconds), for replay diagnostics. */
  @Column({ type: 'bigint', nullable: true })
  signature_timestamp?: string | null;

  /** Outcome of the shared write pipeline (created|updated|linked|skipped|…). */
  @Column({ type: 'varchar', length: 20, nullable: true })
  upsert_outcome?: string | null;

  /** Internal record the event resolved to, when it resolved to one. */
  @Column({ type: 'uuid', nullable: true })
  internal_resource_id?: string | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  /** Safe, truncated processing error — never the payload or a secret. */
  @Column({ type: 'text', nullable: true })
  error_summary?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  processed_at?: Date | null;

  @CreateDateColumn()
  received_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
