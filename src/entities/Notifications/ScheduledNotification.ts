import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { NotificationTemplate } from './NotificationTemplate';
import { Appointment } from '../Calendar&Appointments/Appointment';

@Entity('scheduled_notifications')
@Index(['scheduled_at', 'status'])
export class ScheduledNotification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => NotificationTemplate, {
    nullable: true,
  })
  template?: NotificationTemplate;

  @ManyToOne(() => Appointment, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  appointment?: Appointment;

  @Column({ length: 20, nullable: true })
  recipient_type?: string;

  @Column({ type: 'uuid', nullable: true })
  recipient_id?: string;

  @Column({ type: 'timestamptz' })
  scheduled_at!: Date;

  @Column({
    type: 'varchar',
    length: 20,
    default: 'SCHEDULED',
  })
  status!: string;

  @CreateDateColumn()
  created_at!: Date;
}