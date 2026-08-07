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

  /**
   * Whether this clinic is discoverable and bookable by ANONYMOUS visitors
   * through the public AI assistant.
   *
   * Defaults to `false`: listing a clinic publicly and letting strangers create
   * real appointments in it is a business decision the clinic opts into, not a
   * side effect of the feature shipping. Enforced in one place —
   * `PublicBookingContextService.resolveTenantFromBranch` — plus the public
   * discovery queries, so an opted-out clinic is neither listed nor bookable.
   */
  @Column({ default: false })
  public_booking_enabled!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  updated_at?: Date;
}