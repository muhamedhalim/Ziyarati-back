import {
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  Column,
  Index,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';

/**
 * One row per completed AI turn (`sendMessage` / `streamMessage`) — the
 * persistence layer for Advanced AI Monitoring. Written best-effort AFTER the
 * turn completes (never inside the turn's own transaction, never able to fail
 * the turn). Both the tenant-scoped `AiMetricsService` and the cross-tenant
 * `AiMonitoringService` (platform) read this table — no duplicate capture.
 */
@Entity('ai_execution_metrics')
export class AiExecutionMetric {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  ai_conversation_id?: string;

  @Index()
  @Column({ length: 20 })
  channel!: string;

  @Index()
  @Column({ length: 60 })
  model!: string;

  @Index()
  @Column({ length: 80, default: 'chat' })
  feature!: string;

  @Column({ length: 160, default: 'ai.chat' })
  route!: string;

  @Column({ length: 120, nullable: true })
  idempotency_key?: string;

  @Column({ default: false })
  streamed!: boolean;

  @Column({ default: false })
  fallback!: boolean;

  @Column({ default: true })
  success!: boolean;

  @Column({ type: 'text', nullable: true })
  error_message?: string;

  @Column({ type: 'int', default: 0 })
  prompt_tokens!: number;

  @Column({ type: 'int', default: 0 })
  completion_tokens!: number;

  @Column({ type: 'int', default: 0 })
  cached_input_tokens!: number;

  @Column({ type: 'int', default: 0 })
  embedding_tokens!: number;

  @Column({ type: 'int', default: 0 })
  total_tokens!: number;

  @Column({ type: 'decimal', precision: 12, scale: 6, nullable: true })
  cost_usd!: number | null;

  @Column({ type: 'bigint', nullable: true })
  cost_microusd?: string;

  @Column({ length: 20, default: 'UNPRICED' })
  pricing_status!: string;

  @Column({ type: 'int', default: 0 })
  tool_loop_count!: number;

  @Column({ type: 'int', default: 1 })
  provider_attempts!: number;

  @Column({ type: 'int', default: 0 })
  provider_retry_count!: number;

  @Column({ type: 'int', default: 0 })
  cached_request_count!: number;

  @Column({ type: 'int', default: 0 })
  truncated_prompt_tokens!: number;

  @Column({ type: 'int', nullable: true })
  rag_retrieval_ms?: number;

  @Column({ type: 'int', nullable: true })
  embedding_ms?: number;

  @Column({ type: 'int', default: 0 })
  tool_calls_count!: number;

  @Column({ type: 'int', default: 0 })
  tool_success_count!: number;

  @Column({ type: 'int', default: 0 })
  tool_failure_count!: number;

  @Column({ type: 'int', default: 0 })
  tool_exec_ms!: number;

  /** Time from turn start to the first streamed token (streaming turns only). */
  @Column({ type: 'int', nullable: true })
  first_token_ms?: number;

  /** Wall-clock time spent iterating the stream (streaming turns only). */
  @Column({ type: 'int', nullable: true })
  streaming_duration_ms?: number;

  @Column({ type: 'int' })
  total_latency_ms!: number;

  @CreateDateColumn()
  created_at!: Date;
}
