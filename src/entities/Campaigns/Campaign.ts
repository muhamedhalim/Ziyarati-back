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

  @Column({
    type: 'jsonb',
    nullable: true,
  })
  segment?: Record<string, any>;

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