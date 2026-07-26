import {
  API_KEY_LOCATION,
  CONNECTION_AUTH_TYPE,
  IntegrationResource,
  PAGINATION_STRATEGY,
} from '../integration-platform.constants';
import { ConnectionConfig, PaginationConfig, applyFieldMap, invertFieldMap } from '../connections/connection-config';
import {
  CredentialCheckResult,
  HealthCheckResult,
  IntegrationProviderAdapter,
  ProviderCapabilities,
  ProviderChangePage,
  ProviderContext,
  ProviderPushRecord,
  ProviderPushRecordResult,
  ProviderPushResult,
  ResourceCheckResult,
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
const MAX_CURSOR_LEN = 500;

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

/** The id a provider assigned to a just-created record, parsed from its response body (top-level or `data`/`result`/`record`-wrapped). */
function parseCreatedExternalId(bodyText: string | undefined): string | null {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText);
    if (!isPlainRecord(parsed)) return null;
    const direct = extractExternalId(parsed);
    if (direct) return direct;
    const nested = parsed.data ?? parsed.result ?? parsed.record;
    if (isPlainRecord(nested)) {
      const id = extractExternalId(nested);
      return id || null;
    }
  } catch {
    // Not JSON, or unparsable — no id to report; the caller still counts this as pushed.
  }
  return null;
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
 * Defensive, format-level validation of an incoming cursor BEFORE it is
 * round-tripped into a request to the provider. The cursor is always either
 * one WE generated from a prior response or opaque provider-supplied state,
 * but a corrupted/tampered value (e.g. a hand-edited retry payload) must never
 * be forwarded blindly — an invalid cursor fails the run loudly rather than
 * silently resetting to page 1 (which would waste a full re-scan) or being
 * sent as-is (which could break the provider's own pagination).
 */
function validateCursor(cursor: string | null, pagination: PaginationConfig): void {
  if (cursor === null) return;
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LEN) {
    throw new Error('Cursor is invalid (empty or unexpectedly long)');
  }
  if (pagination.strategy === PAGINATION_STRATEGY.PAGE_NUMBER) {
    if (!/^[1-9][0-9]{0,9}$/.test(cursor)) {
      throw new Error(`Invalid page-number cursor: "${cursor.slice(0, 50)}"`);
    }
  } else if (pagination.strategy === PAGINATION_STRATEGY.CURSOR_PARAM) {
    // Printable ASCII only. Defense in depth — URLSearchParams already encodes
    // this safely, but a cursor with control characters/newlines is refused
    // outright rather than trusted to round-trip cleanly.
    if (!/^[\x20-\x7E]+$/.test(cursor)) {
      throw new Error('Cursor contains invalid characters');
    }
  }
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
 * `generic-rest-http-client.ts`'s DNS-pinned, redirect-disabled, retrying
 * request executor, so SSRF protection AND transient-failure/429 handling are
 * enforced on every single call, not only at connection save time.
 *
 * Endpoint paths/methods (per operation: list/create/update/delete), pagination
 * strategy, the cursor field name, custom headers and field mapping all come
 * from the connection's validated `config` (see connections/connection-config.ts)
 * — never raw tenant input at request time. A resource with no configured
 * endpoint is an honest no-op/failure (empty page / a clear per-record error) —
 * matching the built-in adapters' existing "never fabricate a record" contract.
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
    // Prefer a configured resource's list endpoint (more representative than the
    // bare base URL, which many APIs 404 on); fall back to the base URL itself.
    const probeEndpoint = Object.values(config.advanced?.endpoints ?? {})[0]?.list;
    const probePath = probeEndpoint?.path ?? '';

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

  /**
   * Verifies ONE configured resource's LIST endpoint is reachable/authorized —
   * used by connection verification to report per-resource status rather than
   * only overall connectivity. Requests a single, minimal page (pageSize 1
   * where the pagination strategy supports it) so this stays a cheap probe.
   */
  async checkResource(ctx: ProviderContext, resource: IntegrationResource): Promise<ResourceCheckResult> {
    const config = configOf(ctx);
    if (!config.baseUrl) return { ok: false, message: 'No base URL is configured' };
    const endpoint = config.advanced?.endpoints?.[resource]?.list;
    if (!endpoint) return { ok: false, message: `No endpoint is configured for "${resource}"` };

    const { headers, query } = buildAuth(ctx);
    const pagination: PaginationConfig = config.advanced?.pagination ?? { strategy: PAGINATION_STRATEGY.NONE };
    if (pagination.strategy === PAGINATION_STRATEGY.PAGE_NUMBER) {
      query.set(pagination.pageParam ?? 'page', '1');
      query.set(pagination.sizeParam ?? 'pageSize', '1');
    }

    const res = await performGenericRestRequest({
      method: 'GET',
      url: buildUrl(config.baseUrl, endpoint.path, query),
      headers: { ...headers, ...(config.advanced?.headers ?? {}) },
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
    });

    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: `Authentication was rejected (HTTP ${res.status})` };
    }
    if (res.status !== undefined) {
      if (res.status >= 200 && res.status < 300) return { ok: true, message: 'Reachable' };
      return { ok: false, message: `Endpoint responded with HTTP ${res.status}` };
    }
    return { ok: false, message: res.error ?? 'Could not reach the endpoint' };
  }

  async pullChanges(
    ctx: ProviderContext,
    resource: IntegrationResource,
    cursor: string | null,
  ): Promise<ProviderChangePage> {
    const config = configOf(ctx);
    const endpoint = config.advanced?.endpoints?.[resource]?.list;
    if (!config.baseUrl || !endpoint) {
      // Honest no-op: no endpoint wired for this resource yet.
      return { records: [], nextCursor: cursor, hasMore: false };
    }

    const pagination: PaginationConfig = config.advanced?.pagination ?? { strategy: PAGINATION_STRATEGY.NONE };
    validateCursor(cursor, pagination);

    const { headers, query } = buildAuth(ctx);
    if (pagination.strategy === PAGINATION_STRATEGY.PAGE_NUMBER) {
      const page = cursor ? Number(cursor) : 1;
      query.set(pagination.pageParam ?? 'page', String(page));
      query.set(pagination.sizeParam ?? 'pageSize', String(pagination.pageSize ?? DEFAULT_PAGE_SIZE));
    } else if (pagination.strategy === PAGINATION_STRATEGY.CURSOR_PARAM && cursor) {
      query.set(pagination.cursorParam ?? 'cursor', cursor);
    }

    const res = await performGenericRestRequest({
      method: endpoint.method,
      url: buildUrl(config.baseUrl, endpoint.path, query),
      headers: { ...headers, ...(config.advanced?.headers ?? {}) },
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
    });

    if (!res.ok) {
      throw new Error(res.error ?? `Request to the "${resource}" endpoint failed`);
    }

    const { items, providerNextCursor } = parsePage(res.bodyText, resource);
    const boundedItems = items.slice(0, MAX_PAGE_RECORDS);
    const fieldMap = config.advanced?.fieldMap?.[resource];
    const records = boundedItems
      .map((item) => ({ externalId: extractExternalId(item), data: applyFieldMap(item, fieldMap) }))
      .filter((r) => r.externalId !== '');

    let nextCursor = computeNextCursor(pagination, cursor, providerNextCursor, boundedItems, config.advanced?.cursorField);
    // PAGINATION-LOOP PROTECTION at the source: a provider claiming "more" but
    // returning the SAME boundary again is not progress. The sync engine's own
    // seenCursors guard also catches this one call later; stopping here avoids
    // that one wasted extra request.
    if (nextCursor !== null && nextCursor === cursor) nextCursor = null;
    return { records, nextCursor, hasMore: nextCursor !== null };
  }

  async pushChanges(
    ctx: ProviderContext,
    resource: IntegrationResource,
    records: ProviderPushRecord[],
  ): Promise<ProviderPushResult> {
    const config = configOf(ctx);
    const results: ProviderPushRecordResult[] = [];
    if (!config.baseUrl || records.length === 0) {
      return { pushed: 0, failed: 0, results: [] };
    }

    const endpoints = config.advanced?.endpoints?.[resource];
    const { headers, query } = buildAuth(ctx);
    const outboundFieldMap = invertFieldMap(config.advanced?.fieldMap?.[resource]);
    let pushed = 0;
    let failed = 0;

    for (const record of records) {
      const isCreate = !record.externalId;
      const op = isCreate ? endpoints?.create : endpoints?.update;
      if (!op) {
        failed += 1;
        results.push({
          internalId: record.internalId,
          ok: false,
          transient: false,
          error: `No ${isCreate ? 'create' : 'update'} endpoint configured for "${resource}"`,
        });
        continue;
      }

      const target = isCreate ? op.path : `${op.path}/${encodeURIComponent(record.externalId!)}`;
      const payload = applyFieldMap(record.data, outboundFieldMap);
      const res = await performGenericRestRequest({
        method: op.method,
        url: buildUrl(config.baseUrl, target, query),
        headers: { ...headers, ...(config.advanced?.headers ?? {}) },
        body: JSON.stringify(payload),
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
      });

      if (res.ok) {
        pushed += 1;
        results.push({
          internalId: record.internalId,
          ok: true,
          externalId: isCreate ? parseCreatedExternalId(res.bodyText) : undefined,
        });
      } else {
        failed += 1;
        results.push({
          internalId: record.internalId,
          ok: false,
          transient: res.transient,
          error: res.error ?? `Request to the "${resource}" endpoint failed`,
        });
      }
    }
    return { pushed, failed, results };
  }
}
