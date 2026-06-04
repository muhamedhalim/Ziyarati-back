import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { StaffProfile } from './StaffProfile';
import { Customer } from '../CRM/Customer';
import { Appointment } from '../Calendar&Appointments/Appointment';

@Entity('staff_ratings')
export class StaffRating {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(
    () => StaffProfile,
    (staff) => staff.ratings,
  )
  staff!: StaffProfile;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Customer, {
    nullable: true,
  })
  customer?: Customer;

  @ManyToOne(() => Appointment, {
    nullable: true,
  })
  appointment?: Appointment;

  @Column({
    type: 'smallint',
  })
  rating!: number;

  @Column({
    type: 'text',
    nullable: true,
  })
  comment?: string;

  @CreateDateColumn()
  created_at!: Date;
}