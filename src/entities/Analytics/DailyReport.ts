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

@Entity('daily_reports')
@Unique(['tenant', 'branch', 'date'])
export class DailyReport {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Branch)
  branch!: Branch;

  @Column({
    type: 'date',
  })
  date!: Date;

  @Column({
    default: 0,
  })
  total_appointments!: number;

  @Column({
    default: 0,
  })
  completed_appointments!: number;

  @Column({
    default: 0,
  })
  cancelled_appointments!: number;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
    default: 0,
  })
  total_revenue!: number;

  @Column({
    default: 0,
  })
  new_customers!: number;

  @Column({
    default: 0,
  })
  ai_messages_count!: number;

  @CreateDateColumn({
    type: 'timestamptz',
  })
  created_at!: Date;
}   