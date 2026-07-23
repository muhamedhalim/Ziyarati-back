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
 * belong on the async import queue so an HTTP request is never held open while
 * thousands of rows are processed.
 */
export const MAX_SYNC_IMPORT_BATCH = 100;

/**
 * Maximum records accepted into ONE async import job. Bounds the staged payload
 * so a single job can never balloon the jobs table or a worker's memory.
 */
export const MAX_ASYNC_IMPORT_BATCH = 10_000;

/** Lifecycle status shared by async import jobs and sync jobs. */
export const JOB_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  PARTIALLY_COMPLETED: 'partially_completed',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;
export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

/** Terminal statuses (no further processing / eligible for payload cleanup). */
export const TERMINAL_JOB_STATUSES: JobStatus[] = [
  JOB_STATUS.PARTIALLY_COMPLETED,
  JOB_STATUS.COMPLETED,
  JOB_STATUS.FAILED,
  JOB_STATUS.CANCELLED,
];

export const ACTIVE_JOB_STATUSES: JobStatus[] = [JOB_STATUS.PENDING, JOB_STATUS.RUNNING];

/** Import mode. `atomic` is only honored where transactional support exists. */
export const IMPORT_MODE = {
  PARTIAL: 'partial',
  ATOMIC: 'atomic',
} as const;
export type ImportMode = (typeof IMPORT_MODE)[keyof typeof IMPORT_MODE];

/** Per-item status inside an import job (drives failed-item retry). */
export const IMPORT_ITEM_STATUS = {
  PENDING: 'pending',
  DONE: 'done',
  FAILED: 'failed',
} as const;
export type ImportItemStatus = (typeof IMPORT_ITEM_STATUS)[keyof typeof IMPORT_ITEM_STATUS];

/** Sync mode. */
export const SYNC_MODE = {
  FULL: 'full',
  INCREMENTAL: 'incremental',
} as const;
export type SyncMode = (typeof SYNC_MODE)[keyof typeof SYNC_MODE];

/** Persisted conflict lifecycle. */
export const CONFLICT_STATUS = {
  PENDING: 'pending',
  RESOLVED: 'resolved',
  IGNORED: 'ignored',
} as const;
export type ConflictStatus = (typeof CONFLICT_STATUS)[keyof typeof CONFLICT_STATUS];

/**
 * Why a conflict was raised. Safe machine-readable codes only — never free-form
 * text from an external system.
 */
export const CONFLICT_REASON = {
  /** Allowlisted field values diverge and the policy says report. */
  FIELD_DIVERGENCE: 'field_divergence',
  /** External staff record has no safe internal match; provisioning an account
   *  is a privileged action that an integration must never perform. */
  STAFF_REQUIRES_ACCOUNT: 'staff_requires_account',
  /** A referenced customer/staff/service/branch mapping could not be resolved. */
  MISSING_DEPENDENCY: 'missing_dependency',
  /** More than one internal record matched the external natural key. */
  AMBIGUOUS_MATCH: 'ambiguous_match',
  /** The external update is older than the current platform state. */
  STALE_UPDATE: 'stale_update',
  /** The requested change is not allowed by the domain lifecycle. */
  LIFECYCLE_NOT_ALLOWED: 'lifecycle_not_allowed',
} as const;
export type ConflictReason = (typeof CONFLICT_REASON)[keyof typeof CONFLICT_REASON];

/** How a persisted conflict was resolved. */
export const CONFLICT_RESOLUTION = {
  EXTERNAL_WINS: 'external_wins',
  PLATFORM_WINS: 'platform_wins',
  IGNORED: 'ignored',
} as const;
export type ConflictResolution = (typeof CONFLICT_RESOLUTION)[keyof typeof CONFLICT_RESOLUTION];

/**
 * Derived per-connection health state — NEVER inferred from row existence alone.
 * `disabled` = not active; `offline` = active but too many consecutive failures
 * or a stale last-success; `degraded` = active with some recent failures;
 * `healthy` = active, a recent success, and no recent failures.
 */
export const HEALTH_STATE = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  OFFLINE: 'offline',
  DISABLED: 'disabled',
} as const;
export type HealthState = (typeof HEALTH_STATE)[keyof typeof HEALTH_STATE];

/** Consecutive-failure thresholds for the health transition. */
export const HEALTH_DEGRADED_AT = 1;
export const HEALTH_OFFLINE_AT = 5;

/**
 * Operation classes for admission control. Each has its OWN limits and its own
 * Redis-unavailable policy — the read-only API's fail-OPEN behaviour is never
 * inherited by a write/import/sync/webhook (see IntegrationAdmissionService).
 */
export const ADMISSION_OP = {
  WRITE: 'write',
  IMPORT_CREATE: 'import.create',
  IMPORT_RETRY: 'import.retry',
  SYNC_START: 'sync.start',
  SYNC_RETRY: 'sync.retry',
  INBOUND_WEBHOOK: 'inbound.webhook',
  HEALTH_PROBE: 'health.probe',
} as const;
export type AdmissionOp = (typeof ADMISSION_OP)[keyof typeof ADMISSION_OP];

/**
 * Per-minute request limits per scope, plus concurrency/size caps. Values are
 * conservative defaults; each is overridable by env (see the admission service).
 */
export const ADMISSION_LIMITS: Record<
  AdmissionOp,
  { perKeyPerMin?: number; perTenantPerMin: number; perConnectionPerMin?: number }
> = {
  [ADMISSION_OP.WRITE]: { perKeyPerMin: 300, perTenantPerMin: 600, perConnectionPerMin: 300 },
  [ADMISSION_OP.IMPORT_CREATE]: { perTenantPerMin: 10, perConnectionPerMin: 5 },
  [ADMISSION_OP.IMPORT_RETRY]: { perTenantPerMin: 10, perConnectionPerMin: 5 },
  [ADMISSION_OP.SYNC_START]: { perTenantPerMin: 20, perConnectionPerMin: 10 },
  [ADMISSION_OP.SYNC_RETRY]: { perTenantPerMin: 20, perConnectionPerMin: 10 },
  [ADMISSION_OP.INBOUND_WEBHOOK]: { perTenantPerMin: 1200, perConnectionPerMin: 600 },
  [ADMISSION_OP.HEALTH_PROBE]: { perTenantPerMin: 60, perConnectionPerMin: 12 },
};

/** Max simultaneously active (pending|running) import jobs per tenant. */
export const MAX_CONCURRENT_IMPORT_JOBS = 3;
/** Max simultaneously active (pending|running) sync runs per tenant. */
export const MAX_CONCURRENT_SYNC_JOBS = 5;

/** Max accepted body size for a single M2M upsert payload. */
export const MAX_UPSERT_PAYLOAD_BYTES = 256 * 1024; // 256 KB
/** Max accepted inbound-webhook body size. */
export const MAX_WEBHOOK_BODY_BYTES = 512 * 1024; // 512 KB
