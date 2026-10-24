import { Injectable, Logger } from '@nestjs/common';

import { MetaConfig } from './meta.config';
import { AppError, ErrorCode } from '../../../common/errors';
import { scrubFailureReason } from '../../../common/utils/log-scrubber.util';

// ─── Graph API response shapes (only the fields we actually consume) ─────────

export interface MetaTokenExchangeResult {
  accessToken: string;
  /** Seconds until expiry. Absent for long-lived System User tokens. */
  expiresInSeconds?: number;
}

export interface MetaDebugTokenResult {
  appId: string;
  isValid: boolean;
  scopes: string[];
  /** Unix seconds. 0 or absent means "never expires". */
  expiresAt?: number;
}

export interface MetaWaba {
  id: string;
  name?: string;
  currency?: string;
  timezoneId?: string;
  /** Owning Meta Business (portfolio) id. */
  ownerBusinessId?: string;
}

export interface MetaPhoneNumber {
  id: string;
  displayPhoneNumber?: string;
  verifiedName?: string;
  qualityRating?: string;
  codeVerificationStatus?: string;
}

export interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category?: string;
  components?: unknown;
  rejectedReason?: string;
  /** `POSITIONAL` (`{{1}}`) or `NAMED` (`{{first_name}}`). Absent on older responses. */
  parameterFormat?: string;
}

export interface MetaMediaMetadata {
  url: string;
  mimeType?: string;
  sha256?: string;
  fileSize?: number;
}

/**
 * One component of a template as Meta accepts it on create. Deliberately the
 * PROVIDER's shape (upper-case `type`, snake_case `example` keys) rather than a
 * translated one: this crosses the wire verbatim, and a second vocabulary here
 * would only be a place for the translation to go wrong.
 */
export interface MetaTemplateComponentInput {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
  format?: 'TEXT';
  text?: string;
  example?: {
    header_text?: string[];
    body_text?: string[][];
  };
  buttons?: Array<{
    type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER';
    text: string;
    url?: string;
    phone_number?: string;
    /** Sample link(s) for a URL button whose `url` ends in `{{1}}`. */
    example?: string[];
  }>;
}

/** `POST /{template_id}` — Meta's in-place edit of a REJECTED / PAUSED / APPROVED template. */
export interface MetaTemplateEditInput {
  category?: string;
  components?: MetaTemplateComponentInput[];
}

export interface MetaTemplateCreateInput {
  name: string;
  language: string;
  category: string;
  components: MetaTemplateComponentInput[];
}

/** What Meta returns from a successful template creation. */
export interface MetaTemplateCreateResult {
  id: string;
  status?: string;
  category?: string;
  rejectedReason?: string;
}

/** A template exactly as Graph returns it (snake_case). */
interface RawMetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category?: string;
  components?: unknown;
  rejected_reason?: string;
  parameter_format?: string;
}

/**
 * Why a Graph call failed, coarse enough for a caller to decide what to do.
 *
 *   timeout / network — the request MAY have reached Meta. A write must be
 *                       reconciled (looked up) before it is ever repeated.
 *   rate_limited      — Meta throttled us; retry later.
 *   unavailable       — Meta 5xx; retry later.
 *   rejected          — Meta understood and refused (4xx). Retrying the same
 *                       input cannot help.
 */
export type MetaFailureKind =
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'unavailable'
  | 'rejected';

/**
 * Graph error codes that mean "throttled". 4 = app-level, 17 = user-level,
 * 32 = page-level, 613 = custom rate limit, 80008 = WhatsApp Business
 * Management API rate limit, 130429 = Cloud API throughput.
 */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80008, 130429]);

/** Public, client-safe projection of what Meta said — never a token or URL. */
export interface MetaErrorPublicContext {
  kind: MetaFailureKind;
  retriable: boolean;
  httpStatus?: number;
  metaCode?: number;
  metaSubcode?: number;
  /** Meta's own `error.message`, verbatim. */
  metaMessage?: string;
  /** Meta's `error_user_title` — often the human-readable heading. */
  metaTitle?: string;
  /** Meta's `error_user_msg` / `error_data.details` — the actual reason. */
  metaDetail?: string;
}

interface GraphErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_title?: string;
    error_user_msg?: string;
    /** The field that actually explains a 400 — `message` alone is often just "Invalid parameter". */
    error_data?: { details?: string };
  };
}

/**
 * The ONLY place that speaks HTTP to Meta's Graph API.
 *
 * Deliberately a dumb, typed transport: it maps Graph's snake_case JSON onto
 * our camelCase shapes and turns transport/HTTP failures into AppErrors. It
 * holds NO business rules — whether a WABA is acceptable, whether a token's
 * scopes are sufficient, what to persist — all live in the services above it.
 * That split is what keeps the onboarding logic unit-testable without a network
 * and stops Graph's payload quirks leaking through the codebase.
 *
 * Tokens are always passed IN by the caller (resolved per-tenant and decrypted
 * upstream); this client never reads a credential from config or the database,
 * so it cannot accidentally send one tenant's request with another's token.
 *
 * Every method throws on failure rather than returning a result union: these
 * run inside onboarding/sync flows where a failure must abort, unlike the send
 * path (MetaWhatsappProvider) which must never throw.
 */
@Injectable()
export class MetaGraphClient {
  private readonly logger = new Logger('MetaGraphClient');

  constructor(private readonly config: MetaConfig) {}

  /**
   * Embedded Signup step 1: exchange the short-lived authorization code the
   * browser returned for a real access token. Uses the APP SECRET, so this can
   * only ever happen server-side — which is the entire reason the frontend
   * never sees a token.
   */
  async exchangeCode(code: string): Promise<MetaTokenExchangeResult> {
    const params = new URLSearchParams({
      client_id: this.config.requireAppId(),
      client_secret: this.config.requireAppSecret(),
      code,
    });

    const json = await this.get<{ access_token?: string; expires_in?: number }>(
      `oauth/access_token?${params.toString()}`,
    );
    if (!json.access_token) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'Meta did not return an access token for this authorization code.',
      });
    }
    return {
      accessToken: json.access_token,
      // 0 / absent = long-lived System User token with no expiry.
      expiresInSeconds:
        json.expires_in && json.expires_in > 0 ? json.expires_in : undefined,
    };
  }

  /**
   * Embedded Signup step 2: introspect the token we just minted.
   *
   * This is the security-critical call. It is what proves the token was issued
   * for OUR app rather than replayed from another app — without it, an attacker
   * could hand us a token from an app they control and we would attach their
   * WABA to a tenant. Verified with the app-access-token (`appId|appSecret`),
   * never with the token being inspected.
   */
  async debugToken(token: string): Promise<MetaDebugTokenResult> {
    const appToken = `${this.config.requireAppId()}|${this.config.requireAppSecret()}`;
    const params = new URLSearchParams({
      input_token: token,
      access_token: appToken,
    });

    const json = await this.get<{
      data?: {
        app_id?: string;
        is_valid?: boolean;
        scopes?: string[];
        expires_at?: number;
      };
    }>(`debug_token?${params.toString()}`);

    const data = json.data;
    if (!data) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Meta returned no token information.',
      });
    }
    return {
      appId: data.app_id ?? '',
      isValid: data.is_valid === true,
      scopes: data.scopes ?? [],
      expiresAt: data.expires_at,
    };
  }

  /** The WABAs this token grants access to (`/me/businesses` equivalent). */
  async listSharedWabas(token: string): Promise<MetaWaba[]> {
    const json = await this.get<{
      data?: Array<{
        id: string;
        name?: string;
        currency?: string;
        timezone_id?: string;
        owner_business_info?: { id?: string };
      }>;
    }>('me/owned_whatsapp_business_accounts', token);

    return (json.data ?? []).map((w) => ({
      id: w.id,
      name: w.name,
      currency: w.currency,
      timezoneId: w.timezone_id,
      ownerBusinessId: w.owner_business_info?.id,
    }));
  }

  /**
   * The WABA fields an Embedded Signup token can actually read.
   *
   * Meta's Embedded Signup grants EXACTLY `whatsapp_business_management` and
   * `whatsapp_business_messaging` — never `business_management`.
   *
   * `owner_business_info` is deliberately absent: it is gated on
   * `business_management`, and naming it here made Graph reject the WHOLE read,
   * so onboarding died at step 3 for every clinic. It is fetched separately and
   * best-effort by `readOwnerBusinessId` below.
   */
  private static readonly WABA_FIELDS = 'id,name,currency,timezone_id';

  /** Fetch a single WABA by id — also proves the token can actually read it. */
  async getWaba(wabaId: string, token: string): Promise<MetaWaba> {
    const json = await this.get<{
      id?: string;
      name?: string;
      currency?: string;
      timezone_id?: string;
    }>(
      `${encodeURIComponent(wabaId)}?fields=${MetaGraphClient.WABA_FIELDS}`,
      token,
    );

    if (!json.id) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'The selected WhatsApp Business Account could not be read from Meta.',
      });
    }
    return {
      id: json.id,
      name: json.name,
      currency: json.currency,
      timezoneId: json.timezone_id,
      ownerBusinessId: await this.readOwnerBusinessId(wabaId, token),
    };
  }

  /**
   * The owning Meta Business (portfolio) id — OPTIONAL, and the one read here
   * that must never fail its caller.
   *
   * Reading it needs `business_management`, which an Embedded Signup token does
   * not carry (a Solution-Partner system-user token does). It is display-only
   * data: the onboarding DTO already carries the `business_id` the dialog
   * reported, and `meta_business_id` is nullable. So a failure is downgraded to
   * `undefined` rather than allowed to abort a valid connection — the ONE
   * deliberate exception to this client's throw-on-failure rule.
   */
  private async readOwnerBusinessId(
    wabaId: string,
    token: string,
  ): Promise<string | undefined> {
    try {
      const json = await this.get<{ owner_business_info?: { id?: string } }>(
        `${encodeURIComponent(wabaId)}?fields=owner_business_info`,
        token,
      );
      return json.owner_business_info?.id;
    } catch {
      // Expected whenever the token lacks `business_management`. `request()`
      // has already logged Meta's code/subcode; nothing to add here.
      return undefined;
    }
  }

  /** Phone numbers registered on a WABA. */
  async listPhoneNumbers(
    wabaId: string,
    token: string,
  ): Promise<MetaPhoneNumber[]> {
    const json = await this.get<{
      data?: Array<{
        id: string;
        display_phone_number?: string;
        verified_name?: string;
        quality_rating?: string;
        code_verification_status?: string;
      }>;
    }>(`${encodeURIComponent(wabaId)}/phone_numbers`, token);

    return (json.data ?? []).map((p) => ({
      id: p.id,
      displayPhoneNumber: p.display_phone_number,
      verifiedName: p.verified_name,
      qualityRating: p.quality_rating,
      codeVerificationStatus: p.code_verification_status,
    }));
  }

  /**
   * Subscribe OUR app to this WABA's webhooks. Without this Meta never delivers
   * the clinic's messages to the platform webhook, so onboarding is not
   * complete until it succeeds.
   */
  async subscribeAppToWaba(wabaId: string, token: string): Promise<void> {
    const json = await this.post<{ success?: boolean }>(
      `${encodeURIComponent(wabaId)}/subscribed_apps`,
      token,
    );
    if (json.success !== true) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'Meta rejected the webhook subscription for this WhatsApp Business Account.',
      });
    }
  }

  /**
   * Coexistence verification (post-onboarding gate): `GET /{phone_number_id}
   * ?fields=is_on_biz_app,platform_type`. Meta's documented way to confirm a
   * number actually IS on the Cloud API after a Coexistence Embedded Signup —
   * the dialog completing without error is not proof by itself. Returns
   * `undefined` fields (never throws its own error) when Meta omits either —
   * seen when the field is present but not yet populated on Meta's side
   * immediately after signup; the caller decides how to treat "unknown".
   */
  async getPhoneCoexistenceStatus(
    phoneNumberId: string,
    token: string,
  ): Promise<{ isOnBizApp?: boolean; platformType?: string }> {
    const json = await this.get<{
      is_on_biz_app?: boolean;
      platform_type?: string;
    }>(
      `${encodeURIComponent(phoneNumberId)}?fields=is_on_biz_app,platform_type`,
      token,
    );
    return { isOnBizApp: json.is_on_biz_app, platformType: json.platform_type };
  }

  /**
   * Coexistence sync: `POST /{phone_number_id}/smb_app_data`. Meta documents
   * two `sync_type` values, called in order — `smb_app_state_sync` first,
   * `history` second (see `WhatsappCoexistenceSyncService`, which owns that
   * ordering and the idempotency around it). This call only proves Meta
   * ACCEPTED the request; the actual sync result arrives later as an inbound
   * `smb_app_state_sync`/`history` webhook.
   */
  async triggerSmbAppDataSync(
    phoneNumberId: string,
    token: string,
    syncType: 'smb_app_state_sync' | 'history',
  ): Promise<void> {
    await this.postJson(
      `${encodeURIComponent(phoneNumberId)}/smb_app_data`,
      token,
      {
        messaging_product: 'whatsapp',
        sync_type: syncType,
      },
    );
  }

  /**
   * Fields requested on every template read. `rejected_reason` is NOT in
   * Meta's default response — without naming it the rejection reason is never
   * returned, which is why a rejected template used to show no reason at all.
   */
  private static readonly TEMPLATE_FIELDS =
    'id,name,language,status,category,components,rejected_reason,parameter_format';

  /** Same minus the newest/least-certain field, used if Meta rejects the list above. */
  private static readonly TEMPLATE_FIELDS_BASE =
    'id,name,language,status,category,components,rejected_reason';

  private static mapTemplate(t: RawMetaTemplate): MetaTemplate {
    return {
      id: t.id,
      name: t.name,
      language: t.language,
      status: t.status,
      category: t.category,
      components: t.components,
      rejectedReason: t.rejected_reason,
      parameterFormat: t.parameter_format,
    };
  }

  /**
   * Runs a template read with the full field list, stepping down to a smaller
   * one ONLY when Meta says a requested field is invalid (code 100). Any other
   * failure (timeout, 401, rate limit…) propagates untouched — retrying those
   * with fewer fields would just fail again and hide the real cause.
   */
  private async withTemplateFields<T>(
    run: (fields: string | undefined) => Promise<T>,
  ): Promise<T> {
    const ladder: Array<string | undefined> = [
      MetaGraphClient.TEMPLATE_FIELDS,
      MetaGraphClient.TEMPLATE_FIELDS_BASE,
      undefined,
    ];
    let lastError: unknown;
    for (const fields of ladder) {
      try {
        return await run(fields);
      } catch (err) {
        lastError = err;
        const code = (err as AppError)?.internalContext?.metaCode;
        const subcode = (err as AppError)?.internalContext?.metaSubcode;
        // 100/33 is "object does not exist", not "bad field" — never retry it.
        if (code !== 100 || subcode === 33) throw err;
        this.logger.warn(
          `Meta rejected template field list "${fields ?? '(default)'}" (code 100) — retrying with a smaller list`,
        );
      }
    }
    throw lastError;
  }

  /**
   * All message templates on a WABA (paginated by Meta; follows `paging.next`).
   *
   * Throws rather than returning a partial list when the page cap is hit: the
   * caller (`WhatsappTemplateSyncService`) treats the result as COMPLETE — it
   * prunes mirror rows that are absent from it — so a silently truncated list
   * would delete real templates from the mirror.
   */
  async listTemplates(wabaId: string, token: string): Promise<MetaTemplate[]> {
    return this.withTemplateFields(async (fields) => {
      const collected: MetaTemplate[] = [];
      const base = `${encodeURIComponent(wabaId)}/message_templates`;
      const qs = (after?: string) =>
        `?limit=100${fields ? `&fields=${fields}` : ''}${
          after ? `&after=${encodeURIComponent(after)}` : ''
        }`;
      let path: string | null = `${base}${qs()}`;

      // Bounded: templates per WABA are in the hundreds, and an unbounded loop
      // on a third party's paging cursor is a hang waiting to happen.
      const MAX_PAGES = 20;
      for (let page = 0; path; page++) {
        if (page >= MAX_PAGES) {
          throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
            message:
              'This WhatsApp Business Account has more templates than can be synchronised in one run.',
          });
        }
        const json: {
          data?: RawMetaTemplate[];
          paging?: { next?: string; cursors?: { after?: string } };
        } = await this.get(path, token);

        for (const t of json.data ?? []) {
          collected.push(MetaGraphClient.mapTemplate(t));
        }

        const after = json.paging?.cursors?.after;
        path = json.paging?.next && after ? `${base}${qs(after)}` : null;
      }
      return collected;
    });
  }

  /**
   * One template by its Meta id — the cheap, side-effect-free read behind the
   * per-template "Refresh status". Returns `null` when Meta no longer has it
   * (code 100 / subcode 33, or HTTP 404), which is DIFFERENT from a failed
   * call and must not be conflated with it: only a definite "gone" may change
   * what we believe about a template.
   */
  async getTemplate(
    templateId: string,
    token: string,
  ): Promise<MetaTemplate | null> {
    try {
      return await this.withTemplateFields(async (fields) => {
        const json = await this.get<RawMetaTemplate>(
          `${encodeURIComponent(templateId)}${fields ? `?fields=${fields}` : ''}`,
          token,
        );
        if (!json.id) {
          throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
            message: 'Meta returned no template for this id.',
          });
        }
        return MetaGraphClient.mapTemplate(json);
      });
    } catch (err) {
      const ctx = (err as AppError)?.internalContext;
      if (
        ctx?.httpStatus === 404 ||
        (ctx?.metaCode === 100 && ctx?.metaSubcode === 33)
      ) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Looks a template up by name on the WABA. Used ONLY to reconcile an
   * ambiguous create (timeout / network error): Meta may have accepted the
   * template even though we never saw the response, and re-POSTing blindly
   * would either duplicate the work or hit "already exists" with no id to
   * adopt. The name is matched exactly here (Meta's `name` filter is a
   * contains-search); the caller checks the language.
   */
  async findTemplatesByName(
    wabaId: string,
    token: string,
    name: string,
  ): Promise<MetaTemplate[]> {
    return this.withTemplateFields(async (fields) => {
      const json = await this.get<{ data?: RawMetaTemplate[] }>(
        `${encodeURIComponent(wabaId)}/message_templates?limit=100&name=${encodeURIComponent(name)}${
          fields ? `&fields=${fields}` : ''
        }`,
        token,
      );
      return (json.data ?? [])
        .filter((t) => t.name === name)
        .map((t) => MetaGraphClient.mapTemplate(t));
    });
  }

  /**
   * Create a message template ON the WABA — the write half of the template
   * lifecycle (`listTemplates` above is the read half).
   *
   * Meta owns review: this only SUBMITS the template. The response carries
   * Meta's own id and its initial status (normally `PENDING`), which is the
   * only status the caller may persist — a locally-invented one would let a
   * template appear sendable before Meta has approved anything.
   *
   * The tenant's token is passed in like every other method here, so this can
   * only ever write to a WABA the caller already resolved for that tenant.
   */
  async createTemplate(
    wabaId: string,
    token: string,
    input: MetaTemplateCreateInput,
  ): Promise<MetaTemplateCreateResult> {
    const json = await this.postJson<{
      id?: string;
      status?: string;
      category?: string;
    }>(`${encodeURIComponent(wabaId)}/message_templates`, token, input);

    if (!json.id) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Meta accepted the template but returned no template id.',
      });
    }
    return { id: json.id, status: json.status, category: json.category };
  }

  /**
   * Edit ONE template in place (`POST /{template_id}`) — the resubmission path
   * for a rejected or paused template. Meta puts it back into review; the
   * response is only `{ success }`, so the caller must re-read the template for
   * its new status instead of assuming one.
   *
   * Name and language cannot be changed by Meta, so they are not accepted here.
   */
  async editTemplate(
    templateId: string,
    token: string,
    input: MetaTemplateEditInput,
  ): Promise<void> {
    const json = await this.postJson<{ success?: boolean }>(
      encodeURIComponent(templateId),
      token,
      input,
    );
    if (json.success === false) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Meta did not accept the template edit.',
      });
    }
  }

  /**
   * Delete ONE template (`DELETE /{waba}/message_templates?hsm_id=…&name=…`).
   *
   * `hsm_id` is what scopes the delete to a single language variant — `name`
   * alone deletes EVERY language of that name. Both are sent: Meta requires
   * `name`, and `hsm_id` narrows it. Irreversible, and the name cannot be
   * reused for a period, so callers confirm with the user first.
   */
  async deleteTemplate(
    wabaId: string,
    token: string,
    templateId: string,
    name: string,
  ): Promise<void> {
    const json = await this.request<{ success?: boolean }>(
      'DELETE',
      `${encodeURIComponent(wabaId)}/message_templates?hsm_id=${encodeURIComponent(templateId)}&name=${encodeURIComponent(name)}`,
      token,
    );
    if (json.success === false) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Meta did not confirm the template deletion.',
      });
    }
  }

  /**
   * Resolve an inbound media id to a short-lived download URL. Meta expires
   * these in minutes, which is why media download is a queued job that
   * re-resolves rather than storing the URL.
   */
  async getMediaMetadata(
    mediaId: string,
    token: string,
  ): Promise<MetaMediaMetadata> {
    const json = await this.get<{
      url?: string;
      mime_type?: string;
      sha256?: string;
      file_size?: number;
    }>(`${encodeURIComponent(mediaId)}`, token);

    if (!json.url) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Meta returned no download URL for this media.',
      });
    }
    return {
      url: json.url,
      mimeType: json.mime_type,
      sha256: json.sha256,
      fileSize: json.file_size,
    };
  }

  /**
   * Download media bytes from a resolved URL. The lookaside URL still requires
   * the tenant's bearer token — it is not a public link.
   *
   * `maxBytes` is enforced against Content-Length AND the actual buffer, since
   * a hostile//buggy Content-Length must not let us allocate unbounded memory.
   */
  async downloadMedia(
    url: string,
    token: string,
    maxBytes: number,
  ): Promise<{ buffer: Buffer; mimeType?: string }> {
    const res = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Meta media download failed (HTTP ${res.status}).`,
      });
    }

    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > maxBytes) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Media is larger than the ${maxBytes}-byte limit.`,
      });
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Media is larger than the ${maxBytes}-byte limit.`,
      });
    }
    return { buffer, mimeType: res.headers.get('content-type') ?? undefined };
  }

  // ──────────────────────────── HTTP plumbing ────────────────────────────── //

  private async get<T>(path: string, token?: string): Promise<T> {
    return this.request<T>('GET', path, token);
  }

  private async post<T>(path: string, token?: string): Promise<T> {
    return this.request<T>('POST', path, token);
  }

  /** POST with a JSON body. `post()` above sends none — Meta's edges differ. */
  private async postJson<T>(
    path: string,
    token: string,
    body: unknown,
  ): Promise<T> {
    return this.request<T>('POST', path, token, body);
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    token?: string,
    body?: unknown,
  ): Promise<T> {
    const url = this.config.graphUrl(path);
    const res = await this.fetchWithTimeout(url, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    const json = (await res.json().catch(() => ({}))) as T & GraphErrorBody;
    if (!res.ok) {
      const err = (json as GraphErrorBody).error;
      // `error.message` is frequently just "Invalid parameter" — error_data.details
      // (or error_user_msg) carries the actual reason and is what a caller needs to
      // fix the request instead of guessing.
      const detail = err?.error_data?.details ?? err?.error_user_msg;
      // Log the Graph diagnostics (never the token) and surface a clean message.
      this.logger.warn(
        `Graph ${method} ${this.redact(path)} failed: HTTP ${res.status} ` +
          `code=${err?.code ?? '-'} subcode=${err?.error_subcode ?? '-'}` +
          (detail ? ` detail=${detail}` : ''),
      );

      const rateLimited =
        res.status === 429 ||
        (err?.code !== undefined && RATE_LIMIT_CODES.has(err.code));
      const kind: MetaFailureKind = rateLimited
        ? 'rate_limited'
        : res.status >= 500
          ? 'unavailable'
          : 'rejected';
      const pub: MetaErrorPublicContext = {
        kind,
        retriable: kind !== 'rejected',
        httpStatus: res.status,
        metaCode: err?.code,
        metaSubcode: err?.error_subcode,
        metaMessage: this.safeText(err?.message),
        metaTitle: this.safeText(err?.error_user_title),
        metaDetail: this.safeText(detail),
      };

      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: err?.message
          ? `Meta rejected the request: ${err.message}${detail ? ` — ${detail}` : ''}`
          : `Meta API error (HTTP ${res.status}).`,
        publicContext: { meta: pub },
        // Meta's own error code/subcode — provider-response detail, logs only.
        internalContext: {
          httpStatus: res.status,
          metaCode: err?.code,
          metaSubcode: err?.error_subcode,
          metaDetail: detail,
        },
      });
    }
    return json;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.httpTimeoutMs,
    );
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      const timedOut = (err as Error)?.name === 'AbortError';
      const pub: MetaErrorPublicContext = {
        kind: timedOut ? 'timeout' : 'network',
        retriable: true,
      };
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: timedOut
          ? 'Meta did not respond in time. Please try again.'
          : 'Could not reach Meta. Please try again.',
        publicContext: { meta: pub },
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Meta's error strings describe the caller's OWN request, so showing them is
   * the point — but they pass through the value-shape scrubber (tokens, emails,
   * long digit runs) first and are length-capped, because this is a
   * third-party string being forwarded into a client response.
   */
  private safeText(text: string | undefined): string | undefined {
    if (!text) return undefined;
    return scrubFailureReason(String(text), 500);
  }

  /** Strips query strings before logging — they can carry tokens/secrets. */
  private redact(path: string): string {
    return path.split('?')[0];
  }
}
