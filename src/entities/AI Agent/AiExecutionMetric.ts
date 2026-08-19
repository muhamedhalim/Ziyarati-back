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

  /** AI-023 (FR-048, FR-049, FR-087): tool calls refused by the per-round fan-out cap. */
  @Column({ type: 'int', default: 0 })
  tool_calls_truncated!: number;

  /** AI-009 (FR-087, SD-1 point 6): the disclosure check redacted this turn's reply. */
  @Column({ default: false })
  prompt_disclosure_blocked!: boolean;

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

  /** M2 (AI-016): same id as the `ai_tool_calls` rows for the same turn (FR-030). */
  @Index()
  @Column({ type: 'varchar', nullable: true })
  correlation_id?: string | null;

  /** M2 (AI-017): acting staff principal; null for guests, never omitted (FR-034). */
  @Column({ type: 'uuid', nullable: true })
  actor_user_id?: string | null;

  /**
   * AI-013 (FR-065–FR-067, R9): which retrieval path produced this turn's
   * RAG context — `'vector'` on a successful vector search, `'keyword'` on
   * pure keyword search OR when vector was attempted and fell back after an
   * error, `null` for a turn that never called RAG. Distinct from
   * `fallback` above, which reports PROVIDER fallback, not retrieval-path
   * fallback — see evidence/metric-field-assessment.md (T130).
   */
  @Column({ type: 'varchar', length: 20, nullable: true })
  retrieval_mode?: 'vector' | 'keyword' | null;

  /**
   * How this turn was processed, as ONE composed label —
   * `STANDARD` | `BATCH` | `STANDARD+RESIDENCY` | `BATCH+RESIDENCY` — so a
   * single column answers "how was this processed" without a join, while the
   * two source dimensions below stay separately queryable.
   *
   * Nullable only for rows written before this column existed; every new row
   * carries a value (the resolver always returns one).
   */
  @Index()
  @Column({ type: 'varchar', length: 40, nullable: true })
  processing_mode?: string | null;

  /** Whether regional processing was REQUIRED for this turn (not merely available). */
  @Column({ type: 'boolean', nullable: true })
  data_residency_required?: boolean | null;

  /**
   * The region this turn was processed in. Null for every non-residency
   * request — Standard and Batch requests have no region — so this being null
   * is a value, not a gap. Descriptive metadata only; see TenantAiDeployment.
   */
  @Column({ type: 'varchar', length: 40, nullable: true })
  data_residency_region?: string | null;

  /** Why the processing mode was chosen. Configuration facts only, never prompt content. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  data_residency_reason?: string | null;
}
