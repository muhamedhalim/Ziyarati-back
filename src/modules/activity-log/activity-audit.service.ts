import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { User } from '../../entities/Auth&RBAC/User';
import { Branch } from '../../entities/SaaS-Core/Branch';

import { ACTIVITY_ENTITY_LABEL_MAX } from './activity-log.constants';

/**
 * The single INSERT path for clinic-wide activity written to `audit_logs`.
 *
 * This is NOT a second audit mechanism: `audit_logs` remains the one
 * canonical administrative audit stream (the domain history tables —
 * `appointment_history`, `appointment_status_logs`, `clinical_access_logs` —
 * stay specialised and are untouched). What this service adds is one place
 * where the CONTEXT fields introduced alongside the Activity surface
 * (`branchId`, `entity_label`, the authenticated actor) are handled
 * consistently, so a module adding an audited action later has one obvious
 * thing to call rather than a twelfth hand-rolled `auditLogs.save(...)`.
 *
 * It lives in `activity-log/` on purpose — the writer and the allow-list that
 * decides what is ever surfaced (`activity-allowlist.ts`) belong together, so
 * adding an action and forgetting to make it visible stays a one-file review.
 *
 * The pre-existing per-domain audit services (`CampaignAuditService`,
 * `InvoiceAuditService`, `ApiKeyAuditService`, …) are deliberately left
 * exactly as they are. `AppointmentAuditService` delegates here rather than
 * duplicating the INSERT, because it needed the new context fields anyway.
 *
 * ── The rules every caller must honour ──────────────────────────────────
 *
 * MEANINGFUL ACTIONS ONLY. Record deliberate administrative or operational
 * actions a human or an automated actor took. Never record reads, queries,
 * list renders, cache warms, health checks or other technical operations —
 * a noisy audit log is an unusable one. (High-volume clinical READS have
 * their own dedicated table, `clinical_access_logs`, precisely so they never
 * reach here.)
 *
 * AFTER THE FACT, NEVER INSIDE THE TRANSACTION. Call this once the business
 * operation has actually succeeded and committed. Every write here is
 * best-effort: it can never turn a successful appointment into a failed one.
 * A failure is logged at `error` with a stable, greppable marker so a
 * persistently failing audit path stays observable rather than silent.
 *
 * SAFE METADATA ONLY. `before`/`after` are for small, structured, factual
 * fields (ids, statuses, timestamps). NEVER passwords, tokens, payment
 * secrets, national IDs, patient contact details, clinical content, or a raw
 * request body. `entity_label` is subject to the same rule and is truncated
 * defensively so it cannot become a smuggling channel. The Activity read
 * projection only ever surfaces the KEY NAMES of `before`/`after`
 * (FR-U008) — but the values still sit in the database, so keeping them
 * clean at the writer is what actually protects them.
 *
 * THE ACTOR IS THE AUTHENTICATED PRINCIPAL. `actorUserId` must be the user
 * who performed the action — never the target, the record's owner, or
 * anything read out of a request body. Omit it only when there genuinely is
 * no acting user (a patient acting on a signed link, a scheduled worker), in
 * which case the row is correctly rendered as a system action.
 */
@Injectable()
export class ActivityAuditService {
  private readonly logger = new Logger(ActivityAuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  async record(entry: ActivityAuditEntry): Promise<void> {
    try {
      await this.auditLogs.save(
        this.auditLogs.create({
          tenant: { id: entry.tenantId } as Tenant,
          user: entry.actorUserId
            ? ({ id: entry.actorUserId } as User)
            : undefined,
          branch: entry.branchId
            ? ({ id: entry.branchId } as Branch)
            : undefined,
          action: entry.action,
          entity_type: entry.entityType,
          entity_id: entry.entityId ?? undefined,
          entity_label: truncateLabel(entry.entityLabel),
          old_values: entry.before ?? undefined,
          new_values: entry.after ?? undefined,
        }),
      );
    } catch (err) {
      // `error`, not `warn`: an action this fails to record is an action with
      // no accountability trail, which is exactly what the Activity log
      // exists to prevent. Same reasoning as ClinicalAccessLogService.
      // The stable `[activity-audit] write failed` prefix is what makes this
      // alertable; the message never carries the metadata itself.
      this.logger.error(
        `[activity-audit] write failed (action=${entry.action}, ` +
          `tenant=${entry.tenantId}, entity=${entry.entityType}:${entry.entityId ?? '-'}): ` +
          `${(err as Error)?.message}`,
      );
    }
  }
}

export interface ActivityAuditEntry {
  tenantId: string;
  /** Machine-readable, dotted, additive-only. Must also be added to
   *  `ACTIVITY_VISIBLE_AUDIT_ACTIONS` to ever be surfaced. */
  action: string;
  entityType: string;
  entityId?: string | null;
  /** The AUTHENTICATED actor. Omit only for genuinely actor-less actions. */
  actorUserId?: string | null;
  /** The branch the action happened at, when it has one. */
  branchId?: string | null;
  /** Short, non-sensitive human label — see the class docblock's rules. */
  entityLabel?: string | null;
  /** Small, structured, non-sensitive prior state (update actions only). */
  before?: Record<string, unknown> | null;
  /** Small, structured, non-sensitive resulting state. */
  after?: Record<string, unknown> | null;
}

/** Defence in depth against a call site passing something unexpectedly long —
 *  the column is `varchar(160)`, and a silent database truncation error would
 *  fail the (best-effort) audit write rather than shorten the label. */
function truncateLabel(label?: string | null): string | undefined {
  const trimmed = label?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > ACTIVITY_ENTITY_LABEL_MAX
    ? trimmed.slice(0, ACTIVITY_ENTITY_LABEL_MAX)
    : trimmed;
}
