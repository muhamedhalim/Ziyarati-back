import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { Branch } from '../SaaS-Core/Branch';

@Entity('working_hours')
export class WorkingHour {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Branch)
  branch!: Branch;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column({
    type: 'smallint',
  })
  day_of_week!: number;

  @Column({
    type: 'time',
  })
  start_time!: string;

  @Column({
    type: 'time',
  })
  end_time!: string;

  @Column({
    default: false,
  })
  is_closed!: boolean;
}