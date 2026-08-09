import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, Repository } from 'typeorm';

import { WhatsappTemplate } from '../../entities/WhatsApp/WhatsappTemplate';
import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateWhatsappTemplateDto, WhatsappTemplateComponentDto } from './dto/create-whatsapp-template.dto';
import { UpdateWhatsappTemplateDto } from './dto/update-whatsapp-template.dto';
import { WhatsappTemplateFilterDto } from './dto/whatsapp-template-filter.dto';
import { MetaGraphClient, MetaTemplateComponentInput } from './meta/meta-graph.client';
import { WhatsappAccountResolver } from './routing/whatsapp-account.resolver';
import { mapMetaTemplateStatus } from './template-status.util';
import { extractRequiredVariables } from './template-variables.util';
import {
  WHATSAPP_TEMPLATE_STATUS,
  WHATSAPP_TEMPLATE_STATUSES,
} from './whatsapp.constants';

/**
 * WhatsApp message templates. Unique per (tenant, name, language).
 *
 * Templates are META'S data. `create` therefore SUBMITS to Meta first and only
 * persists once Meta has accepted — the local row is a mirror of something that
 * really exists on the WABA, exactly like the rows
 * `WhatsappTemplateSyncService` writes. The two paths deliberately produce the
 * same stored shape (`{ components: [...] }`, Meta-derived status, Meta's id in
 * `provider_template_id`), so nothing downstream needs to know which one
 * created a row.
 *
 * Tenant isolation: every query filters `tenant: { id: tenantId }`; a referenced
 * account is re-validated against the tenant; the WABA written to a row is
 * always the one on the tenant's own resolved account, never client input.
 */
@Injectable()
export class WhatsappTemplateService {
  private readonly logger = new Logger('WhatsappTemplateService');

  constructor(
    @InjectRepository(WhatsappTemplate)
    private readonly templates: Repository<WhatsappTemplate>,
    @InjectRepository(WhatsappAccount)
    private readonly accounts: Repository<WhatsappAccount>,
    private readonly graph: MetaGraphClient,
    private readonly resolver: WhatsappAccountResolver,
  ) {}

  /**
   * Creates the template ON META, then mirrors it locally.
   *
   * Order matters and is the whole point: Meta is called BEFORE anything is
   * written. A failure therefore leaves no row at all, rather than a local
   * "draft" that looks like a template but exists nowhere Meta can see — that
   * orphan state is what made the previous local-only create misleading (the
   * row could never become sendable, because only Meta may write `approved`).
   */
  async create(tenantId: string, dto: CreateWhatsappTemplateDto): Promise<WhatsappTemplate> {
    if (dto.accountId) await this.assertAccount(tenantId, dto.accountId);

    const duplicate = await this.templates.findOne({
      where: { tenant: { id: tenantId }, name: dto.name, language: dto.language },
    });
    if (duplicate) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'A template with this name and language already exists',
      });
    }

    const components = this.toMetaComponents(dto.components);

    // Resolve the tenant's own connected account. This is the ONLY source of a
    // WABA id and an access token — both are read from the tenant's row and
    // never accepted from the request, so a caller cannot aim a template at
    // someone else's WABA.
    const account = dto.accountId
      ? await this.resolver.byId(tenantId, dto.accountId)
      : await this.resolver.forTenant(tenantId);

    if (!account.wabaId || !account.accessToken) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'This WhatsApp account has no connected WhatsApp Business Account. Connect WhatsApp before creating a template.',
      });
    }

    const created = await this.graph.createTemplate(account.wabaId, account.accessToken, {
      name: dto.name,
      language: dto.language,
      category: dto.category,
      components,
    });

    const template = this.templates.create({
      tenant: { id: tenantId } as Tenant,
      whatsapp_account: { id: account.id } as WhatsappAccount,
      name: dto.name,
      language: dto.language,
      // Meta may RE-CATEGORISE on submission (a "utility" template that reads
      // as marketing comes back MARKETING). Its answer wins over the request.
      category: created.category ?? dto.category,
      components: { components },
      provider_template_id: created.id,
      waba_id: account.wabaId,
      // Meta's own verdict — normally PENDING. Never the client's, never a
      // local default: `getSendableTemplate` trusts `approved` unconditionally.
      status: mapMetaTemplateStatus(created.status, (unknown) =>
        this.logger.warn(
          `Unknown Meta template status "${unknown}" on create — treating as pending (not sendable)`,
        ),
      ),
      last_synced_at: new Date(),
    });

    const saved = await this.templates.save(template);
    this.logger.log(
      `Tenant ${tenantId} created template "${dto.name}" (${dto.language}) on waba=${account.wabaId} — meta id ${created.id}, status ${saved.status}`,
    );
    return saved;
  }

  async findAll(tenantId: string, filter: WhatsappTemplateFilterDto) {
    const where: FindOptionsWhere<WhatsappTemplate> = { tenant: { id: tenantId } };
    if (filter.status) where.status = filter.status;
    if (filter.category) where.category = filter.category;
    if (filter.language) where.language = filter.language;
    if (filter.search) where.name = ILike(`%${filter.search}%`);
    if (filter.accountId) where.whatsapp_account = { id: filter.accountId };

    const [data, total] = await this.templates.findAndCount({
      where,
      // The templates screen shows which connected account/number each
      // template is synced under — load it rather than making the frontend
      // guess from `waba_id` alone.
      relations: { whatsapp_account: true },
      order: { created_at: 'DESC' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return { data, total, page: filter.page, limit: filter.limit };
  }

  async findOne(tenantId: string, id: string): Promise<WhatsappTemplate> {
    const template = await this.templates.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!template) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Template not found' });
    }
    return template;
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateWhatsappTemplateDto,
  ): Promise<WhatsappTemplate> {
    this.assertNotSettingApproved(dto.status);
    const template = await this.findOne(tenantId, id);
    if (dto.accountId !== undefined) {
      if (dto.accountId) {
        await this.assertAccount(tenantId, dto.accountId);
        template.whatsapp_account = { id: dto.accountId } as WhatsappAccount;
      } else {
        template.whatsapp_account = undefined;
      }
    }
    if (dto.name !== undefined) template.name = dto.name;
    if (dto.language !== undefined) template.language = dto.language;
    if (dto.category !== undefined) template.category = dto.category;
    // Local-only edit (Meta is not re-submitted here), but the stored shape
    // must stay the `{ components: [...] }` envelope every reader expects —
    // the send path's variable check and the UI's component viewer both
    // depend on it.
    if (dto.components !== undefined) {
      template.components = { components: this.toMetaComponents(dto.components) };
    }
    if (dto.status !== undefined) template.status = dto.status;
    return this.templates.save(template);
  }

  /** Updates the review status (draft/pending_review/rejected/disabled — never approved, see assertNotSettingApproved). */
  async setStatus(tenantId: string, id: string, status: string): Promise<WhatsappTemplate> {
    if (!WHATSAPP_TEMPLATE_STATUSES.includes(status as never)) {
      throw new AppError(ErrorCode.BAD_REQUEST, { message: 'Invalid template status' });
    }
    this.assertNotSettingApproved(status);
    const template = await this.findOne(tenantId, id);
    template.status = status;
    return this.templates.save(template);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const template = await this.findOne(tenantId, id);
    await this.templates.softRemove(template);
  }

  /** INTERNAL: returns an APPROVED template for sending (else 422). */
  async getSendableTemplate(tenantId: string, id: string): Promise<WhatsappTemplate> {
    const template = await this.findOne(tenantId, id);
    if (template.status !== WHATSAPP_TEMPLATE_STATUS.APPROVED) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Only approved templates can be sent (current: "${template.status}")`,
      });
    }
    return template;
  }

  /**
   * GAP-002 — `approved` may only ever be reached via the Meta callback
   * (`WhatsappTemplateSyncService`, which mirrors Meta's own review verdict
   * onto `Repository<WhatsappTemplate>` DIRECTLY — a structurally separate
   * path with no client input, never routed through this service). Every
   * client-facing entry point that can write `status` (create/update/
   * setStatus) funnels through this ONE guard, so a tenant can never
   * self-approve a template Meta never actually reviewed and make it
   * sendable (`getSendableTemplate` above trusts `status === APPROVED`
   * unconditionally, which is exactly what made this exploitable).
   */
  private assertNotSettingApproved(status: string | undefined): void {
    if (status === WHATSAPP_TEMPLATE_STATUS.APPROVED) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message:
          'Templates can only be approved through WhatsApp/Meta\'s review process, not set directly.',
      });
    }
  }

  /**
   * Translates the validated DTO into the exact payload Meta accepts, and
   * enforces the cross-field rules class-validator cannot express per-property.
   *
   * The placeholder/example check is the one that matters in practice: Meta
   * rejects a template whose BODY declares `{{1}}` without a matching sample,
   * and its error text is generic enough that the user would be left guessing.
   * `extractRequiredVariables` is reused rather than re-parsed so authoring and
   * the send-time completeness check agree on what a placeholder is.
   */
  private toMetaComponents(
    components: WhatsappTemplateComponentDto[],
  ): MetaTemplateComponentInput[] {
    const bodies = components.filter((c) => c.type === 'BODY');
    if (bodies.length !== 1) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'A template must have exactly one BODY component.',
      });
    }

    const seen = new Set<string>();
    for (const c of components) {
      if (seen.has(c.type)) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: `Duplicate ${c.type} component — each component type may appear only once.`,
        });
      }
      seen.add(c.type);
    }

    return components.map((c) => this.toMetaComponent(c));
  }

  private toMetaComponent(c: WhatsappTemplateComponentDto): MetaTemplateComponentInput {
    if (c.type === 'BUTTONS') {
      if (!c.buttons || c.buttons.length === 0) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'A BUTTONS component must declare at least one button.',
        });
      }
      return {
        type: 'BUTTONS',
        buttons: c.buttons.map((b) => {
          if (b.type === 'URL' && !b.url?.trim()) {
            throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
              message: `Button "${b.text}" is a URL button but has no url.`,
            });
          }
          if (b.type === 'PHONE_NUMBER' && !b.phoneNumber?.trim()) {
            throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
              message: `Button "${b.text}" is a phone button but has no phone number.`,
            });
          }
          return {
            type: b.type as 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER',
            text: b.text,
            ...(b.type === 'URL' ? { url: b.url } : {}),
            ...(b.type === 'PHONE_NUMBER' ? { phone_number: b.phoneNumber } : {}),
          };
        }),
      };
    }

    const text = c.text?.trim();
    if (!text) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `The ${c.type} component requires text.`,
      });
    }

    // Reuse the send path's definition of "a placeholder" by handing it the
    // same `{ components: [...] }` envelope the column stores.
    const placeholders = extractRequiredVariables({ components: [{ type: 'BODY', text }] });
    const examples = (c.example ?? []).map((e) => e.trim()).filter((e) => e.length > 0);

    if (placeholders.length > 0 && examples.length !== placeholders.length) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          `The ${c.type} component declares ${placeholders.length} placeholder(s) ` +
          `(${placeholders.map((p) => `{{${p}}}`).join(', ')}) but supplied ${examples.length} example value(s). ` +
          'Meta rejects a template whose placeholders have no sample values.',
        publicContext: { component: c.type, placeholders, suppliedExamples: examples.length },
      });
    }

    if (c.type === 'FOOTER' && placeholders.length > 0) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'A FOOTER component cannot contain placeholders.',
      });
    }

    return {
      type: c.type as 'HEADER' | 'BODY' | 'FOOTER',
      ...(c.type === 'HEADER' ? { format: 'TEXT' as const } : {}),
      text,
      // Meta's example shapes differ by component: BODY nests one array per
      // example set, HEADER is a flat list.
      ...(placeholders.length > 0
        ? {
            example:
              c.type === 'BODY'
                ? { body_text: [examples] }
                : { header_text: examples },
          }
        : {}),
    };
  }

  private async assertAccount(tenantId: string, accountId: string): Promise<void> {
    const ok = await this.accounts.exists({
      where: { id: accountId, tenant: { id: tenantId } },
    });
    if (!ok) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'WhatsApp account not found in this tenant',
      });
    }
  }
}
