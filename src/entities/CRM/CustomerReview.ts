import { Column, CreateDateColumn, DeleteDateColumn, Entity, JoinColumn, ManyToOne, OneToOne, PrimaryGeneratedColumn } from "typeorm";
import { Customer } from "./Customer";
import { Tenant } from "../SaaS Core/Tenant";
import { Appointment } from "../Calendar&Appointments/Appointment";

@Entity('customer_reviews')
export class CustomerReview {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Customer)
  customer!: Customer;

  @OneToOne(() => Appointment, {
    nullable: false,
  })
  @JoinColumn({ name: 'appointment_id' })
  appointment!: Appointment;

  @Column({
    type: 'smallint',
  })
  rating!: number;

  @Column({
    type: 'text',
    nullable: true,
  })
  comment?: string;

  @Column({
    type: 'text',
    nullable: true,
  })
  reply?: string;

  @CreateDateColumn()
  created_at!: Date;

  @DeleteDateColumn()
  deleted_at?: Date;
}