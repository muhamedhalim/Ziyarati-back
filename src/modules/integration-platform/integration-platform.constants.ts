/**
 * Integration Platform (Phase 3 — two-way integrations) shared constants.
 *
 * These are a DELIBERATELY SEPARATE contract from the Phase 1 read scopes and
 * the internal RBAC slugs: an external clinic system (PMS/EMR/ERP/CRM) drives
 * writes through a long-lived API key + a registered `IntegrationConnection`,
 * and every value it can influence must be validated against a fixed allowlist
 * before it ever reaches a domain service.
 */

/** The four resource types an external system may map/import/upsert. */
export const INTEGRATION_RESOURCE = {
  CUSTOMER: 'customer',
  STAFF: 'staff',
  SERVICE: 'service',
  APPOINTMENT: 'appointment',
} as const;

export type IntegrationResource =
  (typeof INTEGRATION_RESOURCE)[keyof typeof INTEGRATION_RESOURCE];

export const INTEGRATION_RESOURCES: IntegrationResource[] =
  Object.values(INTEGRATION_RESOURCE);

const RESOURCE_SET = new Set<string>(INTEGRATION_RESOURCES);
export function isIntegrationResource(v: unknown): v is IntegrationResource {
  return typeof v === 'string' && RESOURCE_SET.has(v);
}

/** Connection lifecycle status. `disconnected` also clears stored credentials. */
export const CONNECTION_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  DISCONNECTED: 'disconnected',
  ERROR: 'error',
} as const;
export type ConnectionStatus =
  (typeof CONNECTION_STATUS)[keyof typeof CONNECTION_STATUS];

/**
 * How an external record's values are reconciled against the platform record
 * when the two disagree. There is NO generic last-write-wins: every write goes
 * through one of these explicit policies, and none of them can ever override a
 * platform-protected field (see source-of-truth.ts).
 */
export const CONFLICT_POLICY = {
  EXTERNAL_WINS: 'external_wins',
  PLATFORM_WINS: 'platform_wins',
  REJECT_AND_REPORT: 'reject_and_report',
} as const;
export type ConflictPolicy =
  (typeof CONFLICT_POLICY)[keyof typeof CONFLICT_POLICY];
export const CONFLICT_POLICIES: ConflictPolicy[] = Object.values(CONFLICT_POLICY);

/** Direction of data flow the connection is configured for. */
export const SYNC_DIRECTION = {
  INBOUND: 'inbound',
  OUTBOUND: 'outbound',
  BIDIRECTIONAL: 'bidirectional',
} as const;
export type SyncDirection =
  (typeof SYNC_DIRECTION)[keyof typeof SYNC_DIRECTION];
export const SYNC_DIRECTIONS: SyncDirection[] = Object.values(SYNC_DIRECTION);

/**
 * Authentication the platform uses to talk to (or authenticate) the external
 * system. `oauth2` is reserved for the OAuth phase — provider endpoints for it
 * come ONLY from trusted backend configuration, never from tenant input (see
 * INTEGRATION_PROVIDERS), so it is not yet selectable at connection creation.
 */
export const CONNECTION_AUTH_TYPE = {
  NONE: 'none',
  API_KEY: 'api_key',
  SECRET: 'secret',
  OAUTH2: 'oauth2',
} as const;
export type ConnectionAuthType =
  (typeof CONNECTION_AUTH_TYPE)[keyof typeof CONNECTION_AUTH_TYPE];

/** Which side is recorded as the owner/creator of a mapped record. */
export const MAPPING_SOURCE = {
  EXTERNAL: 'external',
  PLATFORM: 'platform',
} as const;
export type MappingSource = (typeof MAPPING_SOURCE)[keyof typeof MAPPING_SOURCE];

/**
 * Provider registry — the ONLY source of provider metadata. A connection
 * references a provider KEY; any real endpoints/credentials for a provider come
 * from trusted backend configuration keyed here, never from tenant-supplied
 * URLs (SSRF / open-redirect defense). OAuth providers are intentionally absent
 * until the OAuth phase ships their validated config.
 */
export interface IntegrationProviderDef {
  key: string;
  label: string;
  /** Auth types a connection to this provider may use. */
  authTypes: ConnectionAuthType[];
  /** True once a validated OAuth config exists for this provider. */
  oauth: boolean;
}

export const INTEGRATION_PROVIDERS: Record<string, IntegrationProviderDef> = {
  generic_rest: {
    key: 'generic_rest',
    label: 'Generic REST / PMS-EMR',
    authTypes: [CONNECTION_AUTH_TYPE.API_KEY, CONNECTION_AUTH_TYPE.SECRET, CONNECTION_AUTH_TYPE.NONE],
    oauth: false,
  },
  custom: {
    key: 'custom',
    label: 'Custom clinic system',
    authTypes: [CONNECTION_AUTH_TYPE.API_KEY, CONNECTION_AUTH_TYPE.SECRET, CONNECTION_AUTH_TYPE.NONE],
    oauth: false,
  },
};

export const INTEGRATION_PROVIDER_KEYS = Object.keys(INTEGRATION_PROVIDERS);

export function getProvider(key: string): IntegrationProviderDef | undefined {
  return INTEGRATION_PROVIDERS[key];
}

/** Per-record outcome of an upsert/import operation. */
export const UPSERT_OUTCOME = {
  CREATED: 'created',
  UPDATED: 'updated',
  LINKED: 'linked',
  SKIPPED: 'skipped',
  CONFLICTED: 'conflicted',
  FAILED: 'failed',
} as const;
export type UpsertOutcome = (typeof UPSERT_OUTCOME)[keyof typeof UPSERT_OUTCOME];

/**
 * Maximum records accepted in ONE synchronous batch-import request. Larger jobs
 * belong on the (deferred) async import queue so an HTTP request is never held
 * open while thousands of rows are processed.
 */
export const MAX_SYNC_IMPORT_BATCH = 100;
