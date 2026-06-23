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

  /**
   * For channel=WHATSAPP: the approved WhatsappTemplate id to send (its own
   * language IS the locale). Required to dispatch a WhatsApp notification.
   */
  @Column({ type: 'uuid', nullable: true })
  provider_template_id?: string;

  /** Default template variable values (overridden per-notification). */
  @Column({ type: 'jsonb', nullable: true })
  variables?: Record<string, unknown>;

  @Column({ type: 'text', nullable: true })
  content_ar?: string;

  @Column({ type: 'text', nullable: true })
  content_en?: string;

  @Column({ default: true })
  is_active!: boolean;

  @CreateDateColumn()
  created_at!: Date;
}