import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';
import { Appointment } from './Appointment';
import { Service } from '../Services/Service';
import { Tenant } from '../SaaS Core/Tenant';

@Entity('appointment_services')
export class AppointmentService {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Appointment, {
    onDelete: 'CASCADE',
  })
  appointment!: Appointment;

  @ManyToOne(() => Service)
  service!: Service;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
  })
  price!: number;

  @Column()
  duration_minutes!: number;

  @CreateDateColumn()
  created_at!: Date;
}