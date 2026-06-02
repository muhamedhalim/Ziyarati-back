import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Unique,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';
import { Branch } from '../SaaS Core/Branch';

@Entity('monthly_reports')
@Unique(['tenant', 'branch', 'period_month'])
export class MonthlyReport {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Branch)
  branch!: Branch;

  @Column({
    length: 7,
  })
  period_month!: string;

  @Column({
    default: 0,
  })
  total_appointments!: number;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
    default: 0,
  })
  total_revenue!: number;

  @Column({
    type: 'decimal',
    precision: 3,
    scale: 2,
    nullable: true,
  })
  avg_rating?: number;

  @Column({
    type: 'jsonb',
    nullable: true,
  })
  top_services?: Record<string, any>;

  @CreateDateColumn({
    type: 'timestamptz',
  })
  created_at!: Date;
}