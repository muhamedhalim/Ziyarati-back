import { Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { Customer } from "./Customer";
import { Tenant } from "../SaaS-Core/Tenant";
import { User } from "../Auth&RBAC/User";
import { Conversation } from "../Conversations/Conversation";

@Entity('customer_notes')
export class CustomerNote {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Customer, (customer) => customer.notes)
  customer!: Customer;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => User, { nullable: true })
  user?: User;

  /** Optional: ties a note to the handover conversation it was written during,
   *  so the Agent Inbox can show it in the conversation's Internal Notes panel
   *  while it remains a first-class CRM note against the customer. */
  @ManyToOne(() => Conversation, { nullable: true })
  conversation?: Conversation;

  @Column('text')
  content!: string;

  @CreateDateColumn()
  created_at!: Date;
}