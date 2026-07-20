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
 * One request line inside a batch job, addressed by its `custom_id`.
 *
 * `custom_id` is how results are bound back after the async batch completes:
 * OpenAI returns output/error lines in an UNSPECIFIED order, each echoing the
 * `custom_id` we supplied — never rely on positional order. It is unique per
 * (batch_job_id) so a retried result-import updates the same row (idempotent,
 * no duplicated results).
 *
 * For an embedding batch, `target_ref` is the ai_knowledge_bases chunk id the
 * resulting vector must be written to.
 */
@Entity('ai_batch_items')
@Unique('uq_ai_batch_item_custom_id', ['batch_job_id', 'custom_id'])
@Index('idx_ai_batch_items_job', ['batch_job_id', 'status'])
export class AiBatchItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  batch_job_id!: string;

  @Column({ type: 'uuid' })
  tenant_id!: string;

  @Column({ length: 120 })
  custom_id!: string;

  @Column({ length: 20, default: 'PENDING' })
  status!: string;

  @Column({ length: 40, nullable: true })
  source_type?: string | null;

  @Column({ length: 120, nullable: true })
  source_id?: string | null;

  /** Where the result is applied, e.g. an ai_knowledge_bases chunk id. */
  @Column({ length: 120, nullable: true })
  target_ref?: string | null;

  @Column({ type: 'int', default: 0 })
  input_tokens!: number;

  @Column({ length: 120, nullable: true })
  error_code?: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
