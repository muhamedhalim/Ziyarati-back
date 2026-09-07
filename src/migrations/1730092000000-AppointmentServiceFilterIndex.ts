import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Appointments list "Services" filter (`QueryAppointmentsDto.serviceIds`)
 * queries `appointment_services` by `serviceId` (joined back to
 * `appointments`). Postgres does not auto-index FK columns, and
 * `appointment_services` already got its `appointmentId` FK index in
 * `AppointmentIntegrityHardening1730001300000` — this is the same treatment
 * for the `serviceId` side, so the new filter doesn't force a sequential
 * scan on tenants with a large services/appointments history. Idempotent.
 */
export class AppointmentServiceFilterIndex1730092000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IX_appt_services_service" ON "appointment_services" ("serviceId")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "public"."IX_appt_services_service"`);
  }
}
