import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Unique,
  JoinColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { Branch } from '../SaaS-Core/Branch';

/**
 * A WhatsApp sending identity for a branch.
 *
 * Hybrid SaaS model: a branch may hold one PLATFORM account (the shared SaaS
 * number) AND one CUSTOM account (the clinic's own number) — hence uniqueness is
 * on (branch, mode), not branch alone. The message router prefers CUSTOM and
 * falls back to PLATFORM.
 */
@Entity('whatsapp_accounts')
@Unique('UQ_whatsapp_account_branch_mode', ['branch', 'mode'])
export class WhatsappAccount {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Branch)
  @JoinColumn({ name: 'branch_id' })
  branch!: Branch;

  /** 'PLATFORM' | 'CUSTOM' — see WHATSAPP_ACCOUNT_MODE. */
  @Column({
    type: 'varchar',
    length: 20,
    default: 'CUSTOM',
  })
  mode!: string;

  @Column({
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  phone_number_id?: string;

  @Column({
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  waba_id?: string;

  @Column({
    type: 'text',
    nullable: true,
  })
  access_token?: string;

  /**
   * Expiry of `access_token`. Important for System User / rotated tokens — the
   * router/adapter can detect an expired credential and skip or alert.
   */
  @Column({
    type: 'timestamptz',
    nullable: true,
  })
  token_expires_at?: Date;

  @Column({
    default: true,
  })
  is_active!: boolean;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  @DeleteDateColumn()
  deleted_at?: Date;
}
