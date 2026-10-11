import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Not, Repository } from 'typeorm';

import { WhatsappTemplate } from '../../../entities/WhatsApp/WhatsappTemplate';
import { WhatsappAccount } from '../../../entities/WhatsApp/WhatsappAccount';
import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../../common/errors';

import { MetaGraphClient, MetaTemplate } from './meta-graph.client';
import { WhatsappAccountResolver } from '../routing/whatsapp-account.resolver';
import {
  TEMPLATE_EVENTS_WITHOUT_STATUS_CHANGE,
  mapMetaTemplateStatus,
  normalizeRejectionReason,
} from '../template-status.util';
import { applyRemoteTemplate } from '../template-mirror.util';

export interface TemplateSyncResult {
  wabaId: string;
  fetched: number;
  created: number;
  updated: number;
  /** Mirror rows that no longer exist on Meta and were removed. */
  removed: number;
  /** Templates Meta returned that could not be written (logged, not fatal). */
  failed: number;
  syncedAt: Date;
}

/**
 * The slice of a `message_template_status_update` / `template_category_update`
 * webhook change this service needs. `eventTime` is `entry.time` (Unix
 * seconds) — inside the HMAC-signed body, so authenticated.
 */
export interface TemplateWebhookEvent {
  field: 'message_template_status_update' | 'template_category_update';
  wabaId: string;
  templateId: string;
  eventTime: number;
  event?: string;
  reason?: string | null;
  rejectionRecommendation?: string;
  category?: string;
  /** `template_category_update` only: a scheduled, not-yet-applied change. */
  impendingCategoryChange?: boolean;
}

export type TemplateWebhookOutcome =
  | { applied: true; rows: number }
  | { applied: false; reason: 'unknown-template' | 'stale' | 'no-status-change' | 'ignored' };

/**
 * Reconciles local `whatsapp_templates` with Meta.
 *
 * Templates are Meta's data, not ours: Meta owns creation, review and approval,
 * and a business-initiated message can only use a template Meta has APPROVED.
 * Local rows are therefore a MIRROR, and Meta always wins on conflict — a
 * locally-stored "approved" that Meta has since rejected is exactly the state
 * that causes silent campaign failure, so sync overwrites rather than merges.
 *
 * Three ways a verdict reaches the mirror, all through the same write helper:
 *   1. `syncAccount`        — full pull of the WABA (manual + after onboarding);
 *   2. `TemplateService.refresh` — one template on demand;
 *   3. `applyWebhookEvent`  — Meta's push, the fast path.
 * Webhooks can be late, duplicated or out of order, and a pull can overlap
 * one, so every writer is ordered by time (see `last_synced_at` below) rather
 * than by arrival.
 *
 * Identity is `provider_template_id` (Meta's id), not (name, language): a
 * template can be renamed in Meta, and matching on name would create a
 * duplicate. Rows are matched on the provider id first and only fall back to
 * (tenant, name, language) to adopt pre-sync local rows into the mirror — which
 * is also what keeps the existing UNIQUE(tenant, name, language) satisfiable.
 *
 * Tenant isolation: the WABA is always read from a tenant-scoped account, and
 * every write stamps the tenant. A tenant can only ever sync its own WABA. The
 * webhook path resolves rows by (waba_id, provider_template_id) — both must
 * match, and only rows that already exist are touched; an event can never
 * create or move a template.
 */
@Injectable()
export class WhatsappTemplateSyncService {
  private readonly logger = new Logger('WhatsappTemplateSyncService');

  constructor(
    @InjectRepository(WhatsappTemplate)
    private readonly templates: Repository<WhatsappTemplate>,
    @InjectRepository(WhatsappAccount)
    private readonly accounts: Repository<WhatsappAccount>,
    private readonly graph: MetaGraphClient,
    private readonly resolver: WhatsappAccountResolver,
  ) {}

  /**
   * Syncs every template on the WABA behind `accountId` (or the tenant's
   * default account when omitted).
   */
  async syncAccount(tenantId: string, accountId?: string): Promise<TemplateSyncResult> {
    // Reuse the resolver so credentials are decrypted in exactly one place and
    // the same active/expired rules apply as on the send path.
    const resolved = accountId
      ? await this.resolver.byId(tenantId, accountId)
      : await this.resolver.forTenant(tenantId);

    if (!resolved.wabaId || !resolved.accessToken) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'This WhatsApp account has no connected WhatsApp Business Account to sync.',
      });
    }

    // Taken BEFORE the fetch: anything written after this instant (a webhook
    // landing mid-sync, a template created while we paged) is newer than the
    // snapshot we are about to apply and must not be overwritten by it.
    const startedAt = new Date();
    const remote = await this.graph.listTemplates(resolved.wabaId, resolved.accessToken);
    const syncedAt = new Date();

    let created = 0;
    let updated = 0;
    let failed = 0;
    for (const template of remote) {
      try {
        const outcome = await this.upsert(
          tenantId,
          resolved.id,
          resolved.wabaId,
          template,
          syncedAt,
          startedAt,
        );
        if (outcome === 'created') created++;
        else if (outcome === 'updated') updated++;
      } catch (err) {
        // One malformed template must not abort the whole reconciliation —
        // every other template's status would stay stale because of it.
        failed++;
        this.logger.warn(
          `Template sync could not write meta id ${template.id} for tenant ${tenantId}: ${(err as Error)?.message}`,
        );
      }
    }

    // Only a COMPLETE, fully-written pull may prune: `listTemplates` throws
    // rather than truncate, and a partial write (failed > 0) is not a basis
    // for declaring anything missing.
    const removed =
      failed === 0
        ? await this.pruneMissing(tenantId, resolved.wabaId, remote, startedAt)
        : 0;

    // Stamp the account so the UI can show "last synced" without scanning rows.
    await this.accounts.update({ id: resolved.id }, { last_synced_at: syncedAt });

    this.logger.log(
      `Tenant ${tenantId} synced ${remote.length} template(s) from waba=${resolved.wabaId} ` +
        `(created=${created}, updated=${updated}, removed=${removed}, failed=${failed})`,
    );
    return {
      wabaId: resolved.wabaId,
      fetched: remote.length,
      created,
      updated,
      removed,
      failed,
      syncedAt,
    };
  }

  /**
   * Best-effort sync used right after onboarding. A template-sync failure must
   * NOT fail the connection — the clinic is connected either way and can retry
   * from the UI, so this logs and swallows.
   */
  async syncAfterOnboarding(tenantId: string, accountId: string): Promise<void> {
    try {
      await this.syncAccount(tenantId, accountId);
    } catch (err) {
      this.logger.warn(
        `Post-onboarding template sync failed for tenant ${tenantId} (connection is still valid): ${(err as Error)?.message}`,
      );
    }
  }

  // ─────────────────────────────── Webhook ─────────────────────────────────── //

  /**
   * Which tenants own a template a webhook is about. Used to attribute the
   * stored event row (the payload carries a WABA and a template id, no phone
   * number, so the usual `phone_number_id` → account route cannot resolve it).
   * Both must match; an unknown pair resolves to nobody.
   */
  async tenantsForTemplate(wabaId: string, templateId: string): Promise<string[]> {
    const rows = await this.templates.find({
      where: { waba_id: wabaId, provider_template_id: templateId, deleted_at: IsNull() },
      relations: { tenant: true },
      select: { id: true, tenant: { id: true } },
    });
    return [...new Set(rows.map((r) => r.tenant?.id).filter((t): t is string => !!t))];
  }

  /**
   * Applies one Meta template webhook change to the mirror.
   *
   * Ordering. Meta may deliver late, twice, or out of order, and a pull may
   * race a push. Every write is therefore guarded IN THE UPDATE STATEMENT by
   * `last_synced_at` — a row is only changed when the event is not older than
   * what it already reflects, and the row's `last_synced_at` is moved to the
   * event time. Consequences:
   *   - a duplicate is a no-op (same status written again);
   *   - APPROVED arriving before the earlier PENDING leaves APPROVED in place;
   *   - a pull that already saw the newer state is not regressed by a late event.
   * Comparison is at second resolution (Meta's `time` is Unix seconds): an
   * event stamped in the same second as the row is applied, since a no-op
   * rewrite is harmless and dropping a real one is not.
   */
  async applyWebhookEvent(ev: TemplateWebhookEvent): Promise<TemplateWebhookOutcome> {
    const rows = await this.templates.find({
      where: { waba_id: ev.wabaId, provider_template_id: ev.templateId, deleted_at: IsNull() },
    });
    if (rows.length === 0) return { applied: false, reason: 'unknown-template' };

    const at = new Date(ev.eventTime * 1000);
    // Strictly-before-the-NEXT-second keeps same-second events applicable.
    const notNewerThan = new Date((ev.eventTime + 1) * 1000);

    if (ev.field === 'template_category_update') {
      if (ev.impendingCategoryChange || !ev.category) return { applied: false, reason: 'ignored' };
      const res = await this.guardedUpdate(rows, notNewerThan, {
        category: ev.category,
        last_synced_at: at,
      });
      return res > 0 ? { applied: true, rows: res } : { applied: false, reason: 'stale' };
    }

    const event = ev.event?.toUpperCase();
    if (!event) return { applied: false, reason: 'ignored' };

    if (event === 'DELETED') {
      let removed = 0;
      for (const row of rows) {
        const newer =
          row.last_synced_at && new Date(row.last_synced_at).getTime() >= notNewerThan.getTime();
        if (newer) continue;
        await this.templates.softRemove(row);
        removed++;
      }
      return removed > 0 ? { applied: true, rows: removed } : { applied: false, reason: 'stale' };
    }

    if (TEMPLATE_EVENTS_WITHOUT_STATUS_CHANGE.has(event)) {
      return { applied: false, reason: 'no-status-change' };
    }

    const status = mapMetaTemplateStatus(event, (unknown) =>
      this.logger.warn(
        `Unknown Meta template event "${unknown}" — treating as pending (not sendable)`,
      ),
    );
    const base = normalizeRejectionReason(ev.reason);
    const reason =
      base && ev.rejectionRecommendation
        ? `${base}: ${ev.rejectionRecommendation}`
        : base;

    const res = await this.guardedUpdate(rows, notNewerThan, {
      status,
      rejected_reason: (reason ?? null) as unknown as string,
      ...(ev.category ? { category: ev.category } : {}),
      last_synced_at: at,
    });
    if (res === 0) return { applied: false, reason: 'stale' };
    this.logger.log(
      `Template ${ev.templateId} on waba=${ev.wabaId} → ${status} (webhook event ${event})`,
    );
    return { applied: true, rows: res };
  }

  private async guardedUpdate(
    rows: WhatsappTemplate[],
    notNewerThan: Date,
    patch: Partial<WhatsappTemplate>,
  ): Promise<number> {
    const result = await this.templates
      .createQueryBuilder()
      .update(WhatsappTemplate)
      .set(patch as never)
      .where('id IN (:...ids)', { ids: rows.map((r) => r.id) })
      .andWhere('(last_synced_at IS NULL OR last_synced_at < :bound)', { bound: notNewerThan })
      .execute();
    return result.affected ?? 0;
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private async upsert(
    tenantId: string,
    accountId: string,
    wabaId: string,
    remote: MetaTemplate,
    syncedAt: Date,
    startedAt: Date,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const existing = await this.findLocal(tenantId, remote);

    // Something wrote this row (a webhook, a refresh) AFTER our snapshot began:
    // the snapshot is the older of the two, so it must not win.
    if (
      existing?.last_synced_at &&
      new Date(existing.last_synced_at).getTime() > startedAt.getTime()
    ) {
      return 'skipped';
    }

    const row = existing ?? this.templates.create({ tenant: { id: tenantId } as Tenant });
    const isNew = !existing;

    // Revives a tombstone (a row removed locally while the template still
    // exists on Meta) instead of colliding with its unique key.
    row.deleted_at = null as unknown as undefined;
    row.waba_id = wabaId;
    row.whatsapp_account = { id: accountId } as WhatsappAccount;
    applyRemoteTemplate(row, remote, syncedAt, (unknown) =>
      this.logger.warn(
        `Unknown Meta template status "${unknown}" — treating as pending (not sendable)`,
      ),
    );

    await this.templates.save(row);
    return isNew ? 'created' : 'updated';
  }

  /**
   * Match on Meta's id first (survives renames); fall back to
   * (tenant, name, language) to adopt a pre-sync local row instead of colliding
   * with its UNIQUE constraint. Soft-deleted rows are INCLUDED — the unique key
   * covers them, so a tombstone is the row to reuse, not a reason to insert.
   */
  private async findLocal(
    tenantId: string,
    remote: MetaTemplate,
  ): Promise<WhatsappTemplate | null> {
    const byProviderId = await this.templates.findOne({
      where: { tenant: { id: tenantId }, provider_template_id: remote.id },
      withDeleted: true,
    });
    if (byProviderId) return byProviderId;

    return this.templates.findOne({
      where: { tenant: { id: tenantId }, name: remote.name, language: remote.language },
      withDeleted: true,
    });
  }

  /**
   * A template that Meta no longer lists does not exist: sending it would be
   * refused, and showing it "approved" is a lie. Rows are removed (soft) rather
   * than flagged — there is nothing left to refresh them from.
   *
   * Scope is deliberately narrow: this tenant, THIS WABA, rows that came from
   * Meta (have a provider id), and rows older than the snapshot (a template
   * created while the sync was paging is not "missing", it is newer).
   */
  private async pruneMissing(
    tenantId: string,
    wabaId: string,
    remote: MetaTemplate[],
    startedAt: Date,
  ): Promise<number> {
    const remoteIds = remote.map((t) => t.id);
    const stale = await this.templates.find({
      where: {
        tenant: { id: tenantId },
        waba_id: wabaId,
        provider_template_id: remoteIds.length > 0 ? Not(In(remoteIds)) : Not(IsNull()),
        deleted_at: IsNull(),
        created_at: LessThan(startedAt),
      },
    });
    const gone = stale.filter(
      (r) => !r.last_synced_at || new Date(r.last_synced_at).getTime() <= startedAt.getTime(),
    );
    for (const row of gone) await this.templates.softRemove(row);
    return gone.length;
  }
}
