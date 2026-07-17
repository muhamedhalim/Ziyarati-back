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
@Index(['tenant', 'created_at'])
@Index('UQ_whatsapp_webhook_idempotency_key', ['idempotency_key'], {
  unique: true,
  where: '"idempotency_key" IS NOT NULL',
})
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

  /**
   * Meta redelivery dedup key. Partial-unique (see index above): the DB is
   * the layer that actually serializes concurrent inserts, closing the
   * check-then-insert race a plain `findOne` + `save()` can't.
   */
  @Column({ length: 255, nullable: true })
  idempotency_key?: string;

  @CreateDateColumn()
  created_at!: Date;
}