import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
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
   * This is the DEFAULT/fallback variant — see `provider_template_id_ar`.
   */
  @Column({ type: 'uuid', nullable: true })
  provider_template_id?: string;

  /**
   * M-10/CAP-I18N (T157 gap-closure): optional Arabic-language sibling
   * WhatsappTemplate (same `name`, `language` starting with "ar", per
   * `@Unique(['tenant','name','language'])`). `NotificationDispatchService`
   * uses this instead of `provider_template_id` when the recipient
   * Customer's `preferred_locale` (M-09) resolves to Arabic. `NULL` = no
   * Arabic variant linked, falls back to `provider_template_id` unchanged.
   */
  @Column({ type: 'uuid', nullable: true })
  provider_template_id_ar?: string;

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