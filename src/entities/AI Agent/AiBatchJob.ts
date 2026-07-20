import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A submitted OpenAI Batch API job (async execution mode).
 *
 * One row per logical batch. Tenant isolation is by explicit `tenant_id` (every
 * query filters it) rather than a relation — this table is written/read mostly
 * via raw idempotent SQL in AiBatchService, mirroring the ai_cost_entries /
 * ai_request_executions finops tables.
 *
 * Crash-safety: a row is inserted (PENDING) BEFORE the remote batch is created,
 * keyed by (tenant_id, idempotency_key). A retried submission finds the existing
 * row instead of creating a duplicate remote batch (and duplicate spend).
 *
 * bigint token/cost columns map to string in TypeORM (JS number can't hold them
 * safely); counts stay integer.
 */
@Entity('ai_batch_jobs')
@Unique('uq_ai_batch_job_idempotency', ['tenant_id', 'idempotency_key'])
export class AiBatchJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_ai_batch_jobs_tenant')
  @Column({ type: 'uuid' })
  tenant_id!: string;

  /** Logical AI feature (AI_FEATURE.*), e.g. 'file_indexing', 'reindex'. */
  @Column({ length: 80 })
  feature!: string;

  @Column({ length: 20, default: 'BATCH' })
  execution_mode!: string;

  @Column({ length: 40, default: 'openai' })
  provider!: string;

  /** OpenAI Batch endpoint: '/v1/embeddings' | '/v1/chat/completions'. */
  @Column({ length: 60 })
  endpoint!: string;

  @Column({ length: 100 })
  model!: string;

  @Column({ length: 30, default: 'PREPARING' })
  status!: string;

  @Column({ length: 200 })
  idempotency_key!: string;

  /** Opaque correlation id echoed into remote batch metadata (crash reconciliation). */
  @Column({ type: 'varchar', length: 80, nullable: true })
  correlation_id?: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  external_batch_id?: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  input_file_id?: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  output_file_id?: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  error_file_id?: string | null;

  /** Next time this job is eligible for a status poll (backoff-scheduled). */
  @Column({ type: 'timestamptz', nullable: true })
  next_poll_at?: Date | null;

  @Column({ type: 'int', default: 0 })
  poll_attempts!: number;

  @Column({ type: 'varchar', length: 200, nullable: true })
  last_error?: string | null;

  @Column({ type: 'int', default: 0 })
  total_requests!: number;

  @Column({ type: 'int', default: 0 })
  completed_requests!: number;

  @Column({ type: 'int', default: 0 })
  failed_requests!: number;

  @Column({ type: 'bigint', default: 0 })
  input_tokens!: string;

  @Column({ type: 'bigint', default: 0 })
  output_tokens!: string;

  @Column({ type: 'bigint', default: 0 })
  embedding_tokens!: string;

  /** Exact integer micro-USD; null when UNPRICED. */
  @Column({ type: 'bigint', nullable: true })
  cost_microusd?: string | null;

  @Column({ length: 20, default: 'UNPRICED' })
  pricing_status!: string;

  @Column({ type: 'varchar', length: 80, nullable: true })
  error_code?: string | null;

  /** Data-residency region the job was processed in (null = global default). */
  @Column({ type: 'varchar', length: 40, nullable: true })
  region?: string | null;

  /** Tenant AI deployment used (data residency), when applicable. */
  @Column({ type: 'uuid', nullable: true })
  deployment_id?: string | null;

  /** Owning agent for embedding batches (chunks belong to one agent). */
  @Column({ type: 'uuid', nullable: true })
  agent_id?: string | null;

  /** Origin of the work, e.g. 'training_file'. */
  @Column({ type: 'varchar', length: 40, nullable: true })
  source_type?: string | null;

  /** Origin id, e.g. the training file id (used by completion finalizers). */
  @Column({ type: 'varchar', length: 120, nullable: true })
  source_id?: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown> | null;

  @Column({ type: 'timestamptz', nullable: true })
  submitted_at?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completed_at?: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
