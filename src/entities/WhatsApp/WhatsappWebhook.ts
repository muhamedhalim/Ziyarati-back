import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';

@Entity('whatsapp_webhooks')
@Index(['created_at'])
export class WhatsappWebhook {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, {
    nullable: true,
  })
  tenant?: Tenant;

  @Column({ length: 100, nullable: true })
  event_type?: string;

  @Column({ type: 'jsonb', nullable: true })
  payload?: Record<string, any>;

  @Column({ default: false })
  processed!: boolean;

  @Column({ length: 255, nullable: true })
  idempotency_key?: string;

  @CreateDateColumn()
  created_at!: Date;
}