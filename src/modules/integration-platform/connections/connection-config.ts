import { AppError, ErrorCode } from '../../../common/errors';
import {
  API_KEY_LOCATIONS,
  ApiKeyLocation,
  CONNECTION_AUTH_TYPE,
  INTEGRATION_RESOURCES,
  IntegrationResource,
  PAGINATION_STRATEGIES,
  PAGINATION_STRATEGY,
  PaginationStrategy,
  SYNC_DIRECTIONS,
  SyncDirection,
  isIntegrationResource,
} from '../integration-platform.constants';
import { assertSafeIntegrationBaseUrl, normalizeBaseUrl } from '../providers/integration-url-guard';

/**
 * Structured, VALIDATED shape of `IntegrationConnection.config` — never an
 * arbitrary tenant-supplied blob. Every key is fixed and bounded; anything
 * else in the raw input is rejected outright. Endpoint "paths" are relative
 * paths only (never full URLs) so `config` can never smuggle a second
 * outbound target past the base-URL SSRF guard, and custom headers are
 * name-blocklisted so a tenant can never override transport-critical headers
 * (Authorization, Host, Content-Length, ...) the adapter sets itself.
 */
export interface ApiKeyAuthConfig {
  location: ApiKeyLocation;
  name: string;
}
export interface BasicAuthConfig {
  /** Non-secret — the password is the encrypted credential, stored separately. */
  username: string;
}
export interface ResourceSyncConfig {
  enabled: boolean;
  /** Defaults to the connection's own sync_direction when absent. */
  direction?: SyncDirection;
}
export type ResourcesConfig = Partial<Record<IntegrationResource, ResourceSyncConfig>>;
export interface PaginationConfig {
  strategy: PaginationStrategy;
  pageParam?: string;
  sizeParam?: string;
  pageSize?: number;
  cursorParam?: string;
}

export type EndpointMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface OperationEndpoint {
  path: string;
  method: EndpointMethod;
}
/**
 * Per-operation endpoint configuration for one resource. `update`/`delete`
 * targets are always `{path}/{externalId}` — there is no `{id}` placeholder
 * substitution (a deliberate earlier decision to keep paths free of
 * tenant-controlled templating).
 */
export interface ResourceEndpointConfig {
  list?: OperationEndpoint;
  create?: OperationEndpoint;
  update?: OperationEndpoint;
  delete?: OperationEndpoint;
}
export type EndpointsConfig = Partial<Record<IntegrationResource, ResourceEndpointConfig>>;

/** External field name -> internal field name. Outbound push uses the inverse (see `invertFieldMap`). */
export type FieldMap = Record<string, string>;
export type FieldMapsConfig = Partial<Record<IntegrationResource, FieldMap>>;

export interface AdvancedConfig {
  endpoints?: EndpointsConfig;
  pagination?: PaginationConfig;
  /** Field name in each returned record holding its updated-at/cursor value. */
  cursorField?: string;
  headers?: Record<string, string>;
  /** Per-resource external<->internal field renaming (partial — unmapped fields pass through unchanged). */
  fieldMap?: FieldMapsConfig;
}
export interface ConnectionConfig {
  baseUrl?: string;
  apiKey?: ApiKeyAuthConfig;
  basic?: BasicAuthConfig;
  resources?: ResourcesConfig;
  advanced?: AdvancedConfig;
}

const MAX_BASE_URL_LEN = 2000;
const FIELD_NAME_RE = /^[A-Za-z0-9_.-]{1,120}$/;
const PATH_RE = /^\/[A-Za-z0-9_\-./]*$/;
const MAX_HEADERS = 10;
const MAX_HEADER_VALUE_LEN = 500;
const HEADER_NAME_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const MAX_FIELD_MAP_ENTRIES = 40;
/** Methods a tenant may configure for each REST operation — a small closed set per verb, never arbitrary. */
const OPERATION_METHODS: Record<'list' | 'create' | 'update' | 'delete', EndpointMethod[]> = {
  list: ['GET'],
  create: ['POST', 'PUT'],
  update: ['PUT', 'PATCH', 'POST'],
  delete: ['DELETE', 'POST'],
};
/** Transport-critical headers the adapter sets itself — never tenant-overridable. */
const BLOCKED_HEADER_NAMES = new Set([
  'authorization',
  'host',
  'content-length',
  'content-type',
  'content-encoding',
  'transfer-encoding',
  'cookie',
  'set-cookie',
  'connection',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function fail(message: string): never {
  throw new AppError(ErrorCode.VALIDATION_ERROR, { message });
}
function assertKnownKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(`Unknown field "${key}" in ${where}`);
  }
}
function parseFieldName(raw: unknown, field: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !FIELD_NAME_RE.test(raw)) {
    fail(`"${field}" must be 1-120 characters of letters, numbers, ".", "_" or "-"`);
  }
  return raw;
}

function parseApiKey(raw: unknown): ApiKeyAuthConfig {
  if (!isPlainObject(raw)) fail('API key configuration must be an object with "location" and "name"');
  assertKnownKeys(raw, ['location', 'name'], 'apiKey configuration');
  const location = raw.location;
  if (typeof location !== 'string' || !API_KEY_LOCATIONS.includes(location as ApiKeyLocation)) {
    fail(`API key location must be one of: ${API_KEY_LOCATIONS.join(', ')}`);
  }
  const name = parseFieldName(raw.name, 'apiKey.name');
  if (!name) fail('API key name is required');
  return { location: location as ApiKeyLocation, name: name! };
}

function parseBasic(raw: unknown): BasicAuthConfig {
  if (!isPlainObject(raw)) fail('Basic auth configuration must be an object with "username"');
  assertKnownKeys(raw, ['username'], 'basic auth configuration');
  const username = raw.username;
  if (typeof username !== 'string' || username.trim() === '' || username.length > 200) {
    fail('Basic auth username is required (max 200 characters)');
  }
  return { username: username.trim() };
}

function parseResources(raw: unknown): ResourcesConfig {
  if (!isPlainObject(raw)) fail('Resource configuration must be an object keyed by resource type');
  assertKnownKeys(raw, INTEGRATION_RESOURCES, 'resource configuration');
  const out: ResourcesConfig = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isIntegrationResource(key)) continue;
    if (!isPlainObject(value)) fail(`Resource configuration for "${key}" must be an object`);
    assertKnownKeys(value, ['enabled', 'direction'], `resource configuration for "${key}"`);
    if (typeof value.enabled !== 'boolean') {
      fail(`Resource configuration for "${key}" requires a boolean "enabled"`);
    }
    let direction: SyncDirection | undefined;
    if (value.direction !== undefined) {
      if (typeof value.direction !== 'string' || !SYNC_DIRECTIONS.includes(value.direction as SyncDirection)) {
        fail(`Resource "${key}" direction must be one of: ${SYNC_DIRECTIONS.join(', ')}`);
      }
      direction = value.direction as SyncDirection;
    }
    out[key as IntegrationResource] = { enabled: value.enabled, ...(direction ? { direction } : {}) };
  }
  return out;
}

function parsePagination(raw: unknown): PaginationConfig {
  if (!isPlainObject(raw)) fail('Pagination configuration must be an object with a "strategy"');
  assertKnownKeys(raw, ['strategy', 'pageParam', 'sizeParam', 'pageSize', 'cursorParam'], 'pagination configuration');
  const strategy = raw.strategy;
  if (typeof strategy !== 'string' || !PAGINATION_STRATEGIES.includes(strategy as PaginationStrategy)) {
    fail(`Pagination strategy must be one of: ${PAGINATION_STRATEGIES.join(', ')}`);
  }
  const out: PaginationConfig = { strategy: strategy as PaginationStrategy };
  if (strategy === PAGINATION_STRATEGY.PAGE_NUMBER) {
    out.pageParam = parseFieldName(raw.pageParam, 'pagination.pageParam') ?? 'page';
    out.sizeParam = parseFieldName(raw.sizeParam, 'pagination.sizeParam') ?? 'pageSize';
    if (raw.pageSize !== undefined) {
      const size = Number(raw.pageSize);
      if (!Number.isInteger(size) || size < 1 || size > 500) {
        fail('Pagination pageSize must be an integer between 1 and 500');
      }
      out.pageSize = size;
    } else {
      out.pageSize = 50;
    }
  } else if (strategy === PAGINATION_STRATEGY.CURSOR_PARAM) {
    out.cursorParam = parseFieldName(raw.cursorParam, 'pagination.cursorParam') ?? 'cursor';
  }
  return out;
}

function parsePath(raw: unknown, where: string): string {
  if (typeof raw !== 'string' || raw.length > 300 || !PATH_RE.test(raw)) {
    fail(`Endpoint path for "${where}" must be a relative path starting with "/" (max 300 characters)`);
  }
  return raw;
}

function parseOperationEndpoint(raw: unknown, op: keyof typeof OPERATION_METHODS, resourceKey: string): OperationEndpoint {
  if (!isPlainObject(raw)) fail(`Endpoint "${resourceKey}.${op}" must be an object with "path" (and optional "method")`);
  assertKnownKeys(raw, ['path', 'method'], `endpoint "${resourceKey}.${op}"`);
  const path = parsePath(raw.path, `${resourceKey}.${op}`);
  const allowed = OPERATION_METHODS[op];
  let method: EndpointMethod = allowed[0];
  if (raw.method !== undefined) {
    if (typeof raw.method !== 'string' || !allowed.includes(raw.method as EndpointMethod)) {
      fail(`Method for "${resourceKey}.${op}" must be one of: ${allowed.join(', ')}`);
    }
    method = raw.method as EndpointMethod;
  }
  return { path, method };
}

/**
 * A resource's endpoint config accepts either the ORIGINAL bare-path shorthand
 * (a single GET/POST/PUT endpoint reused for list/create/update — preserved so
 * the existing frontend form, which only ever sends a bare string, keeps
 * working unchanged) or the new per-operation object form.
 */
function parseResourceEndpointConfig(raw: unknown, resourceKey: string): ResourceEndpointConfig {
  if (typeof raw === 'string') {
    const path = parsePath(raw, resourceKey);
    return {
      list: { path, method: 'GET' },
      create: { path, method: 'POST' },
      update: { path, method: 'PUT' },
    };
  }
  if (!isPlainObject(raw)) {
    fail(`Endpoint configuration for "${resourceKey}" must be a path string or an object of {list, create, update, delete}`);
  }
  assertKnownKeys(raw, ['list', 'create', 'update', 'delete'], `endpoint configuration for "${resourceKey}"`);
  const out: ResourceEndpointConfig = {};
  if (raw.list !== undefined) out.list = parseOperationEndpoint(raw.list, 'list', resourceKey);
  if (raw.create !== undefined) out.create = parseOperationEndpoint(raw.create, 'create', resourceKey);
  if (raw.update !== undefined) out.update = parseOperationEndpoint(raw.update, 'update', resourceKey);
  if (raw.delete !== undefined) out.delete = parseOperationEndpoint(raw.delete, 'delete', resourceKey);
  return out;
}

function parseEndpoints(raw: unknown): EndpointsConfig {
  if (!isPlainObject(raw)) fail('Endpoint configuration must be an object keyed by resource type');
  assertKnownKeys(raw, INTEGRATION_RESOURCES, 'endpoint configuration');
  const out: EndpointsConfig = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isIntegrationResource(key)) continue;
    out[key] = parseResourceEndpointConfig(value, key);
  }
  return out;
}

function parseFieldMapOne(raw: unknown, resourceKey: string): FieldMap {
  if (!isPlainObject(raw)) {
    fail(`Field mapping for "${resourceKey}" must be an object of external field name to internal field name`);
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_FIELD_MAP_ENTRIES) {
    fail(`At most ${MAX_FIELD_MAP_ENTRIES} field mappings are allowed per resource`);
  }
  const out: FieldMap = {};
  const seenInternal = new Set<string>();
  for (const [external, internalRaw] of entries) {
    if (!FIELD_NAME_RE.test(external)) fail(`Field mapping key "${external}" for "${resourceKey}" is not a valid field name`);
    if (typeof internalRaw !== 'string' || !FIELD_NAME_RE.test(internalRaw)) {
      fail(`Field mapping value for "${resourceKey}.${external}" must be a valid field name`);
    }
    // Duplicate internal targets would make the outbound (inverted) direction
    // ambiguous — which external field should an internal value round-trip to?
    if (seenInternal.has(internalRaw)) {
      fail(`Field mapping for "${resourceKey}" maps more than one external field to internal field "${internalRaw}"`);
    }
    seenInternal.add(internalRaw);
    out[external] = internalRaw;
  }
  return out;
}

function parseFieldMap(raw: unknown): FieldMapsConfig {
  if (!isPlainObject(raw)) fail('Field mapping configuration must be an object keyed by resource type');
  assertKnownKeys(raw, INTEGRATION_RESOURCES, 'field mapping configuration');
  const out: FieldMapsConfig = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isIntegrationResource(key)) continue;
    out[key] = parseFieldMapOne(value, key);
  }
  return out;
}

/** Internal field name -> external field name, for outbound push. Derived on demand — never stored separately from the one authored (external->internal) map. */
export function invertFieldMap(map: FieldMap | undefined): FieldMap {
  if (!map) return {};
  const inverted: FieldMap = {};
  for (const [external, internal] of Object.entries(map)) inverted[internal] = external;
  return inverted;
}

/** Rename the keys of `data` through `map` (in the given direction); a field absent from the map passes through unchanged. */
export function applyFieldMap(data: Record<string, unknown>, map: FieldMap | undefined): Record<string, unknown> {
  if (!map || Object.keys(map).length === 0) return data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[map[key] ?? key] = value;
  }
  return out;
}

function parseHeaders(raw: unknown): Record<string, string> {
  if (!isPlainObject(raw)) fail('Custom headers must be an object of header name to value');
  const entries = Object.entries(raw);
  if (entries.length > MAX_HEADERS) fail(`At most ${MAX_HEADERS} custom headers are allowed`);
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!HEADER_NAME_RE.test(name)) fail(`Header name "${name}" is not a valid HTTP header token`);
    if (BLOCKED_HEADER_NAMES.has(name.toLowerCase())) {
      fail(`Header "${name}" is managed by the platform and cannot be set manually`);
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_HEADER_VALUE_LEN) {
      fail(`Header "${name}" value must be 1-${MAX_HEADER_VALUE_LEN} characters`);
    }
    if (/[\r\n]/.test(value)) fail(`Header "${name}" value must not contain line breaks`);
    out[name] = value;
  }
  return out;
}

function parseAdvanced(raw: unknown): AdvancedConfig {
  if (!isPlainObject(raw)) fail('Advanced configuration must be an object');
  assertKnownKeys(raw, ['endpoints', 'pagination', 'cursorField', 'headers', 'fieldMap'], 'advanced configuration');
  const out: AdvancedConfig = {};
  if (raw.endpoints !== undefined) out.endpoints = parseEndpoints(raw.endpoints);
  if (raw.pagination !== undefined) out.pagination = parsePagination(raw.pagination);
  if (raw.cursorField !== undefined) out.cursorField = parseFieldName(raw.cursorField, 'advanced.cursorField');
  if (raw.headers !== undefined) out.headers = parseHeaders(raw.headers);
  if (raw.fieldMap !== undefined) out.fieldMap = parseFieldMap(raw.fieldMap);
  return out;
}

export interface ParseConnectionConfigOptions {
  /** Whether the provider has a real, coded HTTP adapter (see generic-rest.adapter.ts). */
  providerRequiresBaseUrl: boolean;
  /**
   * True only at CREATE for a provider that requires a base URL — an omitted
   * baseUrl is itself an error. False on UPDATE: an omitted baseUrl there
   * means "keep the existing one" (see `mergeConnectionConfig`).
   */
  baseUrlRequiredIfOmitted: boolean;
}

const TOP_LEVEL_KEYS = ['baseUrl', 'apiKey', 'basic', 'resources', 'advanced'] as const;

/**
 * Parse + validate ONE submission (full config at create, a partial patch at
 * update) into a `ConnectionConfig`. Throws `AppError(VALIDATION_ERROR)` with
 * a specific, safe message on any unknown key or malformed value — nothing
 * is silently dropped or coerced.
 */
export function parseConnectionConfig(raw: unknown, opts: ParseConnectionConfigOptions): ConnectionConfig {
  if (raw === undefined || raw === null) {
    if (opts.baseUrlRequiredIfOmitted && opts.providerRequiresBaseUrl) {
      fail('Base URL is required for this provider');
    }
    return {};
  }
  if (!isPlainObject(raw)) fail('Connection configuration must be an object');
  assertKnownKeys(raw, TOP_LEVEL_KEYS, 'connection configuration');

  const out: ConnectionConfig = {};

  if (raw.baseUrl !== undefined) {
    const val = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '';
    if (val === '') {
      if (opts.providerRequiresBaseUrl) fail('Base URL is required for this provider');
    } else {
      if (!opts.providerRequiresBaseUrl) {
        fail('Base URL is not applicable to this provider');
      }
      if (val.length > MAX_BASE_URL_LEN) fail(`Base URL must be at most ${MAX_BASE_URL_LEN} characters`);
      const normalized = normalizeBaseUrl(val);
      assertSafeIntegrationBaseUrl(normalized || val);
      out.baseUrl = normalized;
    }
  } else if (opts.baseUrlRequiredIfOmitted && opts.providerRequiresBaseUrl) {
    fail('Base URL is required for this provider');
  }

  if (raw.apiKey !== undefined) out.apiKey = parseApiKey(raw.apiKey);
  if (raw.basic !== undefined) out.basic = parseBasic(raw.basic);
  if (raw.resources !== undefined) out.resources = parseResources(raw.resources);
  if (raw.advanced !== undefined) {
    if (!opts.providerRequiresBaseUrl) {
      fail('Advanced endpoint configuration is only applicable to providers with a real HTTP adapter');
    }
    out.advanced = parseAdvanced(raw.advanced);
  }

  return out;
}

/**
 * Cross-field coherence between the connection's (immutable) auth type and
 * its config. Only enforced at CREATE — a partial UPDATE patch may omit
 * `apiKey`/`basic` entirely (meaning "unchanged"), so re-running this against
 * a bare patch would reject a legitimate baseUrl-only edit. Since auth type
 * never changes after creation and updates only ever merge (never erase),
 * a connection that started coherent stays coherent.
 */
export function assertConfigMatchesAuthType(config: ConnectionConfig, authType: string): void {
  if (authType === CONNECTION_AUTH_TYPE.API_KEY && !config.apiKey) {
    fail('API key location and name are required for the "api_key" auth type');
  }
  if (authType === CONNECTION_AUTH_TYPE.BASIC && !config.basic) {
    fail('A username is required for the "basic" auth type');
  }
  if (authType !== CONNECTION_AUTH_TYPE.API_KEY && config.apiKey) {
    fail('API key configuration is only applicable to the "api_key" auth type');
  }
  if (authType !== CONNECTION_AUTH_TYPE.BASIC && config.basic) {
    fail('Basic auth configuration is only applicable to the "basic" auth type');
  }
}

/**
 * Non-destructive merge for UPDATE: a key absent from `patch` keeps whatever
 * `existing` already had, all the way down to individual resource entries and
 * individual custom headers — so editing one resource's direction or adding
 * one header never erases the others.
 */
export function mergeConnectionConfig(
  existing: ConnectionConfig | null | undefined,
  patch: ConnectionConfig,
): ConnectionConfig {
  const base: ConnectionConfig = existing ? { ...existing } : {};
  const merged: ConnectionConfig = { ...base };

  if (patch.baseUrl !== undefined) merged.baseUrl = patch.baseUrl;
  if (patch.apiKey !== undefined) merged.apiKey = patch.apiKey;
  if (patch.basic !== undefined) merged.basic = patch.basic;

  if (patch.resources !== undefined) {
    merged.resources = { ...(base.resources ?? {}), ...patch.resources };
  }

  if (patch.advanced !== undefined) {
    const baseAdvanced = base.advanced ?? {};
    const patchAdvanced = patch.advanced;
    merged.advanced = {
      ...baseAdvanced,
      ...patchAdvanced,
      endpoints:
        patchAdvanced.endpoints !== undefined
          ? { ...(baseAdvanced.endpoints ?? {}), ...patchAdvanced.endpoints }
          : baseAdvanced.endpoints,
      headers:
        patchAdvanced.headers !== undefined
          ? { ...(baseAdvanced.headers ?? {}), ...patchAdvanced.headers }
          : baseAdvanced.headers,
      fieldMap:
        patchAdvanced.fieldMap !== undefined
          ? { ...(baseAdvanced.fieldMap ?? {}), ...patchAdvanced.fieldMap }
          : baseAdvanced.fieldMap,
    };
  }

  return merged;
}

/** Effective sync direction for a resource: its own override, else the connection default. */
export function resourceDirectionOf(
  config: ConnectionConfig | null | undefined,
  resource: IntegrationResource,
  connectionDefault: SyncDirection,
): SyncDirection {
  return config?.resources?.[resource]?.direction ?? connectionDefault;
}

/** Whether a resource is enabled for this connection. Absent = enabled (default-on, matches pre-existing behaviour). */
export function isResourceEnabled(config: ConnectionConfig | null | undefined, resource: IntegrationResource): boolean {
  return config?.resources?.[resource]?.enabled ?? true;
}
