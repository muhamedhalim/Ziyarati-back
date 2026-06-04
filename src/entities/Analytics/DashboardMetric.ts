import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { Branch } from '../SaaS-Core/Branch';

@Entity('dashboard_metrics')
export class DashboardMetric {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Branch, {
    nullable: true,
  })
  branch?: Branch;

  @Column({
    length: 100,
  })
  metric_key!: string;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 4,
    nullable: true,
  })
  metric_value?: number;

  @Column({
    nullable: true,
  })
  period?: string;

  @Column({
    type: 'timestamptz',
    nullable: true,
  })
  updated_at?: Date;
}