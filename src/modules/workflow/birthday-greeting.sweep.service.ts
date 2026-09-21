import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';

import {
  CUSTOMER_EVENT,
  CustomerBirthdayEvent,
} from '../../events/customer.events';
import { AccessControlService } from '../subscription-billing/access-control.service';
import { FeatureKey } from '../subscription-billing/feature-registry';
import {
  BIRTHDAY_SEND_LOCAL_HOUR,
  WORKFLOW_TRIGGER,
} from './workflow.constants';

/** Patients fetched per query — bounds memory on a clinic with many same-day birthdays. */
const PAGE_SIZE = 500;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export interface BirthdaySweepResult {
  /** Tenants that have at least one active birthday workflow. */
  tenants: number;
  /** Tenants actually processed this tick (right local hour, entitled). */
  processed: number;
  /** `customer.birthday` events emitted. */
  emitted: number;
}

export interface BirthdaySweepOptions {
  /**
   * Called before each tenant; returning `false` aborts the sweep. The
   * processor uses it to keep its distributed lock alive across a long sweep
   * (and to stop if the lock was lost) — see `PlatformProcessor`.
   */
  keepAlive?: () => Promise<boolean>;
}

/** A clinic-local wall-clock reading. */
export interface LocalClock {
  year: number;
  month: number;
  day: number;
  hour: number;
}

/**
 * Reads `now` as wall-clock time in an IANA `timeZone`. An unknown/invalid zone
 * falls back to UTC rather than throwing — one clinic's bad setting must never
 * stall the sweep for every other clinic.
 */
export function localClock(now: Date, timeZone: string): LocalClock {
  let parts: Intl.DateTimeFormatPart[];
  const options = {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    hourCycle: 'h23',
  } as const;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      ...options,
      timeZone,
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      ...options,
      timeZone: 'UTC',
    }).formatToParts(now);
  }
  const num = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: num('year'),
    month: num('month'),
    day: num('day'),
    hour: num('hour'),
  };
}

const isLeapYear = (y: number) =>
  (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The daily "it's a patient's birthday" source for the workflow engine. The
 * engine is event-driven, and a birthday is not something that happens in a
 * request — so this sweep turns the calendar into the SAME `customer.birthday`
 * domain event every other trigger uses, and hands it to the existing
 * `WorkflowEventListener`. It contains no messaging logic: what is sent, to
 * whom, and how is decided entirely by the tenant's workflow.
 *
 * - Ticks hourly; acts for a tenant only during that clinic's local
 *   `BIRTHDAY_SEND_LOCAL_HOUR`, so every clinic greets mid-morning in its OWN
 *   timezone (`tenants.default_timezone`).
 * - Only tenants with an ACTIVE birthday workflow are visited, and only if
 *   they are still entitled to the `AUTOMATIONS` feature (the same gate the
 *   `workflow.*` jobs enforce) — no orphaned runs for a suspended clinic.
 * - Tenant-scoped: every customer query is filtered by the tenant being
 *   processed; nothing here reads across tenants for one tenant's greeting.
 * - Skips deleted/inactive patients, patients without a phone, and patients
 *   who opted out (`opted_out_at`).
 * - Idempotent: the listener creates at most one run per workflow per
 *   `{customerId}:{date}`, so a re-run the same day is a no-op.
 * - A 29 February birthday is greeted on 28 February in non-leap years.
 */
@Injectable()
export class BirthdayGreetingSweepService {
  private readonly logger = new Logger(BirthdayGreetingSweepService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly events: EventEmitter2,
    private readonly access: AccessControlService,
  ) {}

  async sweep(
    now: Date = new Date(),
    opts: BirthdaySweepOptions = {},
  ): Promise<BirthdaySweepResult> {
    const tenants: Array<{ id: string; tz: string | null }> =
      await this.dataSource.query(
        `SELECT DISTINCT t.id, t.default_timezone AS tz
         FROM workflows w
         JOIN tenants t ON t.id = w."tenantId"
         WHERE w.trigger_event = $1 AND w.is_active = true
           AND t.is_active = true AND t.deleted_at IS NULL`,
        [WORKFLOW_TRIGGER.CUSTOMER_BIRTHDAY],
      );

    const result: BirthdaySweepResult = {
      tenants: tenants.length,
      processed: 0,
      emitted: 0,
    };

    for (const tenant of tenants) {
      if (opts.keepAlive && !(await opts.keepAlive())) {
        this.logger.warn('birthday sweep lost its lock — aborting this run');
        break;
      }
      try {
        const clock = localClock(now, tenant.tz || 'UTC');
        if (clock.hour !== BIRTHDAY_SEND_LOCAL_HOUR) continue;
        if (!(await this.isEntitled(tenant.id))) continue;
        result.processed += 1;
        result.emitted += await this.greetTenant(tenant.id, clock);
      } catch (err) {
        // One clinic's failure must not stop the others.
        this.logger.error(
          `birthday sweep failed for tenant ${tenant.id}: ${(err as Error)?.message}`,
        );
      }
    }
    return result;
  }

  private async isEntitled(tenantId: string): Promise<boolean> {
    const decision = await this.access.resolve(
      tenantId,
      FeatureKey.AUTOMATIONS,
    );
    return (
      decision.allowed ||
      !this.access.shouldBlock(decision, {
        surface: 'worker',
        detail: 'workflow.birthdaySweep',
      })
    );
  }

  /** Emits one `customer.birthday` per matching patient; returns how many. */
  private async greetTenant(
    tenantId: string,
    clock: LocalClock,
  ): Promise<number> {
    const occurrenceDate = `${clock.year}-${pad(clock.month)}-${pad(clock.day)}`;
    const includeLeapDay =
      clock.month === 2 && clock.day === 28 && !isLeapYear(clock.year);

    let emitted = 0;
    let after = NIL_UUID;
    for (;;) {
      const rows: Array<{ id: string }> = await this.dataSource.query(
        `SELECT c.id
         FROM customers c
         WHERE c."tenantId" = $1
           AND c.deleted_at IS NULL
           AND c.is_active = true
           AND c.opted_out_at IS NULL
           AND c.date_of_birth IS NOT NULL
           AND COALESCE(BTRIM(c.phone), '') <> ''
           AND (
             (EXTRACT(MONTH FROM c.date_of_birth) = $2
               AND EXTRACT(DAY FROM c.date_of_birth) = $3)
             OR ($4::boolean
               AND EXTRACT(MONTH FROM c.date_of_birth) = 2
               AND EXTRACT(DAY FROM c.date_of_birth) = 29)
           )
           AND c.id > $5
         ORDER BY c.id
         LIMIT $6`,
        [tenantId, clock.month, clock.day, includeLeapDay, after, PAGE_SIZE],
      );
      for (const row of rows) {
        await this.events.emitAsync(
          CUSTOMER_EVENT.BIRTHDAY,
          new CustomerBirthdayEvent(tenantId, row.id, occurrenceDate),
        );
        emitted += 1;
      }
      if (rows.length < PAGE_SIZE) break;
      after = rows[rows.length - 1].id;
    }
    return emitted;
  }
}
