import {
  API_KEY_LOCATION,
  CONNECTION_AUTH_TYPE,
  IntegrationResource,
  PAGINATION_STRATEGY,
} from '../integration-platform.constants';
import { ConnectionConfig, PaginationConfig } from '../connections/connection-config';
import {
  CredentialCheckResult,
  HealthCheckResult,
  IntegrationProviderAdapter,
  ProviderCapabilities,
  ProviderChangePage,
  ProviderContext,
  ProviderPushResult,
} from './provider.types';
import { performGenericRestRequest } from './generic-rest-http-client';

const CAPABILITIES: ProviderCapabilities = {
  apiKey: true,
  staticCredential: true,
  oauth2Pkce: false,
  tokenRefresh: false,
  pullChanges: true,
  pushChanges: true,
  webhookVerification: true,
};

const REQUEST_TIMEOUT_MS = 8_000;
/** Bounded response read — a page of records is never allowed to balloon memory. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Defensive cap independent of the sync engine's own MAX_SYNC_RECORDS bound. */
const MAX_PAGE_RECORDS = 500;
const DEFAULT_PAGE_SIZE = 50;

function configOf(ctx: ProviderContext): ConnectionConfig {
  return (ctx.config ?? {}) as ConnectionConfig;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Auth headers/query for the configured auth type. Never throws — an incomplete config simply sends no credential (validateCredential is what rejects it upfront). */
function buildAuth(ctx: ProviderContext): { headers: Record<string, string>; query: URLSearchParams } {
  const headers: Record<string, string> = {};
  const query = new URLSearchParams();
  const config = configOf(ctx);

  switch (ctx.authType) {
    case CONNECTION_AUTH_TYPE.API_KEY:
      if (ctx.credential && config.apiKey) {
        if (config.apiKey.location === API_KEY_LOCATION.QUERY) query.set(config.apiKey.name, ctx.credential);
        else headers[config.apiKey.name] = ctx.credential;
      }
      break;
    case CONNECTION_AUTH_TYPE.SECRET:
      if (ctx.credential) headers.Authorization = `Bearer ${ctx.credential}`;
      break;
    case CONNECTION_AUTH_TYPE.BASIC:
      if (ctx.credential && config.basic?.username) {
        const token = Buffer.from(`${config.basic.username}:${ctx.credential}`, 'utf8').toString('base64');
        headers.Authorization = `Basic ${token}`;
      }
      break;
    case CONNECTION_AUTH_TYPE.OAUTH2:
      // Real OAuth token injection ships once a provider declares `oauth: true`
      // (see oauth.registry.ts) — no such provider exists yet, so this path is
      // presently unreachable via the trusted registry, but is wired for when one does.
      if (ctx.credential) headers.Authorization = `Bearer ${ctx.credential}`;
      break;
    default:
      break;
  }
  return { headers, query };
}

function buildUrl(baseUrl: string, path: string, extraQuery: URLSearchParams): string {
  const url = new URL(baseUrl + path);
  for (const [k, v] of extraQuery.entries()) url.searchParams.set(k, v);
  return url.toString();
}

function extractExternalId(item: Record<string, unknown>): string {
  const raw = item.id ?? item.externalId ?? item.external_id;
  if (raw === undefined || raw === null) return '';
  return String(raw);
}

function parsePage(
  bodyText: string | undefined,
  resource: IntegrationResource,
): { items: Record<string, unknown>[]; providerNextCursor: string | null } {
  if (!bodyText || bodyText.trim() === '') return { items: [], providerNextCursor: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error(`Response for "${resource}" was not valid JSON`);
  }
  if (Array.isArray(parsed)) {
    return { items: parsed.filter(isPlainRecord), providerNextCursor: null };
  }
  if (isPlainRecord(parsed)) {
    const arr = [parsed.data, parsed.items, parsed.results, parsed.records].find((v) => Array.isArray(v)) as
      | unknown[]
      | undefined;
    const items = (arr ?? []).filter(isPlainRecord);
    const cursorCandidate = parsed.nextCursor ?? parsed.next_cursor ?? parsed.cursor;
    return { items, providerNextCursor: typeof cursorCandidate === 'string' ? cursorCandidate : null };
  }
  throw new Error(`Response for "${resource}" was not a recognizable page shape`);
}

/**
 * `cursorField` names the field in each returned record holding its
 * updated-at/version value. It only ever matters for the `cursor_param`
 * strategy, and only as a FALLBACK: most cursor-paginated APIs declare their
 * own next-page token in the response envelope (`providerNextCursor`, already
 * preferred above it); simpler APIs return a plain array with no such
 * envelope, so the last record's `cursorField` value becomes the cursor sent
 * on the next call instead. `page_number`/`none` have no request slot to
 * round-trip a derived cursor into, so `cursorField` does not apply to them.
 */
function computeNextCursor(
  pagination: PaginationConfig,
  currentCursor: string | null,
  providerNextCursor: string | null,
  items: Record<string, unknown>[],
  cursorField: string | undefined,
): string | null {
  if (pagination.strategy === PAGINATION_STRATEGY.CURSOR_PARAM) {
    if (providerNextCursor) return providerNextCursor;
    if (cursorField && items.length > 0) {
      const value = items[items.length - 1]?.[cursorField];
      if (value !== undefined && value !== null && value !== '') return String(value);
    }
    return null;
  }
  if (pagination.strategy === PAGINATION_STRATEGY.PAGE_NUMBER) {
    const currentPage = currentCursor ? Number(currentCursor) : 1;
    const size = pagination.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isFinite(currentPage) || items.length < size) return null; // partial/empty page ⇒ end reached
    return String(currentPage + 1);
  }
  return null; // PAGINATION_STRATEGY.NONE — single page, always
}

/**
 * Real `IntegrationProviderAdapter` for `generic_rest` — the ONLY provider
 * that accepts a tenant-supplied base URL (see integration-platform.constants
 * `requiresBaseUrl`). Every outbound call funnels through
 * `generic-rest-http-client.ts`'s DNS-pinned, redirect-disabled request
 * executor, so SSRF protection is enforced on every single call, not only at
 * connection save time.
 *
 * Endpoint paths, pagination strategy, the cursor field name and custom
 * headers all come from the connection's validated `config` (see
 * connections/connection-config.ts) — never raw tenant input at request time.
 * A resource with no configured endpoint is an honest no-op (empty page /
 * zero pushed), matching the built-in adapters' existing "never fabricate a
 * record" contract.
 */
export class GenericRestAdapter implements IntegrationProviderAdapter {
  readonly key = 'generic_rest';
  readonly capabilities = CAPABILITIES;

  async validateCredential(ctx: ProviderContext): Promise<CredentialCheckResult> {
    const config = configOf(ctx);
    if (!config.baseUrl) return { valid: false, reason: 'No base URL is configured' };
    switch (ctx.authType) {
      case CONNECTION_AUTH_TYPE.API_KEY:
        if (!ctx.credential) return { valid: false, reason: 'Missing API key value' };
        if (!config.apiKey) return { valid: false, reason: 'API key location/name is not configured' };
        return { valid: true };
      case CONNECTION_AUTH_TYPE.SECRET:
        if (!ctx.credential) return { valid: false, reason: 'Missing bearer token' };
        return { valid: true };
      case CONNECTION_AUTH_TYPE.BASIC:
        if (!ctx.credential) return { valid: false, reason: 'Missing password' };
        if (!config.basic?.username) return { valid: false, reason: 'Missing username' };
        return { valid: true };
      default:
        return { valid: true };
    }
  }

  async healthCheck(ctx: ProviderContext): Promise<HealthCheckResult> {
    const cred = await this.validateCredential(ctx);
    if (!cred.valid) return { ok: false, reason: cred.reason };

    const config = configOf(ctx);
    const baseUrl = config.baseUrl!;
    const { headers, query } = buildAuth(ctx);
    // Prefer a configured resource endpoint (more representative than the bare
    // base URL, which many APIs 404 on); fall back to the base URL itself.
    const probePath = Object.values(config.advanced?.endpoints ?? {})[0] ?? '';

    const started = Date.now();
    const res = await performGenericRestRequest({
      method: 'GET',
      url: buildUrl(baseUrl, probePath, query),
      headers: { ...headers, ...(config.advanced?.headers ?? {}) },
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
    });
    const latencyMs = Date.now() - started;

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        latencyMs,
        reason: `Reached the server but authentication was rejected (HTTP ${res.status})`,
      };
    }
    if (res.status !== undefined) {
      // ANY response (including a 404 on the probe path) proves the endpoint is
      // reachable and speaking HTTP — that is what a health probe measures.
      return { ok: true, latencyMs };
    }
    return { ok: false, latencyMs, reason: res.error ?? 'Could not reach the server' };
  }

  async pullChanges(
    ctx: ProviderContext,
    resource: IntegrationResource,
    cursor: string | null,
  ): Promise<ProviderChangePage> {
    const config = configOf(ctx);
    const path = config.advanced?.endpoints?.[resource];
    if (!config.baseUrl || !path) {
      // Honest no-op: no endpoint wired for this resource yet.
      return { records: [], nextCursor: cursor, hasMore: false };
    }

    const { headers, query } = buildAuth(ctx);
    const pagination: PaginationConfig = config.advanced?.pagination ?? { strategy: PAGINATION_STRATEGY.NONE };

    if (pagination.strategy === PAGINATION_STRATEGY.PAGE_NUMBER) {
      const page = cursor ? Number(cursor) : 1;
      query.set(pagination.pageParam ?? 'page', String(Number.isFinite(page) && page > 0 ? page : 1));
      query.set(pagination.sizeParam ?? 'pageSize', String(pagination.pageSize ?? DEFAULT_PAGE_SIZE));
    } else if (pagination.strategy === PAGINATION_STRATEGY.CURSOR_PARAM && cursor) {
      query.set(pagination.cursorParam ?? 'cursor', cursor);
    }

    const res = await performGenericRestRequest({
      method: 'GET',
      url: buildUrl(config.baseUrl, path, query),
      headers: { ...headers, ...(config.advanced?.headers ?? {}) },
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
    });

    if (!res.ok) {
      throw new Error(res.error ?? `Request to the "${resource}" endpoint failed`);
    }

    const { items, providerNextCursor } = parsePage(res.bodyText, resource);
    const boundedItems = items.slice(0, MAX_PAGE_RECORDS);
    const records = boundedItems
      .map((item) => ({ externalId: extractExternalId(item), data: item }))
      .filter((r) => r.externalId !== '');

    const nextCursor = computeNextCursor(pagination, cursor, providerNextCursor, boundedItems, config.advanced?.cursorField);
    return { records, nextCursor, hasMore: nextCursor !== null };
  }

  async pushChanges(
    ctx: ProviderContext,
    resource: IntegrationResource,
    records: Array<{ externalId: string | null; data: Record<string, unknown> }>,
  ): Promise<ProviderPushResult> {
    const config = configOf(ctx);
    const path = config.advanced?.endpoints?.[resource];
    if (!config.baseUrl || !path || records.length === 0) {
      return { pushed: 0, failed: 0 };
    }

    const { headers, query } = buildAuth(ctx);
    let pushed = 0;
    let failed = 0;
    for (const record of records) {
      const target = record.externalId ? `${path}/${encodeURIComponent(record.externalId)}` : path;
      const res = await performGenericRestRequest({
        method: record.externalId ? 'PUT' : 'POST',
        url: buildUrl(config.baseUrl, target, query),
        headers: { ...headers, ...(config.advanced?.headers ?? {}) },
        body: JSON.stringify(record.data),
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
      });
      if (res.ok) pushed += 1;
      else failed += 1;
    }
    return { pushed, failed };
  }
}
