import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { Customer } from "./Customer";
import { Tenant } from "../SaaS Core/Tenant";

@Entity('customer_addresses')
export class CustomerAddress {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Customer, (customer) => customer.addresses)
  customer!: Customer;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column({ nullable: true })
  label?: string;

  @Column({ type: 'text', nullable: true })
  address_line?: string;

  @Column({ nullable: true })
  city?: string;

  @Column({ default: false })
  is_default!: boolean;
}