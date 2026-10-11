import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
  Unique,
  DeleteDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { WhatsappAccount } from './WhatsappAccount';

/**
 * A WhatsApp message template.
 *
 * Templates are OWNED BY META, not by us: they live on a WABA, Meta approves or
 * rejects them, and a business-initiated message can only use an approved one.
 * Rows here are therefore a synced mirror (see WhatsappTemplateSyncService),
 * with `provider_template_id` as the Meta-side identity and `waba_id` recording
 * which WABA the template belongs to — a campaign may only send a template
 * through an account on that same WABA, so this must be stored, not inferred.
 */
@Entity('whatsapp_templates')
@Unique(['tenant', 'name', 'language'])
@Index('IDX_whatsapp_template_waba', ['waba_id'])
export class WhatsappTemplate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => WhatsappAccount, {
    nullable: true,
  })
  whatsapp_account?: WhatsappAccount;

  @Column({ length: 100 })
  name!: string;

  @Column({ length: 10 })
  language!: string;

  @Column({ length: 50, nullable: true })
  category?: string;

  @Column({ default: 'PENDING' })
  status!: string;

  @Column({ type: 'jsonb', nullable: true })
  components?: Record<string, any>;

  /**
   * Meta's own template id. The stable identity across renames and the upsert
   * key for sync. NULL for locally-authored drafts never pushed to Meta.
   */
  @Column({ type: 'varchar', length: 100, nullable: true })
  provider_template_id?: string;

  /**
   * WABA this template belongs to. Copied from the synced account rather than
   * joined at read time: a campaign's WABA-match check runs per recipient on
   * the send hot path, and the template can outlive the account row it came
   * from (reconnects create a new account for the same WABA).
   */
  @Column({ type: 'varchar', length: 100, nullable: true })
  waba_id?: string;

  /** Meta's rejection reason, when status is rejected. Diagnostic only. */
  @Column({ type: 'text', nullable: true })
  rejected_reason?: string;

  /**
   * Which trusted piece of data fills each placeholder when this template is
   * sent by the notification pipeline: `{ "1": "patient_name", "2": "appointment_date" }`.
   * Keys are the template's own placeholder names; values come from the closed
   * `WHATSAPP_TEMPLATE_VARIABLE_SOURCES` set and are resolved server-side from
   * the appointment / clinic / customer rows at send time.
   *
   * NULL means "no automation binding" — such a template can still be sent
   * manually (the sender types the values) but cannot be wired to a
   * notification rule while it declares placeholders.
   */
  @Column({ type: 'jsonb', nullable: true })
  variable_mapping?: Record<string, string> | null;

  /** Last time this row was reconciled with Meta. */
  @Column({ type: 'timestamptz', nullable: true })
  last_synced_at?: Date;

  @CreateDateColumn()
  created_at!: Date;

  @DeleteDateColumn()
  deleted_at?: Date;
}