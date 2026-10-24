import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';

import { AppError, ErrorCode } from '../../../common/errors';
import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { WhatsappAccount } from '../../../entities/WhatsApp/WhatsappAccount';
import { WhatsappTemplate } from '../../../entities/WhatsApp/WhatsappTemplate';
import { ActivityAuditService } from '../../activity-log/activity-audit.service';
import { normalizeE164 } from '../template-components.util';
import {
  orderedBodyParameters,
  urlButtonParameters,
} from '../template-variables.util';
import {
  WhatsappTemplateService,
  WhatsappTemplateView,
} from '../whatsapp-template.service';
import {
  WHATSAPP_CONNECTION_STATUS,
  WHATSAPP_TEMPLATE_AUDIT_ACTION,
  WHATSAPP_TEMPLATE_STATUS,
} from '../whatsapp.constants';
import { AdoptLibraryTemplateDto } from '../dto/adopt-library-template.dto';
import {
  APP_URL_TOKEN,
  buildLibraryComponents,
  findLibraryTemplate,
  LibraryInstallValues,
  LibraryTemplateDef,
  TEMPLATE_LIBRARY,
} from './template-library.catalog';

const PG_UNIQUE_VIOLATION = '23505';

/** One catalog entry as the API shows it, with the clinic's copy (if any) attached. */
export interface LibraryEntryView {
  key: string;
  version: number;
  name: string;
  language: string;
  /** What we propose. Meta decides; the adopted copy's `category` is Meta's answer. */
  proposed_category: string;
  category_rationale: string;
  purpose_key: string;
  body: string;
  body_examples: string[];
  footer: string | null;
  buttons: Array<{ type: string; text: string }>;
  /** Placeholder → default data source (a missing key = the clinic must choose). */
  variables: Array<{ placeholder: string; source: string | null }>;
  /** The clinic's own copy, or `null` while it has not been adopted. */
  adopted: WhatsappTemplateView | null;
  /** A newer catalog version exists than the one the copy was taken from. */
  update_available: boolean;
  /** Another (non-library) template already uses this name — adoption would collide. */
  name_conflict: boolean;
}

/**
 * The WhatsApp template library: adoption of the versioned catalog
 * (`template-library.catalog.ts`) into a clinic's own draft templates.
 *
 * What this guarantees:
 *  - NOTHING is sent to Meta here. Adoption creates a local `draft`; submitting
 *    is a separate, explicit, per-template action (`WhatsappTemplateService.submit`).
 *  - Idempotent: a clinic holds at most one live row per catalog entry
 *    (partial unique index), so a double click or two instances racing converge
 *    on one row.
 *  - A catalog revision never overwrites a clinic's edits: it is OFFERED
 *    (`update_available`) and only applied on an explicit request, and only to a
 *    draft that has not been submitted.
 *  - Tenant isolation: every query is scoped by the tenant from the request
 *    context; an account id from the client is re-validated against that tenant.
 */
@Injectable()
export class WhatsappTemplateLibraryService {
  private readonly logger = new Logger('WhatsappTemplateLibraryService');

  constructor(
    @InjectRepository(WhatsappTemplate)
    private readonly templates: Repository<WhatsappTemplate>,
    @InjectRepository(WhatsappAccount)
    private readonly accounts: Repository<WhatsappAccount>,
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
    private readonly templateService: WhatsappTemplateService,
    private readonly config: ConfigService,
    private readonly audit: ActivityAuditService,
  ) {}

  async list(tenantId: string): Promise<LibraryEntryView[]> {
    const adoptedRows = await this.templates.find({
      where: { tenant: { id: tenantId }, library_key: Not(IsNull()) },
      relations: { whatsapp_account: true },
    });
    const byKey = new Map(adoptedRows.map((r) => [r.library_key as string, r]));

    // Names already taken by templates that are NOT library copies.
    const clashing = await this.templates.find({
      where: {
        tenant: { id: tenantId },
        name: In(TEMPLATE_LIBRARY.map((d) => d.name)),
        library_key: IsNull(),
      },
      select: { id: true, name: true, language: true },
    });
    const clashingNames = new Set(
      clashing.map((r) => `${r.name}|${r.language}`),
    );

    return TEMPLATE_LIBRARY.map((def) => {
      const row = byKey.get(def.key);
      return {
        key: def.key,
        version: def.version,
        name: def.name,
        language: def.language,
        proposed_category: def.proposedCategory,
        category_rationale: def.categoryRationale,
        purpose_key: def.purposeKey,
        body: def.body,
        body_examples: def.bodyExamples,
        footer: def.footer ?? null,
        buttons: def.buttons.map((b) => ({ type: b.type, text: b.text })),
        variables: this.variablesOf(def),
        adopted: row ? this.templateService.toView(row) : null,
        update_available: !!row && (row.library_version ?? 0) < def.version,
        name_conflict: !row && clashingNames.has(`${def.name}|${def.language}`),
      };
    });
  }

  /**
   * Copies a catalog entry into the clinic's templates as a DRAFT. Idempotent:
   * adopting again returns the existing copy untouched.
   */
  async adopt(
    tenantId: string,
    key: string,
    dto: AdoptLibraryTemplateDto,
    actorUserId?: string,
  ): Promise<{ template: WhatsappTemplateView; created: boolean }> {
    const def = this.requireDef(key);

    const existing = await this.findByKey(tenantId, key);
    if (existing)
      return {
        template: this.templateService.toView(existing),
        created: false,
      };

    const account = await this.pickAccount(tenantId, dto.accountId);

    // The unique key (tenant, name, language) also covers soft-deleted rows.
    const sameName = await this.templates.findOne({
      where: {
        tenant: { id: tenantId },
        name: def.name,
        language: def.language,
      },
      withDeleted: true,
      relations: { whatsapp_account: true },
    });
    if (sameName && !sameName.deleted_at) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `A template named "${def.name}" already exists. Rename or delete it to adopt this one.`,
        publicContext: { reason: 'NAME_CONFLICT', name: def.name },
      });
    }

    const values = await this.installValues(tenantId, account, dto);
    const row =
      sameName ?? this.templates.create({ tenant: { id: tenantId } as Tenant });
    this.applyDefinition(row, def, values);
    row.deleted_at = null as unknown as undefined;
    row.whatsapp_account = account
      ? ({ id: account.id } as WhatsappAccount)
      : undefined;
    // A local draft: no Meta id, no WABA, no verdict. Never sendable.
    row.provider_template_id = null as unknown as undefined;
    row.waba_id = null as unknown as undefined;
    row.rejected_reason = null as unknown as undefined;
    row.last_synced_at = null as unknown as undefined;
    row.status = WHATSAPP_TEMPLATE_STATUS.DRAFT;
    row.variable_mapping = { ...def.defaultMapping };

    let saved: WhatsappTemplate;
    try {
      saved = await this.templates.save(row);
    } catch (err) {
      if ((err as { code?: string })?.code === PG_UNIQUE_VIOLATION) {
        // Another request adopted the same entry between our check and our insert.
        const winner = await this.findByKey(tenantId, key);
        if (winner)
          return {
            template: this.templateService.toView(winner),
            created: false,
          };
      }
      throw err;
    }

    await this.audit.record({
      tenantId,
      action: WHATSAPP_TEMPLATE_AUDIT_ACTION.LIBRARY_ADOPTED,
      entityType: 'whatsapp_template',
      entityId: saved.id,
      entityLabel: saved.name,
      actorUserId,
      after: { libraryKey: key, version: def.version, status: saved.status },
    });
    this.logger.log(
      `Tenant ${tenantId} adopted library template "${key}" v${def.version} as a draft`,
    );

    return {
      template: await this.templateService.findOneView(tenantId, saved.id),
      created: true,
    };
  }

  /**
   * Re-copies the CURRENT catalog revision onto an adopted DRAFT.
   *
   * Explicit and limited on purpose: it replaces the draft's text, so it runs only
   * when the owner asks, and only while nothing has been submitted (a submitted
   * template is Meta's — to change it, edit and resubmit). Install-time values the
   * clinic already filled in (phone, offer link) are carried over, not asked for
   * again.
   */
  async applyUpdate(
    tenantId: string,
    key: string,
    actorUserId?: string,
  ): Promise<WhatsappTemplateView> {
    const def = this.requireDef(key);
    const row = await this.findByKey(tenantId, key);
    if (!row) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'This library template was not adopted.',
      });
    }
    if (
      row.status !== WHATSAPP_TEMPLATE_STATUS.DRAFT ||
      row.provider_template_id
    ) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'Only a draft that has not been submitted can take a library update. Edit and resubmit the template instead.',
        publicContext: { reason: 'NOT_A_DRAFT', templateStatus: row.status },
      });
    }
    if ((row.library_version ?? 0) >= def.version) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'This template is already on the latest library version.',
        publicContext: { reason: 'ALREADY_CURRENT' },
      });
    }

    const previous = this.carriedValues(row);
    const account = row.whatsapp_account as WhatsappAccount | undefined;
    const values = await this.installValues(
      tenantId,
      account ?? null,
      previous,
    );
    const fromVersion = row.library_version ?? null;
    this.applyDefinition(row, def, values);
    // Keep what the clinic bound; add the catalog's defaults only for placeholders
    // that have no binding yet.
    row.variable_mapping = {
      ...def.defaultMapping,
      ...(row.variable_mapping ?? {}),
    };
    await this.templates.save(row);

    await this.audit.record({
      tenantId,
      action: WHATSAPP_TEMPLATE_AUDIT_ACTION.LIBRARY_UPDATED,
      entityType: 'whatsapp_template',
      entityId: row.id,
      entityLabel: row.name,
      actorUserId,
      before: { version: fromVersion },
      after: { libraryKey: key, version: def.version },
    });
    return this.templateService.findOneView(tenantId, row.id);
  }

  // ───────────────────────────────── internals ───────────────────────────────── //

  private requireDef(key: string): LibraryTemplateDef {
    const def = findLibraryTemplate(key);
    if (!def)
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Unknown library template',
      });
    return def;
  }

  private findByKey(
    tenantId: string,
    key: string,
  ): Promise<WhatsappTemplate | null> {
    return this.templates.findOne({
      where: { tenant: { id: tenantId }, library_key: key },
      relations: { whatsapp_account: true },
    });
  }

  private applyDefinition(
    row: WhatsappTemplate,
    def: LibraryTemplateDef,
    values: LibraryInstallValues,
  ): void {
    row.name = def.name;
    row.language = def.language;
    row.category = def.proposedCategory;
    row.components = {
      components: buildLibraryComponents(def, values),
      parameter_format: 'POSITIONAL',
    };
    row.library_key = def.key;
    row.library_version = def.version;
  }

  private variablesOf(def: LibraryTemplateDef): LibraryEntryView['variables'] {
    const components = buildLibraryComponents(def, {
      // Only placeholder names are read from these components, never the link.
      appUrl: APP_URL_TOKEN,
    });
    const placeholders = [
      ...orderedBodyParameters({ components }),
      ...urlButtonParameters({ components }).map((p) => p.key),
    ];
    return placeholders.map((p) => ({
      placeholder: p,
      source: def.defaultMapping[p] ?? null,
    }));
  }

  /**
   * The account a draft will be submitted under: the one named (re-validated
   * against the tenant), else the tenant's default / only usable one, else none
   * (the draft is still saved; submitting needs an account).
   */
  private async pickAccount(
    tenantId: string,
    accountId?: string,
  ): Promise<WhatsappAccount | null> {
    if (accountId) {
      const found = await this.accounts.findOne({
        where: {
          id: accountId,
          tenant: { id: tenantId },
          deleted_at: IsNull(),
        },
      });
      if (!found) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'WhatsApp account not found in this tenant',
        });
      }
      return found;
    }
    const usable = await this.accounts.find({
      where: {
        tenant: { id: tenantId },
        deleted_at: IsNull(),
        is_active: true,
        connection_status: WHATSAPP_CONNECTION_STATUS.CONNECTED,
      },
    });
    return (
      usable.find((a) => a.is_default) ??
      (usable.length === 1 ? usable[0] : null)
    );
  }

  private async installValues(
    tenantId: string,
    account: WhatsappAccount | null,
    given: { phoneNumber?: string; offerUrl?: string },
  ): Promise<LibraryInstallValues> {
    const tenant = await this.tenants.findOne({
      where: { id: tenantId },
      select: { id: true, contact_phone: true },
    });
    const appUrl = (
      this.config.get<string>('APP_URL') ??
      (
        this.config.get<string>('FRONTEND_ORIGIN') ?? 'http://localhost:3000'
      ).split(',')[0]
    )
      .trim()
      .replace(/\/+$/, '');
    return {
      appUrl,
      // Explicit input > the clinic's contact phone > its WhatsApp number.
      clinicPhone:
        normalizeE164(given.phoneNumber) ??
        normalizeE164(tenant?.contact_phone) ??
        normalizeE164(account?.display_phone_number),
      offerUrl: given.offerUrl,
    };
  }

  /** What the clinic already typed into the draft, so an update doesn't ask again. */
  private carriedValues(row: WhatsappTemplate): {
    phoneNumber?: string;
    offerUrl?: string;
  } {
    const list = (
      row.components as
        | { components?: Array<Record<string, unknown>> }
        | undefined
    )?.components;
    const buttons =
      (list?.find((c) => c.type === 'BUTTONS')?.buttons as
        | Array<Record<string, string>>
        | undefined) ?? [];
    return {
      phoneNumber: buttons.find((b) => b.type === 'PHONE_NUMBER')?.phone_number,
      // Only a STATIC link is the clinic's own; the app-action link is rebuilt.
      offerUrl: buttons.find(
        (b) => b.type === 'URL' && !/\{\{/.test(b.url ?? ''),
      )?.url,
    };
  }
}
