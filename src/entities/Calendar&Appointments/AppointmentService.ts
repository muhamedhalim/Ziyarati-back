import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { Appointment } from './Appointment';
import { Service } from '../Services/Service';
import { Tenant } from '../SaaS-Core/Tenant';
import { decimalTransformer } from '../../common/transformers/decimal.transformer';

@Entity('appointment_services')
@Index(['appointment'])
@Index(['service'])
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
    transformer: decimalTransformer,
  })
  price!: number;

  @Column()
  duration_minutes!: number;

  @CreateDateColumn()
  created_at!: Date;
}
