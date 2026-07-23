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
import { WebhookEndpoint } from './WebhookEndpoint';

/**
 * One logical outbound-webhook delivery (one event instance × one endpoint).
 *
 * A SINGLE row per delivery — updated in place across AUTOMATIC retries
 * (attempt_count, last_http_status, status) rather than one row per HTTP
 * attempt, so "retry count" and "delivery status" stay simple aggregate
 * reads and `X-Webhook-Id` stays STABLE across every automatic retry of one
 * delivery. A MANUAL replay is different: it creates a brand-new row (see
 * `replayed_from_id`) rather than mutating this one, so the original
 * delivery's terminal outcome is never lost/overwritten.
 *
 * `payload` is the exact small, allowlisted JSON body sent (ids + scalars
 * only — see webhook.constants.ts's WEBHOOK_EVENT payload policy), captured
 * ONCE at dispatch time and never rebuilt from live/mutable state on retry or
 * replay. `response_preview` is truncated and never stores the tenant's own
 * secret or request headers.
 *
 * `webhook_endpoint` is nullable with `ON DELETE SET NULL` and
 * `webhook_endpoint_url_snapshot` is an immutable copy of the URL the
 * delivery was actually dispatched to — both exist so that deleting (or, in
 * the FK sense, ever hard-removing) an endpoint can never silently destroy
 * this delivery's history. The normal dashboard "delete" is a SOFT delete
 * (see `WebhookEndpoint.deleted_at`); this FK behavior is a second, DB-level
 * backstop, not the primary mechanism.
 */
@Entity('webhook_deliveries')
@Index(['tenant', 'created_at'])
@Index(['webhook_endpoint', 'created_at'])
export class WebhookDelivery {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, { nullable: false, onDelete: 'CASCADE' })
  tenant!: Tenant;

  @ManyToOne(() => WebhookEndpoint, { nullable: true, onDelete: 'SET NULL' })
  webhook_endpoint?: WebhookEndpoint;

  /** Immutable copy of `webhook_endpoint.url` as of dispatch time — survives endpoint URL edits and endpoint deletion alike. */
  @Column({ type: 'varchar', length: 2048 })
  webhook_endpoint_url_snapshot!: string;

  /** Set only on rows created by a manual replay — points back at the delivery that was replayed. Not a TypeORM relation (display/audit only, no cross-tenant join risk). */
  @Column({ type: 'uuid', nullable: true })
  replayed_from_id?: string;

  @Column({ type: 'varchar', length: 100 })
  event_type!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  /** PENDING | DELIVERING | SUCCEEDED | FAILED | DEAD_LETTERED */
  @Column({ type: 'varchar', length: 20, default: 'PENDING' })
  status!: string;

  @Column({ type: 'int', nullable: true })
  http_status?: number;

  @Column({ type: 'int', default: 0 })
  attempt_count!: number;

  /** Truncated response body preview (first ~500 chars) — never the full body. */
  @Column({ type: 'text', nullable: true })
  response_preview?: string;

  @Column({ type: 'text', nullable: true })
  last_error?: string;

  @Column({ type: 'timestamptz', nullable: true })
  last_attempted_at?: Date;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
