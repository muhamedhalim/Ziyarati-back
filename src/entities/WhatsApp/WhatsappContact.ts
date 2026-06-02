import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';
import { Customer } from '../CRM/Customer';

@Entity('whatsapp_contacts')
export class WhatsappContact {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Customer, {
    nullable: true,
  })
  customer?: Customer;

  @Column({ length: 100, nullable: true })
  wa_id?: string;

  @Column({ length: 255, nullable: true })
  display_name?: string;

  @CreateDateColumn()
  created_at!: Date;
}