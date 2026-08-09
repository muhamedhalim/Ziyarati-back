import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { WhatsappTemplate } from '../../../entities/WhatsApp/WhatsappTemplate';
import { WhatsappAccount } from '../../../entities/WhatsApp/WhatsappAccount';
import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../../common/errors';

import { MetaGraphClient, MetaTemplate } from './meta-graph.client';
import { WhatsappAccountResolver } from '../routing/whatsapp-account.resolver';
import { WhatsappTemplateStatus } from '../whatsapp.constants';
import { mapMetaTemplateStatus } from '../template-status.util';

export interface TemplateSyncResult {
  wabaId: string;
  fetched: number;
  created: number;
  updated: number;
  syncedAt: Date;
}

/**
 * Reconciles local `whatsapp_templates` with Meta.
 *
 * Templates are Meta's data, not ours: Meta owns creation, review and approval,
 * and a business-initiated message can only use a template Meta has APPROVED.
 * Local rows are therefore a MIRROR, and Meta always wins on conflict — a
 * locally-stored "approved" that Meta has since rejected is exactly the state
 * that causes silent campaign failure, so sync overwrites rather than merges.
 *
 * Identity is `provider_template_id` (Meta's id), not (name, language): a
 * template can be renamed in Meta, and matching on name would create a
 * duplicate. Rows are matched on the provider id first and only fall back to
 * (tenant, name, language) to adopt pre-sync local rows into the mirror — which
 * is also what keeps the existing UNIQUE(tenant, name, language) satisfiable.
 *
 * Tenant isolation: the WABA is always read from a tenant-scoped account, and
 * every write stamps the tenant. A tenant can only ever sync its own WABA.
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

    const remote = await this.graph.listTemplates(resolved.wabaId, resolved.accessToken);
    const syncedAt = new Date();

    let created = 0;
    let updated = 0;
    for (const template of remote) {
      const outcome = await this.upsert(tenantId, resolved.id, resolved.wabaId, template, syncedAt);
      if (outcome === 'created') created++;
      else updated++;
    }

    // Stamp the account so the UI can show "last synced" without scanning rows.
    await this.accounts.update({ id: resolved.id }, { last_synced_at: syncedAt });

    this.logger.log(
      `Tenant ${tenantId} synced ${remote.length} template(s) from waba=${resolved.wabaId} ` +
        `(created=${created}, updated=${updated})`,
    );
    return { wabaId: resolved.wabaId, fetched: remote.length, created, updated, syncedAt };
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

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private async upsert(
    tenantId: string,
    accountId: string,
    wabaId: string,
    remote: MetaTemplate,
    syncedAt: Date,
  ): Promise<'created' | 'updated'> {
    const existing = await this.findLocal(tenantId, remote);

    const row = existing ?? this.templates.create({ tenant: { id: tenantId } as Tenant });
    const isNew = !existing;

    row.provider_template_id = remote.id;
    row.waba_id = wabaId;
    row.whatsapp_account = { id: accountId } as WhatsappAccount;
    row.name = remote.name;
    row.language = remote.language;
    row.category = remote.category;
    row.components = this.normalizeComponents(remote.components);
    row.status = this.mapStatus(remote.status);
    row.rejected_reason = remote.rejectedReason;
    row.last_synced_at = syncedAt;

    await this.templates.save(row);
    return isNew ? 'created' : 'updated';
  }

  /**
   * Match on Meta's id first (survives renames); fall back to
   * (tenant, name, language) to adopt a pre-sync local row instead of colliding
   * with its UNIQUE constraint.
   */
  private async findLocal(
    tenantId: string,
    remote: MetaTemplate,
  ): Promise<WhatsappTemplate | null> {
    const byProviderId = await this.templates.findOne({
      where: {
        tenant: { id: tenantId },
        provider_template_id: remote.id,
        deleted_at: IsNull(),
      },
    });
    if (byProviderId) return byProviderId;

    return this.templates.findOne({
      where: {
        tenant: { id: tenantId },
        name: remote.name,
        language: remote.language,
        deleted_at: IsNull(),
      },
    });
  }

  /**
   * Meta's statuses → our local vocabulary. The mapping itself lives in
   * `template-status.util.ts` because the create-on-Meta path learns a status
   * from exactly the same source and must agree with this one; only the
   * logging of an unrecognised value is this service's own concern.
   */
  private mapStatus(metaStatus: string): WhatsappTemplateStatus {
    return mapMetaTemplateStatus(metaStatus, (unknown) =>
      this.logger.warn(
        `Unknown Meta template status "${unknown}" — treating as pending (not sendable)`,
      ),
    );
  }

  /**
   * `components` is a jsonb column typed as an object, but Meta sends an array.
   * Wrap it so the stored shape stays stable and readable rather than depending
   * on how the driver serializes a bare array.
   */
  private normalizeComponents(components: unknown): Record<string, unknown> | undefined {
    if (components === null || components === undefined) return undefined;
    return Array.isArray(components)
      ? { components }
      : (components as Record<string, unknown>);
  }
}
