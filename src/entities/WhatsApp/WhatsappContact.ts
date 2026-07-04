import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
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

  /**
   * The AI conversation this WhatsApp contact is bound to, so every inbound
   * message from this number continues the SAME conversation (shared history,
   * session, memory and agent). Set on the first inbound turn.
   */
  @Column({ type: 'uuid', nullable: true })
  ai_conversation_id?: string;

  @CreateDateColumn()
  created_at!: Date;
}