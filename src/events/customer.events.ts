/**
 * Customer (patient) domain events.
 *
 * `BIRTHDAY` is a DATE-driven event: unlike the appointment/payment events it
 * is not emitted from a request, but by the daily birthday sweep
 * (`BirthdayGreetingSweepService`) the moment a patient's birthday arrives in
 * their clinic's local calendar. The workflow engine subscribes to it like any
 * other trigger — see `WORKFLOW_TRIGGER.CUSTOMER_BIRTHDAY`.
 */

export const CUSTOMER_EVENT = {
  BIRTHDAY: 'customer.birthday',
} as const;

export type CustomerEventName =
  (typeof CUSTOMER_EVENT)[keyof typeof CUSTOMER_EVENT];

export class CustomerBirthdayEvent {
  static readonly eventName = CUSTOMER_EVENT.BIRTHDAY;
  constructor(
    readonly tenantId: string,
    readonly customerId: string,
    /**
     * The clinic-local calendar date (`YYYY-MM-DD`) this birthday was observed
     * on. Together with `customerId` it identifies ONE greeting occurrence, so
     * a re-run of the sweep on the same day can never greet a patient twice.
     */
    readonly occurrenceDate: string,
  ) {}
}
