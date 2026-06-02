import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';
import { Branch } from '../SaaS Core/Branch';
import { StaffProfile } from './StaffProfile';

@Entity('staff_schedules')
@Index(['staff', 'day_of_week'])
export class StaffSchedule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(
    () => StaffProfile,
    (staff) => staff.schedules,
    {
      onDelete: 'CASCADE',
    },
  )
  staff!: StaffProfile;

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
    default: true,
  })
  is_active!: boolean;
}