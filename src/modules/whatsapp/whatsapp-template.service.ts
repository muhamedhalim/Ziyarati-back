import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, Repository } from 'typeorm';

import { WhatsappTemplate } from '../../entities/WhatsApp/WhatsappTemplate';
import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { NotificationTemplate } from '../../entities/Notifications/NotificationTemplate';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateWhatsappTemplateDto, WhatsappTemplateComponentDto } from './dto/create-whatsapp-template.dto';
import { ValidateWhatsappTemplateDto } from './dto/validate-whatsapp-template.dto';
import { UpdateWhatsappTemplateDto } from './dto/update-whatsapp-template.dto';
import { WhatsappTemplateFilterDto } from './dto/whatsapp-template-filter.dto';
import {
  MetaErrorPublicContext,
  MetaGraphClient,
  MetaTemplate,
  MetaTemplateComponentInput,
} from './meta/meta-graph.client';
import {
  ResolvedWhatsappAccount,
  WhatsappAccountResolver,
} from './routing/whatsapp-account.resolver';
import {
  mapMetaTemplateStatus,
  normalizeRejectionReason,
} from './template-status.util';
import {
  orderedBodyParameters,
  unsupportedTemplateShape,
} from './template-variables.util';
import { applyRemoteTemplate } from './template-mirror.util';
import {
  TemplateIssue,
  TemplateValidationResult,
  validateTemplateAuthoring,
} from './template-authoring.validator';
import {
  WHATSAPP_TEMPLATE_STALE_AFTER_MS,
  WHATSAPP_TEMPLATE_STATUS,
  WHATSAPP_TEMPLATE_STATUSES,
  WHATSAPP_TEMPLATE_VARIABLE_SOURCES,
} from './whatsapp.constants';

const PG_UNIQUE_VIOLATION = '23505';
/** Meta: "Content in This Language Already Exists" — code 100, subcode 2388024. */
const META_DUPLICATE_SUBCODE = 2388024;

/** What the API returns for a template: the row, a safe account, and freshness. */
export type WhatsappTemplateView = Omit<WhatsappTemplate, 'whatsapp_account'> & {
  whatsapp_account?: {
    id: string;
    display_phone_number?: string | null;
    verified_name?: string | null;
  } | null;
  /**
   * True when the status shown is older than we are willing to present as
   * current (never reconciled, or reconciled long ago). The UI must say "needs
   * refresh" — it must not silently show an old verdict as if it were live.
   */
  needs_refresh: boolean;
};

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

  /**
   * In-flight creates, keyed tenant|name|language. A double click (or a client
   * retry racing its own first attempt) arrives while the first request is
   * still waiting on Meta; without this both pass the duplicate check and both
   * POST. Process-local on purpose — across instances the duplicate rejection
   * from Meta and the unique constraint are the backstops.
   */
  private readonly inFlightCreates = new Map<string, Promise<WhatsappTemplate>>();

  constructor(
    @InjectRepository(WhatsappTemplate)
    private readonly templates: Repository<WhatsappTemplate>,
    @InjectRepository(WhatsappAccount)
    private readonly accounts: Repository<WhatsappAccount>,
    @InjectRepository(NotificationTemplate)
    private readonly notificationTemplates: Repository<NotificationTemplate>,
    private readonly graph: MetaGraphClient,
    private readonly resolver: WhatsappAccountResolver,
  ) {}

  // ─────────────────────────────── Authoring ─────────────────────────────── //

  /** Dry-run of the pre-submission checks. No Meta call, no DB write. */
  validate(dto: ValidateWhatsappTemplateDto): TemplateValidationResult {
    return validateTemplateAuthoring({
      category: dto.category,
      components: dto.components ?? [],
    });
  }

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
    const key = `${tenantId}|${dto.name}|${dto.language}`;
    const running = this.inFlightCreates.get(key);
    if (running) return running;

    const attempt = this.createOnce(tenantId, dto).finally(() => {
      this.inFlightCreates.delete(key);
    });
    this.inFlightCreates.set(key, attempt);
    return attempt;
  }

  private async createOnce(
    tenantId: string,
    dto: CreateWhatsappTemplateDto,
  ): Promise<WhatsappTemplate> {
    if (dto.accountId) await this.assertAccount(tenantId, dto.accountId);

    const validation = validateTemplateAuthoring({
      category: dto.category,
      components: dto.components,
    });
    if (!validation.valid) {
      const first = validation.issues.find((i) => i.severity === 'error') as TemplateIssue;
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: first.suggestion ? `${first.message} ${first.suggestion}` : first.message,
        publicContext: {
          validation: { issues: validation.issues, variables: validation.variables },
        },
      });
    }

    // `withDeleted`: the unique key (tenant, name, language) also covers
    // soft-deleted rows. A tombstone is REVIVED below instead of colliding.
    const existing = await this.templates.findOne({
      where: { tenant: { id: tenantId }, name: dto.name, language: dto.language },
      withDeleted: true,
    });
    if (existing && !existing.deleted_at) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'A template with this name and language already exists',
      });
    }

    const components = this.toMetaComponents(dto.components);
    // Checked BEFORE Meta is called: a bad binding must not leave a template
    // on the WABA that we then refuse to mirror.
    if (dto.variableMapping) {
      this.assertValidMapping(
        orderedBodyParameters({ components }),
        dto.variableMapping,
      );
    }

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

    const created = await this.submitToMeta(account, dto, components);

    const row =
      existing ?? this.templates.create({ tenant: { id: tenantId } as Tenant });
    row.deleted_at = null as unknown as undefined;
    row.whatsapp_account = { id: account.id } as WhatsappAccount;
    row.name = dto.name;
    row.language = dto.language;
    // Meta may RE-CATEGORISE on submission (a "utility" template that reads
    // as marketing comes back MARKETING). Its answer wins over the request.
    row.category = created.category ?? dto.category;
    row.components = { components, parameter_format: 'POSITIONAL' };
    row.provider_template_id = created.id;
    row.waba_id = account.wabaId;
    // Meta's own verdict — normally PENDING. Never the client's, never a local
    // default: `getSendableTemplate` trusts `approved` unconditionally.
    row.status = mapMetaTemplateStatus(created.status, (unknown) =>
      this.logger.warn(
        `Unknown Meta template status "${unknown}" on create — treating as pending (not sendable)`,
      ),
    );
    row.rejected_reason = normalizeRejectionReason(created.rejectedReason);
    row.variable_mapping =
      dto.variableMapping && Object.keys(dto.variableMapping).length > 0
        ? dto.variableMapping
        : undefined;
    row.last_synced_at = new Date();

    let saved: WhatsappTemplate;
    try {
      saved = await this.templates.save(row);
    } catch (err) {
      if ((err as { code?: string })?.code === PG_UNIQUE_VIOLATION) {
        // A concurrent request on another instance won the insert race. Meta
        // has exactly one template, so return the winner rather than fail.
        const winner = await this.templates.findOne({
          where: { tenant: { id: tenantId }, name: dto.name, language: dto.language },
        });
        if (winner) return winner;
      }
      throw err;
    }
    this.logger.log(
      `Tenant ${tenantId} created template "${dto.name}" (${dto.language}) on waba=${account.wabaId} — meta id ${created.id}, status ${saved.status}`,
    );
    return saved;
  }

  /**
   * The Meta POST, with the three failure shapes handled distinctly:
   *
   *  - duplicate  → 409 (Meta already has this name+language);
   *  - ambiguous (timeout / network) → the template MAY exist. Look it up by
   *    name; if found, adopt it as the result. If the lookup also fails the
   *    outcome is genuinely unknown, and the error SAYS so — the user is told
   *    to refresh, not to submit again;
   *  - anything else → surfaced with Meta's own words (`publicContext.meta`).
   */
  private async submitToMeta(
    account: ResolvedWhatsappAccount,
    dto: CreateWhatsappTemplateDto,
    components: MetaTemplateComponentInput[],
  ): Promise<{ id: string; status?: string; category?: string; rejectedReason?: string }> {
    try {
      return await this.graph.createTemplate(account.wabaId!, account.accessToken!, {
        name: dto.name,
        language: dto.language,
        category: dto.category,
        components,
      });
    } catch (err) {
      const meta = this.metaContext(err);

      if (
        meta?.metaCode === 100 &&
        (meta.metaSubcode === META_DUPLICATE_SUBCODE ||
          /already exists/i.test(meta.metaTitle ?? '') ||
          /already exists/i.test(meta.metaDetail ?? ''))
      ) {
        throw new AppError(ErrorCode.CONFLICT, {
          message:
            'A template with this name and language already exists on your WhatsApp Business Account.',
          publicContext: { meta },
        });
      }

      if (meta && (meta.kind === 'timeout' || meta.kind === 'network')) {
        const adopted = await this.tryAdoptByName(account, dto);
        if (adopted) {
          this.logger.warn(
            `Template "${dto.name}" (${dto.language}) create had an ambiguous outcome (${meta.kind}) but was found on Meta — adopted id ${adopted.id}`,
          );
          return {
            id: adopted.id,
            status: adopted.status,
            category: adopted.category,
            rejectedReason: adopted.rejectedReason,
          };
        }
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message:
            'Meta did not confirm the request in time, so we cannot tell whether the template was created. Do not submit it again — use "Refresh status" in a minute to check.',
          publicContext: { meta: { ...meta, outcomeUnknown: true } },
        });
      }
      throw err;
    }
  }

  private async tryAdoptByName(
    account: ResolvedWhatsappAccount,
    dto: CreateWhatsappTemplateDto,
  ): Promise<MetaTemplate | undefined> {
    try {
      const found = await this.graph.findTemplatesByName(
        account.wabaId!,
        account.accessToken!,
        dto.name,
      );
      const want = dto.language.toLowerCase().replace('-', '_');
      return found.find((t) => t.language.toLowerCase().replace('-', '_') === want);
    } catch {
      return undefined;
    }
  }

  private metaContext(err: unknown): MetaErrorPublicContext | undefined {
    return (err as AppError)?.publicContext?.meta as MetaErrorPublicContext | undefined;
  }

  /**
   * Closed-vocabulary check shared by create and `setVariableMapping`: every
   * key must be a placeholder the template declares, every value one of the
   * known sources. A binding can neither introduce a value Meta has no slot
   * for nor name an arbitrary field of the appointment or customer.
   */
  private assertValidMapping(declared: string[], mapping: Record<string, string>): void {
    for (const [name, source] of Object.entries(mapping)) {
      if (!declared.includes(name)) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: `The template has no placeholder {{${name}}}.`,
          publicContext: { placeholder: name, declared },
        });
      }
      if (!WHATSAPP_TEMPLATE_VARIABLE_SOURCES.includes(source as never)) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: `"${source}" is not an available data source.`,
          publicContext: { placeholder: name, source },
        });
      }
    }
  }

  // ─────────────────────────────── Reading ───────────────────────────────── //

  async findAll(tenantId: string, filter: WhatsappTemplateFilterDto) {
    const where: FindOptionsWhere<WhatsappTemplate> = { tenant: { id: tenantId } };
    if (filter.status) where.status = filter.status;
    if (filter.category) where.category = filter.category;
    if (filter.language) where.language = filter.language;
    // Template names are snake_case, so `_` is the common search character:
    // unescaped it is a LIKE wildcard and `a_b` would also match `axb`.
    if (filter.search) {
      where.name = ILike(`%${filter.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    if (filter.accountId) where.whatsapp_account = { id: filter.accountId };

    const [rows, total] = await this.templates.findAndCount({
      where,
      // The templates screen shows which connected account/number each
      // template is synced under — load it rather than making the frontend
      // guess from `waba_id` alone. The relation is PROJECTED by `toView`:
      // the raw account row carries the encrypted access-token envelope.
      relations: { whatsapp_account: true },
      order: { created_at: 'DESC' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return {
      data: rows.map((r) => this.toView(r)),
      total,
      page: filter.page,
      limit: filter.limit,
    };
  }

  /** Raw entity (no relations) — the internal contract other services rely on. */
  async findOne(tenantId: string, id: string): Promise<WhatsappTemplate> {
    const template = await this.templates.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!template) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Template not found' });
    }
    return template;
  }

  /** API shape for one template (safe account projection + freshness flag). */
  async findOneView(tenantId: string, id: string): Promise<WhatsappTemplateView> {
    const template = await this.templates.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { whatsapp_account: true },
    });
    if (!template) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Template not found' });
    }
    return this.toView(template);
  }

  toView(template: WhatsappTemplate): WhatsappTemplateView {
    const { whatsapp_account: account, ...rest } = template;
    const last = template.last_synced_at ? new Date(template.last_synced_at).getTime() : 0;
    return {
      ...rest,
      whatsapp_account: account
        ? {
            id: account.id,
            display_phone_number: account.display_phone_number ?? null,
            verified_name: account.verified_name ?? null,
          }
        : null,
      needs_refresh: !last || Date.now() - last > WHATSAPP_TEMPLATE_STALE_AFTER_MS,
    };
  }

  // ─────────────────────────────── Mutation ──────────────────────────────── //

  async update(
    tenantId: string,
    id: string,
    dto: UpdateWhatsappTemplateDto,
  ): Promise<WhatsappTemplate> {
    this.assertNotSettingApproved(dto.status);
    const template = await this.findOne(tenantId, id);

    // A template that exists on Meta is Meta's: its name, language, category
    // and components were reviewed there. Editing the mirror would make the
    // send-time checks (and the UI preview) describe a template that is not
    // the one Meta will actually send — and the next sync would silently
    // revert it. Only a never-submitted local row may be edited.
    const touchesMetaFields =
      dto.name !== undefined ||
      dto.language !== undefined ||
      dto.category !== undefined ||
      dto.components !== undefined;
    if (template.provider_template_id && touchesMetaFields) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'This template lives on WhatsApp/Meta and cannot be edited here. Create a new template instead.',
      });
    }

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

  /**
   * Binds each placeholder to a trusted data source for the notification
   * pipeline. Closed vocabulary (`WHATSAPP_TEMPLATE_VARIABLE_SOURCES`), and
   * every key must be a placeholder the template actually declares — a mapping
   * can neither introduce a value Meta has no slot for nor name an arbitrary
   * field of the appointment.
   */
  async setVariableMapping(
    tenantId: string,
    id: string,
    mapping: Record<string, string>,
  ): Promise<WhatsappTemplateView> {
    const template = await this.findOne(tenantId, id);
    this.assertValidMapping(orderedBodyParameters(template.components), mapping);
    template.variable_mapping = Object.keys(mapping).length > 0 ? mapping : null;
    await this.templates.save(template);
    return this.findOneView(tenantId, id);
  }

  /**
   * Deletes the template ON META, then removes the mirror row.
   *
   * The previous behaviour — soft-delete locally only — left the template alive
   * on the WABA, where the next sync would find it, fail to match the
   * tombstone and either crash on the unique key or resurrect it. Delete is
   * therefore Meta-first, exactly like create: the row goes only after Meta
   * has confirmed the template is gone (or says it never existed).
   *
   * Refused while a notification template still points at it — deleting would
   * silently break that automation (it would fall back to email at the next
   * send with no one having decided that).
   */
  async remove(tenantId: string, id: string): Promise<void> {
    const template = await this.templates.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { whatsapp_account: true },
    });
    if (!template) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Template not found' });
    }

    const inUse = await this.notificationTemplates
      .createQueryBuilder('nt')
      .where('nt."tenantId" = :tenantId', { tenantId })
      .andWhere('(nt.provider_template_id = :id OR nt.provider_template_id_ar = :id)', { id })
      .getCount();
    if (inUse > 0) {
      throw new AppError(ErrorCode.CONFLICT, {
        message:
          'This template is used by a notification template. Unlink it there before deleting.',
        publicContext: { inUse },
      });
    }

    if (template.provider_template_id) {
      const account = await this.accountFor(tenantId, template);
      try {
        await this.graph.deleteTemplate(
          account.wabaId!,
          account.accessToken!,
          template.provider_template_id,
          template.name,
        );
      } catch (err) {
        const meta = this.metaContext(err);
        // Meta saying the template is already gone is the state we want.
        const alreadyGone =
          meta?.httpStatus === 404 || (meta?.metaCode === 100 && meta?.metaSubcode === 33);
        if (!alreadyGone) throw err;
      }
    }
    await this.templates.softRemove(template);
  }

  /**
   * Re-reads ONE template's verdict from Meta — the safe "Refresh status".
   *
   * Read-only on Meta's side (a GET), so it may be repeated freely: it cannot
   * create, duplicate or alter anything there. On any failure (timeout, rate
   * limit, 5xx…) the error propagates and the row is left EXACTLY as it was —
   * the last known verdict stays, `last_synced_at` stays old, and the API's
   * `needs_refresh` keeps saying so. A failed refresh never invents a status.
   *
   * Only a definite "Meta has no such template" changes anything on the
   * negative path, and that is the same outcome a full sync would reach.
   */
  async refresh(tenantId: string, id: string): Promise<WhatsappTemplateView> {
    const template = await this.templates.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { whatsapp_account: true },
    });
    if (!template) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Template not found' });
    }
    if (!template.provider_template_id) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'This template was never submitted to Meta, so there is no status to refresh.',
      });
    }

    const account = await this.accountFor(tenantId, template);
    const startedAt = new Date();
    const remote = await this.graph.getTemplate(
      template.provider_template_id,
      account.accessToken!,
    );

    if (!remote) {
      await this.templates.softRemove(template);
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'This template no longer exists on WhatsApp/Meta and was removed from the list.',
        publicContext: { reason: 'GONE_ON_META' },
      });
    }

    // Written after our read began (a webhook beat us here): that write is the
    // newer of the two and must stand.
    const newerWrite =
      template.last_synced_at &&
      new Date(template.last_synced_at).getTime() > startedAt.getTime();
    if (!newerWrite) {
      applyRemoteTemplate(template, remote, new Date(), (unknown) =>
        this.logger.warn(
          `Unknown Meta template status "${unknown}" — treating as pending (not sendable)`,
        ),
      );
      await this.templates.save(template);
    }
    return this.findOneView(tenantId, id);
  }

  // ─────────────────────────────── Sending ───────────────────────────────── //

  /**
   * INTERNAL: returns a template that may be SENT, else 422 with the reason.
   *
   * `senderWabaId` — when the caller has already resolved the account it will
   * send from, its WABA. A template belongs to exactly one WABA, and Meta
   * resolves a template name against the sender's WABA: sending through a
   * number on a different WABA would be refused by Meta at best, and at worst
   * hit a same-named template with different content. Refused here instead.
   */
  async getSendableTemplate(
    tenantId: string,
    id: string,
    senderWabaId?: string,
  ): Promise<WhatsappTemplate> {
    const template = await this.findOne(tenantId, id);
    if (template.status !== WHATSAPP_TEMPLATE_STATUS.APPROVED) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Only approved templates can be sent (current: "${template.status}")`,
        publicContext: { templateStatus: template.status },
      });
    }
    if (senderWabaId && template.waba_id && template.waba_id !== senderWabaId) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'This template belongs to a different WhatsApp Business Account than the number you are sending from.',
        publicContext: { reason: 'WABA_MISMATCH' },
      });
    }
    const unsupported = unsupportedTemplateShape(template.components);
    if (unsupported) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `This template ${unsupported}, so it cannot be sent from here.`,
        publicContext: { reason: 'UNSUPPORTED_TEMPLATE_SHAPE' },
      });
    }
    return template;
  }

  /**
   * GAP-002 — `approved` may only ever be reached via Meta itself (the pull
   * sync, the single-template refresh, or the status webhook — all in
   * `WhatsappTemplateSyncService`, which mirrors Meta's own review verdict onto
   * the repository DIRECTLY: a structurally separate path with no client
   * input, never routed through this service). Every client-facing entry point
   * that can write `status` (create/update/setStatus) funnels through this ONE
   * guard, so a tenant can never self-approve a template Meta never actually
   * reviewed and make it sendable (`getSendableTemplate` trusts
   * `status === APPROVED` unconditionally, which is exactly what made this
   * exploitable).
   */
  private assertNotSettingApproved(status: string | undefined): void {
    if (status === WHATSAPP_TEMPLATE_STATUS.APPROVED) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message:
          "Templates can only be approved through WhatsApp/Meta's review process, not set directly.",
      });
    }
  }

  // ─────────────────────────────── Internals ─────────────────────────────── //

  /**
   * The account a template's Meta calls must go through: its own account when
   * set (re-validated against the tenant by the resolver), else the tenant's
   * default — and in both cases on the template's OWN WABA. A row that says
   * WABA A can never be read/deleted with a token that belongs to WABA B.
   */
  async accountFor(
    tenantId: string,
    template: WhatsappTemplate,
  ): Promise<ResolvedWhatsappAccount> {
    const accountId = template.whatsapp_account?.id;
    const account = accountId
      ? await this.resolver.byId(tenantId, accountId)
      : await this.resolver.forTenant(tenantId);

    if (!account.wabaId || !account.accessToken) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'This WhatsApp account has no connected WhatsApp Business Account.',
      });
    }
    if (template.waba_id && template.waba_id !== account.wabaId) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'This template belongs to a different WhatsApp Business Account than the connected number.',
        publicContext: { reason: 'WABA_MISMATCH' },
      });
    }
    return account;
  }

  /**
   * Translates the validated DTO into the exact payload Meta accepts. Cross-
   * field rules live in `validateTemplateAuthoring` (run first); the checks
   * here are the structural backstop for callers that bypass it (`update`).
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

    // Placeholders in first-seen order == ascending `{{n}}` order once the
    // authoring validator has run (it rejects any other order), so the sample
    // list the author supplied lines up index-for-index with `{{1}}…{{n}}`.
    const placeholders = orderedBodyParameters({ components: [{ type: 'BODY', text }] });
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
              c.type === 'BODY' ? { body_text: [examples] } : { header_text: examples },
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
