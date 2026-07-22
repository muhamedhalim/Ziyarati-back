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
 * A SINGLE row per delivery — updated in place across retries (attempt_count,
 * last_http_status, status) rather than one row per HTTP attempt, so "retry
 * count" and "delivery status" stay simple aggregate reads. `payload` is the
 * exact small, allowlisted JSON body sent (ids + scalars only — see
 * webhook.constants.ts's WEBHOOK_EVENT payload policy), safe to persist.
 * `response_preview` is truncated and never stores the tenant's own secret or
 * request headers.
 */
@Entity('webhook_deliveries')
@Index(['tenant', 'created_at'])
@Index(['webhook_endpoint', 'created_at'])
export class WebhookDelivery {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, { nullable: false, onDelete: 'CASCADE' })
  tenant!: Tenant;

  @ManyToOne(() => WebhookEndpoint, { nullable: false, onDelete: 'CASCADE' })
  webhook_endpoint!: WebhookEndpoint;

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
