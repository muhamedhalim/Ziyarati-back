import { Injectable, Logger } from '@nestjs/common';

import { MetaConfig } from './meta.config';
import { AppError, ErrorCode } from '../../../common/errors';

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
}

export interface MetaMediaMetadata {
  url: string;
  mimeType?: string;
  sha256?: string;
  fileSize?: number;
}

interface GraphErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
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
        message: 'Meta did not return an access token for this authorization code.',
      });
    }
    return {
      accessToken: json.access_token,
      // 0 / absent = long-lived System User token with no expiry.
      expiresInSeconds: json.expires_in && json.expires_in > 0 ? json.expires_in : undefined,
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
    const params = new URLSearchParams({ input_token: token, access_token: appToken });

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

  /** Fetch a single WABA by id — also proves the token can actually read it. */
  async getWaba(wabaId: string, token: string): Promise<MetaWaba> {
    const json = await this.get<{
      id?: string;
      name?: string;
      currency?: string;
      timezone_id?: string;
      owner_business_info?: { id?: string };
    }>(`${encodeURIComponent(wabaId)}?fields=id,name,currency,timezone_id,owner_business_info`, token);

    if (!json.id) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'The selected WhatsApp Business Account could not be read from Meta.',
      });
    }
    return {
      id: json.id,
      name: json.name,
      currency: json.currency,
      timezoneId: json.timezone_id,
      ownerBusinessId: json.owner_business_info?.id,
    };
  }

  /** Phone numbers registered on a WABA. */
  async listPhoneNumbers(wabaId: string, token: string): Promise<MetaPhoneNumber[]> {
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
        message: 'Meta rejected the webhook subscription for this WhatsApp Business Account.',
      });
    }
  }

  /** All message templates on a WABA (paginated by Meta; follows `next`). */
  async listTemplates(wabaId: string, token: string): Promise<MetaTemplate[]> {
    const collected: MetaTemplate[] = [];
    let path: string | null =
      `${encodeURIComponent(wabaId)}/message_templates?limit=100`;

    // Bounded: templates per WABA are in the hundreds, and an unbounded loop on
    // a third party's paging cursor is a hang waiting to happen.
    for (let page = 0; page < 20 && path; page++) {
      const json: {
        data?: Array<{
          id: string;
          name: string;
          language: string;
          status: string;
          category?: string;
          components?: unknown;
          rejected_reason?: string;
        }>;
        paging?: { next?: string; cursors?: { after?: string } };
      } = await this.get(path, token);

      for (const t of json.data ?? []) {
        collected.push({
          id: t.id,
          name: t.name,
          language: t.language,
          status: t.status,
          category: t.category,
          components: t.components,
          rejectedReason: t.rejected_reason,
        });
      }

      const after = json.paging?.cursors?.after;
      path = json.paging?.next && after
        ? `${encodeURIComponent(wabaId)}/message_templates?limit=100&after=${encodeURIComponent(after)}`
        : null;
    }
    return collected;
  }

  /**
   * Resolve an inbound media id to a short-lived download URL. Meta expires
   * these in minutes, which is why media download is a queued job that
   * re-resolves rather than storing the URL.
   */
  async getMediaMetadata(mediaId: string, token: string): Promise<MetaMediaMetadata> {
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

  private async request<T>(method: 'GET' | 'POST', path: string, token?: string): Promise<T> {
    const url = this.config.graphUrl(path);
    const res = await this.fetchWithTimeout(url, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

    const json = (await res.json().catch(() => ({}))) as T & GraphErrorBody;
    if (!res.ok) {
      const err = (json as GraphErrorBody).error;
      // Log the Graph diagnostics (never the token) and surface a clean message.
      this.logger.warn(
        `Graph ${method} ${this.redact(path)} failed: HTTP ${res.status} ` +
          `code=${err?.code ?? '-'} subcode=${err?.error_subcode ?? '-'}`,
      );
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: err?.message
          ? `Meta rejected the request: ${err.message}`
          : `Meta API error (HTTP ${res.status}).`,
        // Meta's own error code/subcode — provider-response detail, logs only.
        internalContext: { metaCode: err?.code, metaSubcode: err?.error_subcode },
      });
    }
    return json;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.httpTimeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      const timedOut = (err as Error)?.name === 'AbortError';
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: timedOut
          ? 'Meta did not respond in time. Please try again.'
          : 'Could not reach Meta. Please try again.',
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Strips query strings before logging — they can carry tokens/secrets. */
  private redact(path: string): string {
    return path.split('?')[0];
  }
}
