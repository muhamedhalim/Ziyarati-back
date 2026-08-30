import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { InAppNotification } from '../../../entities/Notifications/InAppNotification';
import { NotificationPreference } from '../../../entities/Notifications/NotificationPreference';
import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { User } from '../../../entities/Auth&RBAC/User';

import {
  NOTIFICATION_CATALOG,
  type NotificationEmitContext,
  type NotificationKey,
} from './notification-catalog';
import { NOTIFICATION_SCOPE } from './notification-keys';
import { NotificationRecipientResolver } from './notification-recipient.resolver';

/** What a single `emit` did — returned for tests and logging, never thrown. */
export interface EmitResult {
  readonly key: string;
  /** Users the policy resolved, before preference filtering. */
  readonly resolved: number;
  /** Users a mute removed. */
  readonly suppressed: number;
  /** Rows the database actually accepted (a duplicate emit yields 0). */
  readonly created: number;
  /** Set when the emit failed; the caller is unaffected either way. */
  readonly error?: string;
}

/**
 * Writes internal notifications.
 *
 * ── WHY THIS NEVER THROWS ────────────────────────────────────────────────────
 * Every caller is an `@OnEvent` handler running after a domain transaction has
 * already committed. A ticket reply, an approval, a password change — all are
 * finished and durable before this runs. Letting a notification failure
 * propagate could not undo them; it could only turn a cosmetic problem into a
 * 500 on an operation that already succeeded. So every failure is caught,
 * logged and returned. `internal-notifications-negative.e2e-spec.ts` asserts
 * this by stubbing the repository to throw and checking the ticket reply still
 * returns 2xx.
 *
 * ── WHY THERE IS NO QUEUE ────────────────────────────────────────────────────
 * Emission is one recipient query plus one bulk insert — work measured in
 * milliseconds, with no external call. Routing it through BullMQ would add a
 * Redis dependency to a path that does not need one, and Redis is precisely
 * what already fails silently in the outbound pipeline (a Redis outage there
 * strands notifications with no dispatch and no reap). Writing inline means
 * internal notifications keep working when Redis does not.
 *
 * The accepted cost: a crash between the domain commit and this listener loses
 * the notification. That is deliberate. The authoritative record is the domain
 * data plus `audit_logs`; webhooks and the workflow engine already carry the
 * same exposure. If an internal notification ever becomes contractual, the
 * upgrade path is the existing `outbox_jobs` + `OutboxRelayService`, which is
 * already three-phase, crash-recovering and dedupe-keyed — no redesign needed.
 *
 * ── IDEMPOTENCY ─────────────────────────────────────────────────────────────
 * The spec's `dedupe(ctx)` key plus a partial unique index scoped
 * `(recipient_user_id, dedupe_key)`, inserted with `ON CONFLICT DO NOTHING`.
 * A redelivered webhook, a retried job, or a replayed event writes nothing the
 * second time — enforced by the database, not by a check-then-act read.
 */
@Injectable()
export class InternalNotificationService {
  private readonly logger = new Logger('InternalNotificationService');

  /**
   * Upper bound on recipients for one notification.
   *
   * A guard against a catalog or permission-grant mistake turning one event
   * into an unbounded write inside a request. Truncation is LOGGED, never
   * silent: a capped fan-out that looked like a complete one would be worse
   * than the original bug.
   */
  private readonly maxFanout = Number(
    process.env.INTERNAL_NOTIFICATION_MAX_FANOUT ?? '200',
  );

  constructor(
    @InjectRepository(InAppNotification)
    private readonly notifications: Repository<InAppNotification>,
    @InjectRepository(NotificationPreference)
    private readonly preferences: Repository<NotificationPreference>,
    private readonly recipients: NotificationRecipientResolver,
  ) {}

  /**
   * Creates one notification per eligible recipient.
   *
   * Resolution order: catalog spec → recipients → preference filter → bulk
   * idempotent insert.
   */
  async emit(
    key: NotificationKey,
    ctx: NotificationEmitContext,
  ): Promise<EmitResult> {
    try {
      const spec = NOTIFICATION_CATALOG[key];
      if (!spec) {
        // Unknown key: log and drop. Throwing would punish a domain operation
        // that already succeeded for a catalog authoring mistake.
        this.logger.error(`Unknown notification key "${key}" — dropped`);
        return { key, resolved: 0, suppressed: 0, created: 0, error: 'unknown-key' };
      }

      const tenantId =
        spec.scope === NOTIFICATION_SCOPE.PLATFORM ? null : ctx.tenantId;

      const resolved = await this.recipients.resolve(
        spec.scope,
        tenantId,
        spec.recipients,
        {
          actorUserId: ctx.actorUserId,
          targetUserIds: ctx.targetUserIds,
        },
      );
      if (resolved.length === 0) {
        return { key, resolved: 0, suppressed: 0, created: 0 };
      }

      const eligible = spec.mandatory
        ? resolved
        : await this.dropMuted(
            resolved.map((r) => r.id),
            spec.category,
          ).then((allowed) => resolved.filter((r) => allowed.has(r.id)));

      const suppressed = resolved.length - eligible.length;
      if (eligible.length === 0) {
        return { key, resolved: resolved.length, suppressed, created: 0 };
      }

      const capped = eligible.slice(0, this.maxFanout);
      if (capped.length < eligible.length) {
        this.logger.warn(
          `Fan-out for "${key}" capped at ${this.maxFanout} of ${eligible.length} eligible ` +
            `recipients — ${eligible.length - capped.length} did NOT receive it. ` +
            'Raise INTERNAL_NOTIFICATION_MAX_FANOUT or narrow the recipient policy.',
        );
      }

      const dedupeKey = spec.dedupe(ctx) ?? null;
      const linkUrl = spec.link(ctx) ?? null;
      const entity = spec.entity?.(ctx) ?? null;

      const rows = capped.map((recipient) => ({
        tenant: tenantId ? ({ id: tenantId } as Tenant) : null,
        recipient: { id: recipient.id } as User,
        key,
        category: spec.category,
        priority: spec.priority,
        // Cast the jsonb payload: TypeORM's QueryDeepPartialEntity does not
        // accept an index-signature object with `unknown` values (same reason
        // and same shape as IntegrationIdempotencyService.complete).
        variables: (ctx.variables ?? null) as Record<string, any> | null,
        link_url: linkUrl,
        entity_type: entity?.type ?? null,
        entity_id: entity?.id ?? null,
        dedupe_key: dedupeKey,
      }));

      // `orIgnore()` → `ON CONFLICT DO NOTHING`. The partial unique index on
      // (recipient_user_id, dedupe_key) is what makes a replay a no-op, so
      // concurrent duplicate emits race harmlessly instead of raising 23505.
      const result = await this.notifications
        .createQueryBuilder()
        .insert()
        .into(InAppNotification)
        .values(rows)
        .orIgnore()
        .execute();

      // A row skipped by ON CONFLICT DO NOTHING still occupies a slot in
      // `identifiers`, as an EMPTY object rather than a missing one — so a
      // plain truthiness filter would count every suppressed duplicate as a
      // successful write and report a replay as brand-new work.
      const created = result.identifiers.filter((identifier) =>
        Boolean(identifier?.id),
      ).length;
      this.logger.log(
        `${key}: resolved=${resolved.length} suppressed=${suppressed} created=${created}`,
      );
      return { key, resolved: resolved.length, suppressed, created };
    } catch (err) {
      // See the class docstring: a notification failure must never surface as
      // a failure of the business operation that triggered it.
      const message = (err as Error)?.message ?? 'emit failed';
      this.logger.error(`Failed to emit "${key}": ${message}`);
      return { key, resolved: 0, suppressed: 0, created: 0, error: message };
    }
  }

  /**
   * The subset of `userIds` that has NOT muted `category`.
   *
   * Absence of a preference row means "not muted", so this asks only for the
   * rows that actively mute and subtracts them — a user who has never opened
   * the preferences screen needs no row and is never excluded by a missing one.
   *
   * Only reached for non-mandatory specs; `emit` short-circuits before this for
   * mandatory ones, which is the second of the two independent enforcement
   * points that make a security notification unmutable even if a `muted` row
   * for SECURITY were written directly into the database.
   */
  private async dropMuted(
    userIds: string[],
    category: string,
  ): Promise<Set<string>> {
    const muted = await this.preferences.find({
      where: { user: { id: In(userIds) }, category, muted: true },
      relations: { user: true },
      select: { id: true, user: { id: true } },
    });
    const mutedIds = new Set(muted.map((p) => p.user.id));
    return new Set(userIds.filter((id) => !mutedIds.has(id)));
  }
}
