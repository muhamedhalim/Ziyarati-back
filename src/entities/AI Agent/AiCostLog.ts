import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  Unique,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';

@Entity('ai_cost_logs')
@Unique(['tenant', 'period_month'])
export class AiCostLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column({ length: 7 })
  period_month!: string;

  @Column({ default: 0 })
  input_tokens!: number;

  @Column({ default: 0 })
  output_tokens!: number;

  @Column({ default: 0 })
  cached_input_tokens!: number;

  @Column({ default: 0 })
  embedding_tokens!: number;

  /** Exact integer micro-USD. This is the billing/aggregation source of truth. */
  @Column({ type: 'bigint', default: 0 })
  cost_microusd!: string;

  @Column({ default: 0 })
  unpriced_requests!: number;

  @Column({ type: 'numeric', precision: 14, scale: 6, default: 0 })
  total_cost_usd!: number;

  // Added by migration 1730003900000-AiBatchExecution but never mapped here —
  // with TYPEORM_SYNCHRONIZE=true that omission makes synchronize DROP these
  // columns on every boot (audit-013 T011 live probe caught this in the act:
  // "column batch_embedding_tokens of relation ai_cost_logs does not exist").
  @Column({ type: 'bigint', default: 0 })
  batch_embedding_tokens!: string;

  @Column({ type: 'bigint', default: 0 })
  batch_cost_microusd!: string;
}
