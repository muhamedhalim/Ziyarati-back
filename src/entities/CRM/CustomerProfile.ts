import { Column, Entity, JoinColumn, ManyToOne, OneToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { Customer } from "./Customer";
import { Tenant } from "../SaaS Core/Tenant";

@Entity('customer_profiles')
export class CustomerProfile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @OneToOne(() => Customer)
  @JoinColumn({ name: 'customer_id' })
  customer!: Customer;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column({ type: 'text', nullable: true })
  medical_history?: string;

  @Column({ type: 'text', nullable: true })
  allergies?: string;

  @Column({ nullable: true })
  blood_type?: string;

  @Column({ nullable: true })
  emergency_contact_name?: string;

  @Column({ nullable: true })
  emergency_contact_phone?: string;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @UpdateDateColumn()
  updated_at?: Date;
}