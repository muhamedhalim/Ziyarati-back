import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Unique,
  DeleteDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { WhatsappAccount } from './WhatsappAccount';

@Entity('whatsapp_templates')
@Unique(['tenant', 'name', 'language'])
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

  @CreateDateColumn()
  created_at!: Date;

  @DeleteDateColumn()
  deleted_at?: Date;
}