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
  status: 'SUCCEEDED' | 'FAILED';
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

  @CreateDateColumn()
  created_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completed_at?: Date;
}
