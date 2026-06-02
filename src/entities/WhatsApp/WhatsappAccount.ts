import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  DeleteDateColumn,
  Unique,
  JoinColumn,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';
import { Branch } from '../SaaS Core/Branch';

@Entity('whatsapp_accounts')
@Unique(['branch'])
export class WhatsappAccount {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

@ManyToOne(() => Branch)
@JoinColumn({ name: 'branch_id' })
branch!: Branch;

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

  @Column({
    default: true,
  })
  is_active!: boolean;

  @CreateDateColumn()
  created_at!: Date;

  @DeleteDateColumn()
  deleted_at?: Date;
}