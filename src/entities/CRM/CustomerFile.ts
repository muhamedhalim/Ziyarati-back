import { Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { Customer } from "./Customer";
import { Tenant } from "../SaaS-Core/Tenant";
import { User } from "../Auth&RBAC/User";

@Entity('customer_files')
export class CustomerFile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Customer, (customer) => customer.files)
  customer!: Customer;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column({ nullable: true })
  file_name?: string;

  @Column({ type: 'text', nullable: true })
  file_url?: string;

  @Column({ nullable: true })
  file_type?: string;

  @ManyToOne(() => User, { nullable: true })
  uploaded_by?: User;

  @CreateDateColumn()
  created_at!: Date;
}