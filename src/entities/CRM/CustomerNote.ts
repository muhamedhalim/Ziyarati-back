import { Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { Customer } from "./Customer";
import { Tenant } from "../SaaS Core/Tenant";
import { User } from "../Auth&RBAC/User";

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

  @Column('text')
  content!: string;

  @CreateDateColumn()
  created_at!: Date;
}