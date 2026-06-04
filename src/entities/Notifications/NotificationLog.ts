import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';

@Entity('notification_logs')
export class NotificationLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, {
    nullable: true,
  })
  tenant?: Tenant;

  @Column({ length: 100, nullable: true })
  template_id?: string;

  @Column({ length: 20, nullable: true })
  recipient_type?: string;

  @Column({ type: 'uuid', nullable: true })
  recipient_id?: string;

  @Column({ length: 20, nullable: true })
  channel?: string;

  @Column({ length: 20, nullable: true })
  status?: string;

  @Column({ type: 'text', nullable: true })
  error_message?: string;

  @Column({ type: 'timestamptz', nullable: true })
  sent_at?: Date;

  @CreateDateColumn()
  created_at!: Date;
}