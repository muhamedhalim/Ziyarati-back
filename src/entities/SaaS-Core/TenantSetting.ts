import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import { Tenant } from '../SaaS-Core/Tenant';
import { decimalTransformer } from '../../common/transformers/decimal.transformer';

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

  /**
   * Whether a staff member must have an explicitly configured working window
   * (a `StaffSchedule` intersected with the branch's `WorkingHour`, or a
   * `CalendarSlot`) before they can be booked at a given time.
   *
   * Defaults to `false`: a clinic that has never populated schedules would
   * otherwise become unable to book anyone at all the moment this shipped. With
   * it off, "no schedule configured that day" means "no working-hours
   * constraint" — every HARD exclusion (holiday, time off, blocked period,
   * inactive staff, double-booking) is still enforced. With it on, "nothing
   * configured" means "not bookable".
   *
   * Read in exactly one place — `AvailabilityService.enforceWorkingHours` — so
   * every booking source (reception, admin, WhatsApp bot, public AI assistant,
   * integration platform) obeys it identically.
   */
  @Column({ default: false })
  enforce_staff_working_hours!: boolean;

  /**
   * Monthly goal for completed appointments, set by the clinic owner and
   * shown as a progress card on the dashboard. `null` = no target set (the
   * card renders a "set a target" prompt rather than a 0% bar). The target
   * period is always the current UTC calendar month — there is no history of
   * past targets, only the standing goal.
   */
  @Column({ type: 'int', nullable: true })
  appointment_target?: number | null;

  /**
   * Monthly revenue goal, in the clinic's own {@link currency}, set by the
   * owner. Same semantics as {@link appointment_target}: `null` = unset.
   */
  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: decimalTransformer,
  })
  revenue_target?: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  updated_at?: Date;
}