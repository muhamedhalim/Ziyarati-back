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
}
