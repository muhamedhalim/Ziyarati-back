import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToOne,
  OneToMany,
  JoinColumn,
  CreateDateColumn,
  DeleteDateColumn,
  Index,
} from 'typeorm';

import { User } from '../Auth&RBAC/User';
import { Tenant } from '../SaaS-Core/Tenant';
import { StaffService } from './StaffService';
import { StaffSchedule } from './StaffSchedule';
import { StaffTimeOff } from './StaffTimeOff';
import { StaffCommission } from './StaffCommission';
import { StaffRating } from './StaffRating';

@Entity('staff_profiles')
@Index(['tenant'])
export class StaffProfile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @OneToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column({ nullable: true })
  title?: string;

  @Column({
    type: 'text',
    nullable: true,
  })
  bio?: string;

  @Column({
    type: 'text',
    nullable: true,
  })
  avatar_url?: string;

  @Column({
    default: 0,
  })
  booking_buffer_minutes!: number;

  @Column({
    default: true,
  })
  is_available_for_booking!: boolean;

  @OneToMany(
    () => StaffService,
    (staffService) => staffService.staff,
  )
  staffServices!: StaffService[];

  @OneToMany(
    () => StaffSchedule,
    (schedule) => schedule.staff,
  )
  schedules!: StaffSchedule[];

  @OneToMany(
    () => StaffTimeOff,
    (timeOff) => timeOff.staff,
  )
  timeOffs!: StaffTimeOff[];

  @OneToMany(
    () => StaffCommission,
    (commission) => commission.staff,
  )
  commissions!: StaffCommission[];

  @OneToMany(
    () => StaffRating,
    (rating) => rating.staff,
  )
  ratings!: StaffRating[];

  @CreateDateColumn()
  created_at!: Date;

  @DeleteDateColumn()
  deleted_at?: Date;
}