import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import { Tenant } from '../SaaS-Core/Tenant';

@Entity('tenant_settings')
export class TenantSetting {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @OneToOne(() => Tenant, (t) => t.settings, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant!: Tenant;

  @Column({ default: 'AUTO' })
  booking_confirmation!: string;

  @Column({ default: true })
  payment_required!: boolean;

  @Column({ default: 24 })
  cancellation_hours!: number;

  @Column({ default: 360 })
  feedback_delay_minutes!: number;

  @Column({ default: 'ar' })
  default_language!: string;

  @Column({ default: 'USD' })
  currency!: string;

  @Column({ default: true })
  bot_enabled!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  updated_at?: Date;
}