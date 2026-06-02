import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { Appointment } from './Appointment';
import { Tenant } from '../SaaS Core/Tenant';
import { User } from '../Auth&RBAC/User';

@Entity('appointment_notes')
export class AppointmentNote {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Appointment, {
    onDelete: 'CASCADE',
  })
  appointment!: Appointment;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => User, {
    nullable: true,
  })
  user?: User;

  @Column('text')
  content!: string;

  @CreateDateColumn()
  created_at!: Date;
}