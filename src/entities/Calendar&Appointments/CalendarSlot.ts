import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';
import { Branch } from '../SaaS Core/Branch';
import { StaffProfile } from '../Staff/StaffProfile';

@Entity('calendar_slots')
@Index(['tenant', 'branch', 'staff', 'start_time'])
export class CalendarSlot {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Branch)
  branch!: Branch;

  @ManyToOne(() => StaffProfile)
  staff!: StaffProfile;

  @Column({
    type: 'timestamptz',
  })
  start_time!: Date;

  @Column({
    type: 'timestamptz',
  })
  end_time!: Date;

  @Column({
    default: true,
  })
  is_available!: boolean;

  @CreateDateColumn()
  created_at!: Date;
}