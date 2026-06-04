import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { StaffProfile } from './StaffProfile';

@Entity('staff_time_off')
export class StaffTimeOff {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(
    () => StaffProfile,
    (staff) => staff.timeOffs,
    {
      onDelete: 'CASCADE',
    },
  )
  staff!: StaffProfile;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column({
    type: 'date',
  })
  start_date!: Date;

  @Column({
    type: 'date',
  })
  end_date!: Date;

  @Column({
    type: 'text',
    nullable: true,
  })
  reason?: string;

  @CreateDateColumn()
  created_at!: Date;
}