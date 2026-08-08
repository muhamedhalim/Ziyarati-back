import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { SupportClinicResolver } from './support-clinic.resolver';
import { QuerySupportDiagnosticsDto } from './dto/query-support-diagnostics.dto';
import { SUPPORT_VISIBLE_AUDIT_ACTIONS } from './platform-support.constants';
import { isoOrNull, maskEmail, maskPersonName } from './support-privacy.util';

/**
 * Read-only operational timeline for one clinic, built on the existing
 * `audit_logs` infrastructure.
 *
 * WHY THIS IS AN ALLOW-LIST, NOT A FILTER. `audit_logs.action` is an open
 * string written by dozens of services, and `old_values`/`new_values` are
 * unconstrained JSONB — a payment gateway's config diff, a role change, a
 * customer record. A denylist ("everything except X") would silently start
 * disclosing whatever the next service decides to record. So only actions
 * named in `SUPPORT_VISIBLE_AUDIT_ACTIONS` appear at all, and the raw JSONB
 * NEVER leaves this service.
 *
 * What replaces the raw payload is a `changedFields` list — the KEY NAMES that
 * differ between before and after. That is genuinely what a support agent
 * needs ("the subscription's plan_id and ends_at changed at 14:02") without
 * disclosing the values, which is where secrets and personal data live.
 */
@Injectable()
export class SupportActivityService {
  constructor(
    private readonly clinics: SupportClinicResolver,
    private readonly dataSource: DataSource,
  ) {}

  async timeline(tenantId: string, query: QuerySupportDiagnosticsDto) {
    await this.clinics.assertExists(tenantId);

    const params = [tenantId, query.since(), [...SUPPORT_VISIBLE_AUDIT_ACTIONS]];
    const where = `al."tenantId" = $1 AND al.created_at >= $2 AND al.action = ANY($3)`;

    const [[countRow], rows] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total FROM audit_logs al WHERE ${where}`,
        params,
      ),
      this.dataSource.query(
        `
        SELECT al.id, al.action, al.entity_type, al.entity_id, al.created_at,
               al.old_values, al.new_values,
               u.full_name AS actor_name, u.email AS actor_email,
               (u."tenantId" IS NULL) AS actor_is_platform
          FROM audit_logs al
          LEFT JOIN users u ON u.id = al."userId"
         WHERE ${where}
         ORDER BY al.created_at DESC
         LIMIT $4 OFFSET $5
        `,
        [...params, query.limit, query.offset()],
      ),
    ]);

    return {
      data: rows.map((r: AuditRow) => ({
        id: r.id,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id ?? null,
        createdAt: isoOrNull(r.created_at),
        actor: r.actor_name || r.actor_email
          ? {
              // A platform employee acting on the clinic is shown in full —
              // accountability runs the other way there, and the clinic's own
              // ticket timeline already names them. A clinic's own staff are
              // masked: Support is diagnosing a system, not auditing people.
              name: r.actor_is_platform ? r.actor_name : maskPersonName(r.actor_name),
              email: r.actor_is_platform ? r.actor_email : maskEmail(r.actor_email),
              isPlatformActor: !!r.actor_is_platform,
            }
          : { name: null, email: null, isPlatformActor: false },
        /** Key names only — never the before/after VALUES. */
        changedFields: this.changedFields(r.old_values, r.new_values),
      })),
      total: countRow?.total ?? 0,
      page: query.page,
      limit: query.limit,
      windowDays: query.days,
    };
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * Union of the top-level keys present in either payload. Values are never
   * compared, read or emitted — only key names, and only at depth 1, so a
   * nested credential cannot surface even as a key path.
   */
  private changedFields(
    before?: Record<string, unknown> | null,
    after?: Record<string, unknown> | null,
  ): string[] {
    const keys = new Set<string>();
    for (const key of Object.keys(before ?? {})) keys.add(key);
    for (const key of Object.keys(after ?? {})) keys.add(key);
    return [...keys].sort();
  }
}

interface AuditRow {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  created_at: Date;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  actor_name: string | null;
  actor_email: string | null;
  actor_is_platform: boolean | null;
}
