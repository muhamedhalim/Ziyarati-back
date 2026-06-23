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