import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';

@Entity('notification_templates')
export class NotificationTemplate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, {
    nullable: true,
  })
  tenant?: Tenant;

  @Column({ length: 100 })
  name!: string;

  @Column({ length: 50, nullable: true })
  type?: string;

  @Column({ length: 20, nullable: true })
  channel?: string;

  @Column({ type: 'text', nullable: true })
  content_ar?: string;

  @Column({ type: 'text', nullable: true })
  content_en?: string;

  @Column({ default: true })
  is_active!: boolean;

  @CreateDateColumn()
  created_at!: Date;
}