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
  /** One bearer-style secret sent as `Authorization: Bearer <token>`. Labelled "Bearer token" in the UI. */
  SECRET: 'secret',
  /** HTTP Basic — username lives in `config.basic.username` (non-secret), password is the encrypted credential. */
  BASIC: 'basic',
  OAUTH2: 'oauth2',
} as const;
export type ConnectionAuthType =
  (typeof CONNECTION_AUTH_TYPE)[keyof typeof CONNECTION_AUTH_TYPE];

/** Where an API-key auth type places the key on the outgoing request. */
export const API_KEY_LOCATION = {
  HEADER: 'header',
  QUERY: 'query',
} as const;
export type ApiKeyLocation = (typeof API_KEY_LOCATION)[keyof typeof API_KEY_LOCATION];
export const API_KEY_LOCATIONS: ApiKeyLocation[] = Object.values(API_KEY_LOCATION);

/**
 * Bounded pagination strategies a Generic REST adapter may use to page through
 * a resource collection. Deliberately a small closed set — never an arbitrary
 * tenant-supplied paging scheme — so the adapter's request-building stays
 * predictable and cannot be coerced into unbounded or malformed requests.
 */
export const PAGINATION_STRATEGY = {
  /** Single page; no further requests are made. */
  NONE: 'none',
  /** `?{pageParam}=N&{sizeParam}=size`, N starting at 1. */
  PAGE_NUMBER: 'page_number',
  /** `?{cursorParam}=<opaque token>` returned by the provider's previous page. */
  CURSOR_PARAM: 'cursor_param',
} as const;
export type PaginationStrategy = (typeof PAGINATION_STRATEGY)[keyof typeof PAGINATION_STRATEGY];
export const PAGINATION_STRATEGIES: PaginationStrategy[] = Object.values(PAGINATION_STRATEGY);

/** Which side is recorded as the owner/creator of a mapped record. */
export const MAPPING_SOURCE = {
  EXTERNAL: 'external',
  PLATFORM: 'platform',
} as const;
export type MappingSource = (typeof MAPPING_SOURCE)[keyof typeof MAPPING_SOURCE];

/** Why a mapping was unlinked — safe machine-readable codes only. */
export const UNLINK_REASON = {
  /** A tenant admin unlinked it deliberately. */
  MANUAL: 'manual',
  /** Replaced by a relink to a different internal record. */
  SUPERSEDED: 'superseded',
  /** Carried over to a replacement connection during a reconnect. */
  CONNECTION_REPLACED: 'connection_replaced',
} as const;
export type UnlinkReason = (typeof UNLINK_REASON)[keyof typeof UNLINK_REASON];

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
  /**
   * True when this provider has a REAL coded HTTP adapter that talks to a
   * tenant-supplied base URL (see providers/generic-rest.adapter.ts). Only
   * true for providers with an actual registered adapter — never a signal
   * that arbitrary endpoint configuration is safe on its own.
   */
  requiresBaseUrl: boolean;
}

export const INTEGRATION_PROVIDERS: Record<string, IntegrationProviderDef> = {
  generic_rest: {
    key: 'generic_rest',
    label: 'Generic REST / PMS-EMR',
    authTypes: [
      CONNECTION_AUTH_TYPE.NONE,
      CONNECTION_AUTH_TYPE.API_KEY,
      CONNECTION_AUTH_TYPE.SECRET,
      CONNECTION_AUTH_TYPE.BASIC,
    ],
    oauth: false,
    requiresBaseUrl: true,
  },
  custom: {
    key: 'custom',
    label: 'Custom clinic system',
    // No coded adapter exists for "custom" — it stays a credential-shape-only
    // placeholder (see BuiltinRestAdapter). No base URL is accepted for it,
    // rather than offering endpoint configuration with nothing to execute it.
    authTypes: [CONNECTION_AUTH_TYPE.API_KEY, CONNECTION_AUTH_TYPE.SECRET, CONNECTION_AUTH_TYPE.NONE],
    oauth: false,
    requiresBaseUrl: false,
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

/** Sync mode. `full` ignores the stored watermark and re-scans from the start. */
export const SYNC_MODE = {
  FULL: 'full',
  INCREMENTAL: 'incremental',
} as const;
export type SyncMode = (typeof SYNC_MODE)[keyof typeof SYNC_MODE];

/**
 * What a provider's cursor token actually is. The engine treats every cursor as
 * OPAQUE regardless — this is documentation for operators, and it is what an
 * adapter declares, never something a tenant sets.
 */
export const CURSOR_KIND = {
  /** Provider-defined token; never parsed or ordered by the platform. */
  OPAQUE: 'opaque',
  TIMESTAMP: 'timestamp',
  VERSION: 'version',
  SEQUENCE: 'sequence',
} as const;
export type CursorKind = (typeof CURSOR_KIND)[keyof typeof CURSOR_KIND];

/** Why a sync run stopped — a bounded stop is not an end-of-stream. */
export const SYNC_STOP_REASON = {
  COMPLETED: 'completed',
  MAX_PAGES: 'max_pages',
  MAX_RECORDS: 'max_records',
  MAX_RUNTIME: 'max_runtime',
  /** The provider returned the same cursor with more pages claimed — a loop. */
  REPEATED_CURSOR: 'repeated_cursor',
  CANCELLED: 'cancelled',
  /** A record in the page could not be handled; the cursor was NOT advanced. */
  ITEM_FAILURE: 'item_failure',
  ERROR: 'error',
} as const;
export type SyncStopReason = (typeof SYNC_STOP_REASON)[keyof typeof SYNC_STOP_REASON];

/** Safety bounds for ONE sync run. A runaway provider can never hold a worker. */
export const MAX_SYNC_PAGES = 1_000;
export const MAX_SYNC_RECORDS = 100_000;
export const MAX_SYNC_RUNTIME_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Persisted conflict lifecycle.
 *
 * `resolving` is a short-lived CLAIM state: a resolver moves pending → resolving
 * with a conditional UPDATE, so two admins pressing "resolve" concurrently can
 * never both apply an outcome (the loser sees 409). `stale` means the internal
 * record changed after the conflict was raised — the stored external snapshot can
 * no longer be applied blindly and the conflict must be re-reviewed.
 */
export const CONFLICT_STATUS = {
  PENDING: 'pending',
  RESOLVING: 'resolving',
  STALE: 'stale',
  RESOLVED: 'resolved',
  IGNORED: 'ignored',
} as const;
export type ConflictStatus = (typeof CONFLICT_STATUS)[keyof typeof CONFLICT_STATUS];

/** Conflict states that still need a human decision. */
export const OPEN_CONFLICT_STATUSES: ConflictStatus[] = [
  CONFLICT_STATUS.PENDING,
  CONFLICT_STATUS.RESOLVING,
  CONFLICT_STATUS.STALE,
];

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

/**
 * Staff provisioning review lifecycle. An external system can only ever put a
 * request into an OPEN state — approving it (and choosing the role) is a
 * platform-admin action.
 */
export const STAFF_PROVISIONING_STATUS = {
  PENDING: 'pending',
  /** More than one internal candidate matched — a human must choose. */
  AMBIGUOUS: 'ambiguous',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  /** Resolved by linking to an existing staff member (no account created). */
  LINKED: 'linked',
} as const;
export type StaffProvisioningStatus =
  (typeof STAFF_PROVISIONING_STATUS)[keyof typeof STAFF_PROVISIONING_STATUS];

export const OPEN_PROVISIONING_STATUSES: StaffProvisioningStatus[] = [
  STAFF_PROVISIONING_STATUS.PENDING,
  STAFF_PROVISIONING_STATUS.AMBIGUOUS,
];

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
  /** Test-connection probe against an UNSAVED draft config — real outbound I/O. */
  CONNECTION_TEST: 'connection.test',
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
  [ADMISSION_OP.CONNECTION_TEST]: { perTenantPerMin: 30, perConnectionPerMin: 10 },
};

/** Max simultaneously active (pending|running) import jobs per tenant. */
export const MAX_CONCURRENT_IMPORT_JOBS = 3;
/** Max simultaneously active (pending|running) sync runs per tenant. */
export const MAX_CONCURRENT_SYNC_JOBS = 5;

/** Max accepted body size for a single M2M upsert payload. */
export const MAX_UPSERT_PAYLOAD_BYTES = 256 * 1024; // 256 KB
/** Max accepted inbound-webhook body size. */
export const MAX_WEBHOOK_BODY_BYTES = 512 * 1024; // 512 KB

// ── Inbound webhooks ────────────────────────────────────────────────────────

/** Inbound webhook endpoint lifecycle. */
export const WEBHOOK_ENDPOINT_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
} as const;
export type WebhookEndpointStatus =
  (typeof WEBHOOK_ENDPOINT_STATUS)[keyof typeof WEBHOOK_ENDPOINT_STATUS];

/**
 * The ONLY inbound event types the platform will act on. An event outside this
 * compiled allowlist is recorded as rejected and never reaches the write
 * pipeline — a provider cannot invent an event that maps to an arbitrary action.
 * Each entry names exactly one resource and one lifecycle intent.
 */
export const INBOUND_EVENT = {
  CUSTOMER_UPSERTED: 'customer.upserted',
  SERVICE_UPSERTED: 'service.upserted',
  STAFF_UPSERTED: 'staff.upserted',
  APPOINTMENT_CREATED: 'appointment.created',
  APPOINTMENT_RESCHEDULED: 'appointment.rescheduled',
  APPOINTMENT_CANCELLED: 'appointment.cancelled',
} as const;
export type InboundEvent = (typeof INBOUND_EVENT)[keyof typeof INBOUND_EVENT];
export const INBOUND_EVENTS: InboundEvent[] = Object.values(INBOUND_EVENT);

/** Event type → (resource, lifecycle action hint) handed to the shared pipeline. */
export const INBOUND_EVENT_MAP: Record<
  InboundEvent,
  { resource: IntegrationResource; action?: 'reschedule' | 'cancel' }
> = {
  [INBOUND_EVENT.CUSTOMER_UPSERTED]: { resource: INTEGRATION_RESOURCE.CUSTOMER },
  [INBOUND_EVENT.SERVICE_UPSERTED]: { resource: INTEGRATION_RESOURCE.SERVICE },
  [INBOUND_EVENT.STAFF_UPSERTED]: { resource: INTEGRATION_RESOURCE.STAFF },
  [INBOUND_EVENT.APPOINTMENT_CREATED]: { resource: INTEGRATION_RESOURCE.APPOINTMENT },
  [INBOUND_EVENT.APPOINTMENT_RESCHEDULED]: {
    resource: INTEGRATION_RESOURCE.APPOINTMENT,
    action: 'reschedule',
  },
  [INBOUND_EVENT.APPOINTMENT_CANCELLED]: {
    resource: INTEGRATION_RESOURCE.APPOINTMENT,
    action: 'cancel',
  },
};

/** Lifecycle of one received inbound event. */
export const INBOUND_STATUS = {
  /** Verified + persisted, waiting for the worker. */
  ACCEPTED: 'accepted',
  /** A worker has claimed it. */
  PROCESSING: 'processing',
  /** Applied through the shared write pipeline. */
  PROCESSED: 'processed',
  /** Applied but the pipeline raised a conflict for review. */
  CONFLICTED: 'conflicted',
  /** Verified but processing failed after its retries. */
  FAILED: 'failed',
  /** Never accepted — see `rejection_reason`. */
  REJECTED: 'rejected',
  /** A duplicate of an event already received (safe no-op ack). */
  DUPLICATE: 'duplicate',
} as const;
export type InboundStatus = (typeof INBOUND_STATUS)[keyof typeof INBOUND_STATUS];

export const TERMINAL_INBOUND_STATUSES: InboundStatus[] = [
  INBOUND_STATUS.PROCESSED,
  INBOUND_STATUS.CONFLICTED,
  INBOUND_STATUS.FAILED,
  INBOUND_STATUS.REJECTED,
  INBOUND_STATUS.DUPLICATE,
];

/**
 * Safe machine-readable rejection codes. NEVER free-form provider text — the
 * rejection history must be explainable without echoing anything the caller sent.
 */
export const INBOUND_REJECTION = {
  NO_ENDPOINT: 'no_endpoint',
  ENDPOINT_INACTIVE: 'endpoint_inactive',
  CONNECTION_INACTIVE: 'connection_inactive',
  MISSING_SIGNATURE: 'missing_signature',
  INVALID_SIGNATURE: 'invalid_signature',
  MISSING_TIMESTAMP: 'missing_timestamp',
  STALE_TIMESTAMP: 'stale_timestamp',
  FUTURE_TIMESTAMP: 'future_timestamp',
  REPLAYED: 'replayed',
  EVENT_NOT_ALLOWED: 'event_not_allowed',
  UNSUPPORTED_EVENT: 'unsupported_event',
  MISSING_EVENT_ID: 'missing_event_id',
  MISSING_EXTERNAL_ID: 'missing_external_id',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  PROTECTED_FIELDS: 'protected_fields',
  MALFORMED: 'malformed',
} as const;
export type InboundRejection = (typeof INBOUND_REJECTION)[keyof typeof INBOUND_REJECTION];

/** Compiled signature schemes. A tenant selects one; it can never supply code. */
export const WEBHOOK_SIGNATURE_SCHEME = {
  /** HMAC-SHA256 over `"{timestamp}.{rawBody}"`, header `sha256=<hex>`. */
  HMAC_SHA256_TIMESTAMPED: 'hmac_sha256_timestamped',
  /** HMAC-SHA256 over the raw body alone, header `sha256=<hex>`. */
  HMAC_SHA256_BODY: 'hmac_sha256_body',
} as const;
export type WebhookSignatureScheme =
  (typeof WEBHOOK_SIGNATURE_SCHEME)[keyof typeof WEBHOOK_SIGNATURE_SCHEME];
export const WEBHOOK_SIGNATURE_SCHEMES: WebhookSignatureScheme[] =
  Object.values(WEBHOOK_SIGNATURE_SCHEME);

/** Inbound request headers the platform reads. */
export const INBOUND_HEADER = {
  SIGNATURE: 'x-ziyarati-signature',
  TIMESTAMP: 'x-ziyarati-timestamp',
  EVENT_ID: 'x-ziyarati-event-id',
  EVENT_TYPE: 'x-ziyarati-event',
} as const;

/**
 * Default replay window. A signature is only honoured while its timestamp is
 * within ±this many seconds of now, which bounds how long a captured request
 * stays useful; the persisted event id then blocks the replay outright.
 */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;
/** Hard ceiling a tenant may configure for the tolerance above. */
export const WEBHOOK_MAX_TOLERANCE_SECONDS = 900;
/** How long delivery history (and its replay guard) is retained. */
export const INBOUND_EVENT_RETENTION_DAYS = 30;
