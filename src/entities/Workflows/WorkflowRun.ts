import {
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  Column,
  Index,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { Workflow } from './Workflow';

/** Per-action execution outcome, appended as the run progresses. */
export interface WorkflowActionResult {
  index: number;
  type: string;
  /**
   * SKIPPED = the action's own `conditions` didn't match (IF/ELSE branching).
   * IN_PROGRESS = an ATOMIC CLAIM (gap-closure pass — see
   * docs/CACHING_QUEUES_AUDIT.md §0.8.3): written BEFORE the side effect runs
   * so two concurrent deliveries of the same action (a manual retry racing a
   * BullMQ auto-retry, or a stalled job redelivered mid-send) can never both
   * pass — only the caller that atomically wins the claim executes. Always
   * transient in the normal path (replaced by SUCCEEDED/FAILED/SKIPPED in the
   * same `handleAction` call); a lingering one past the stale window
   * (`WORKFLOW_ACTION_CLAIM_STALE_MS`) means the process that claimed it died
   * mid-execution, and `WorkflowService.claimAction` treats it as reclaimable.
   */
  status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'IN_PROGRESS';
  detail?: string;
  at: string;
}

/**
 * A single execution of a workflow, created when its trigger fires and its
 * conditions pass. Actions are executed asynchronously; each outcome is recorded
 * in `results` so the run is fully auditable.
 */
@Entity('workflow_runs')
export class WorkflowRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Index()
  @ManyToOne(() => Workflow, { onDelete: 'CASCADE' })
  workflow!: Workflow;

  @Column({ length: 80 })
  trigger_event!: string;

  /** PENDING → RUNNING → COMPLETED | FAILED | SKIPPED. */
  @Column({ length: 16, default: 'PENDING' })
  status!: string;

  /** The event payload (ids + scalars) the actions template against. */
  @Column({ type: 'jsonb', nullable: true })
  context?: Record<string, unknown>;

  /** Per-action outcomes (audit trail). */
  @Column({ type: 'jsonb', nullable: true })
  results?: WorkflowActionResult[];

  @Column({ type: 'text', nullable: true })
  error?: string;

  /**
   * True only for a manual "Test Run" from the builder. A dry-run action
   * still resolves its recipient and renders its content for real — it just
   * never calls the WhatsApp/Email provider (see `WorkflowActionExecutor`).
   */
  @Column({ default: false })
  dry_run!: boolean;

  @CreateDateColumn()
  created_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completed_at?: Date;
}
