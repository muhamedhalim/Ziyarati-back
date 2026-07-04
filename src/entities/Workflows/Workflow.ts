import {
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';

/** One stored condition: `field <op> value` evaluated against the run context. */
export interface WorkflowConditionSpec {
  field: string;
  operator: string;
  value?: unknown;
}

/** One stored action: a typed step with its own config + optional delay. */
export interface WorkflowActionSpec {
  type: string;
  config: Record<string, unknown>;
  /** Minutes to wait before this action runs (BullMQ delay). */
  delayMinutes?: number;
  /**
   * Per-action gate (ALL must match, AND) — evaluated against the SAME run
   * context as the workflow-level `conditions`, via the SAME
   * `WorkflowService.evaluateConditions`. This is how the visual builder
   * expresses IF/ELSE branching on the existing flat action list: two actions
   * with mutually-exclusive conditions behave as an IF/ELSE pair without any
   * new execution engine. Absent/empty = always run (unchanged behaviour).
   */
  conditions?: WorkflowConditionSpec[];
}

/**
 * A tenant-configurable automation: when `trigger_event` fires and every
 * condition matches, each action is executed (asynchronously, via BullMQ). The
 * engine owns NO domain logic — actions delegate to existing services (Email,
 * WhatsApp, Notifications, AI, or an outbound webhook).
 */
@Entity('workflows')
export class Workflow {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column({ length: 160 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  /** Domain event that triggers this workflow (e.g. `appointment.created`). */
  @Index()
  @Column({ length: 80 })
  trigger_event!: string;

  @Column({ default: true })
  is_active!: boolean;

  /** ALL conditions must match (AND). Empty/absent = always run. */
  @Column({ type: 'jsonb', nullable: true })
  conditions?: WorkflowConditionSpec[];

  /** Ordered actions to execute when the workflow fires. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  actions!: WorkflowActionSpec[];

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
