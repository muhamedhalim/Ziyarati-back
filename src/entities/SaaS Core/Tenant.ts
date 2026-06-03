import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  OneToMany,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
} from 'typeorm';

import { TenantSetting } from '../SaaS Core/TenantSetting';
import { Branch } from '../SaaS Core/Branch';
import { Subscription } from '../SaaS Core/Subscription';
import { TenantVerificationDocument } from '../SaaS Core/TenantVerificationDocument';
import { TenantApprovalEvent } from '../SaaS Core/TenantApprovalEvent';
import { FeatureFlag } from '../SaaS Core/FeatureFlag';
import { TenantApprovalStatus } from '../enums';

@Entity('tenants')
@Index(['slug'], { unique: true })
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  name!: string;

  @Column({ unique: true })
  slug!: string;

  @Column({ nullable: true })
  logo_url?: string;

  @Column({ nullable: true })
  commercial_registration_number?: string;

  @Column({ nullable: true })
  legal_name?: string;

@Column({ unique: true })
  contact_email?: string;

  @Column({ nullable: true })
  contact_phone?: string;

  @Column({ type: 'smallint', nullable: true })
  country_id?: number;

  @Column({ default: 'USD' })
  default_currency!: string;

  @Column({ default: 'UTC' })
  default_timezone!: string;

  @Column({
    type: 'enum',
    enum: TenantApprovalStatus,
    default: TenantApprovalStatus.PENDING_VERIFICATION,
  })
  approval_status!: TenantApprovalStatus;

  @Column({ default: false })
  is_active!: boolean;

  @OneToOne(() => TenantSetting, (s) => s.tenant)
  settings!: TenantSetting;

  @OneToMany(() => Branch, (b) => b.tenant)
  branches!: Branch[];

  @OneToMany(() => Subscription, (s) => s.tenant)
  subscriptions!: Subscription[];

  @OneToMany(() => TenantVerificationDocument, (d) => d.tenant)
  verificationDocuments!: TenantVerificationDocument[];

  @OneToMany(() => TenantApprovalEvent, (e) => e.tenant)
  approvalEvents!: TenantApprovalEvent[];

  @OneToMany(() => FeatureFlag, (f) => f.tenant)
  featureFlags!: FeatureFlag[];

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  @DeleteDateColumn()
  deleted_at!: Date;
}