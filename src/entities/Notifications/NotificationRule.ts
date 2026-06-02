import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';
import { NotificationTemplate } from './NotificationTemplate';

@Entity('notification_rules')
export class NotificationRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => NotificationTemplate, {
    nullable: true,
  })
  template?: NotificationTemplate;

  @Column({ length: 100 })
  trigger_event!: string;

  @Column({ default: 0 })
  delay_minutes!: number;

  @Column({ default: true })
  is_active!: boolean;

  @CreateDateColumn()
  created_at!: Date;
}