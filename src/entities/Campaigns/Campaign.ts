import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  JoinColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { WhatsappTemplate } from '../WhatsApp/WhatsappTemplate';
import { WhatsappAccount } from '../WhatsApp/WhatsappAccount';
import { CampaignLifecycle, CampaignType } from '../enums';
import { User } from '../Auth&RBAC/User';
import { CustomerSegment } from '../CRM/CustomerSegment';
import { CAMPAIGN_CHANNEL } from '../../modules/campaigns/campaign.constants';

@Entity('campaigns')
@Index(['tenant', 'lifecycle'])
export class Campaign {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column({
    type: 'enum',
    enum: CampaignType,
  })
  type!: CampaignType;

  @Column({ length: 200 })
  name!: string;

  /**
   * Phase 11 (US7, T130/T131) — the delivery channel this campaign targets.
   * NOT NULL with a default of WHATSAPP so every pre-existing campaign reads
   * back unchanged (`migration:verify`'s own assertion). `CampaignDeliveryFactory`
   * resolves the real provider from this value; `CampaignDispatchService`
   * treats a value OTHER than the default as an explicit channel selection —
   * see its "fail loudly on noop" guard.
   */
  @Column({ type: 'varchar', length: 16, default: CAMPAIGN_CHANNEL.WHATSAPP })
  channel!: string;

  /**
   * Phase 11 (US7, T131/T132) — clinic-authored marketing email content, used
   * only when {@link channel} is EMAIL. Plain text (HTML-escaped by the
   * `campaign_marketing` renderer, never raw HTML) — kept minimal and
   * separate from the transactional template family (T132).
   */
  @Column({ type: 'varchar', length: 200, nullable: true })
  email_subject?: string | null;

  @Column({ type: 'text', nullable: true })
  email_body?: string | null;

  /**
   * The number this campaign sends FROM. Explicit rather than resolved at send
   * time, because a campaign's identity to the recipient is part of the
   * campaign: re-running one months later must not silently switch numbers just
   * because the tenant's default changed.
   *
   * NULLABLE for backwards compatibility with campaigns created before this
   * column existed — those fall back to the tenant's default account at launch
   * (see CampaignExecutionService.assertSendable).
   */
  @ManyToOne(() => WhatsappAccount, {
    nullable: true,
    // NOT cascade: disconnecting a number must never delete the campaigns (and
    // their audit history) that were sent from it — they just lose the link.
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'whatsapp_account_id' })
  whatsapp_account?: WhatsappAccount;

  @ManyToOne(() => WhatsappTemplate, {
    nullable: true,
  })
  template?: WhatsappTemplate;

  /**
   * BUSINESS state (operator intent). Execution/runtime state lives on
   * {@link CampaignRun}, never here.
   */
  @Column({
    type: 'enum',
    enum: CampaignLifecycle,
    default: CampaignLifecycle.DRAFT,
  })
  lifecycle!: CampaignLifecycle;

  /**
   * Legacy free-form audience snapshot. Phase 10 (R8) supersedes this with
   * {@link segment} (a reusable, rule-based `CustomerSegment`) — retained
   * WRITTEN-BUT-UNREAD so existing campaigns don't silently change meaning;
   * never read by any Phase-10-or-later code path.
   */
  @Column({
    type: 'jsonb',
    nullable: true,
  })
  segment?: Record<string, any>;

  /**
   * Phase 10 (US8, R8) — an optional reusable audience. When set, campaign
   * fan-out resolves membership live (`CampaignFanoutService`), never
   * freezing it at attach time. `onDelete: 'SET NULL'` — deleting the segment
   * must never delete campaign history, only detach the reference.
   */
  @ManyToOne(() => CustomerSegment, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'segment_id' })
  audience_segment?: CustomerSegment;

  @Column({
    type: 'timestamptz',
    nullable: true,
  })
  scheduled_at?: Date;

  @Column({
    default: 30,
  })
  throttle_per_minute!: number;

  @Column({ nullable: true })
  daily_cap?: number;

  @Column({ nullable: true })
  monthly_cap?: number;

  @ManyToOne(() => User, {
    nullable: true,
  })
  @JoinColumn({ name: 'created_by' })
  created_by?: User;

  @Column({ type: 'timestamptz', nullable: true })
  deleted_at?: Date;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at?: Date;
}
