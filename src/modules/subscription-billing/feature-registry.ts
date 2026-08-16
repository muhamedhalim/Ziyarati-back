import {
  RESOURCE_LIMIT_MAP,
  ResourceMetric,
  USAGE_METRIC,
  UsageMetric,
} from './usage-metric';

/**
 * THE canonical list of clinic-facing platform capabilities.
 *
 * Before this registry existed, a feature key was a free-form string in three
 * unrelated places — `@RequireFeature('…')` on a controller, a row in
 * `feature_definitions` seeded by the bootstrap, and the alias list in
 * `USAGE_METRIC_FEATURE_KEYS` — with nothing tying them together. That is how
 * `@RequireFeature('ai')` came to gate 10 controllers while the catalog only
 * ever published `ai.assistant`: the key a super-admin could actually toggle
 * was not the key any route checked, and nothing failed at build time.
 *
 * Here the key is a TYPE. `@RequireFeature` accepts only `FeatureKey`, so that
 * whole class of drift is a compile error rather than a runtime 403, and
 * `FeatureCatalogBootstrap` SYNCS this registry into `feature_definitions` on
 * every boot (not "seed only when empty"), so `/platform/feature-flags` lists
 * every capability the code actually gates without anyone remembering to add a
 * row.
 *
 * String values are deliberately the ones already in the database — adding a
 * capability here is additive, and no existing `feature_flags` row changes
 * meaning. The one exception is `ai` → `ai.assistant`, which needs a data
 * migration (see `1730037000000-FeatureFlagProvenanceAndSuspension`).
 *
 * GRANULARITY RULE: one key per capability a super-admin would sell or switch
 * off, and enabling it must make that capability work END TO END. WhatsApp
 * templates, Meta onboarding, AI knowledge bases and AI handover are therefore
 * NOT separate keys — splitting them would let an operator "enable WhatsApp"
 * and still leave the clinic unable to connect a number or send a template,
 * which is the exact failure this work exists to remove. Sub-capabilities that
 * are genuinely optional get their own key (e.g. REVIEWS).
 */
export enum FeatureKey {
  /** Dashboard, tenant profile/settings — the shell every clinic always has. */
  CORE_WORKSPACE = 'core.workspace',
  /** Subscription, invoices, usage, upgrade requests. */
  BILLING = 'billing',
  /** Support tickets to the platform. */
  SUPPORT = 'support',

  APPOINTMENTS = 'appointments',
  SCHEDULING = 'scheduling',
  SERVICES = 'services',
  REVIEWS = 'reviews',
  CRM = 'crm',
  STAFF = 'staff',
  BRANCHES = 'branches',

  CONVERSATIONS = 'conversations',
  WHATSAPP = 'whatsapp',
  CAMPAIGNS = 'campaigns',
  NOTIFICATIONS = 'notifications',

  AI_ASSISTANT = 'ai.assistant',
  AUTOMATIONS = 'automations',

  PAYMENTS = 'payments',
  ANALYTICS = 'analytics',
  INTEGRATIONS = 'integrations',

  /** @deprecated Superseded by CAMPAIGNS + WHATSAPP; kept so the pre-existing
   *  `whatsapp.campaigns` catalog row still maps to a known key. */
  WHATSAPP_CAMPAIGNS = 'whatsapp.campaigns',
}

export interface FeatureSpec {
  name: string;
  description: string;
  category:
    | 'Core'
    | 'Communication'
    | 'Growth'
    | 'AI'
    | 'Payments'
    | 'Platform';
  /** Effective value for a tenant with no override row. */
  defaultEnabled: boolean;
  /**
   * Never gated. A tenant whose access is DENIED must still be able to pay and
   * ask for help, or the product has no recovery path out of a denial.
   */
  alwaysOn?: boolean;
  visibility?: 'public' | 'internal';
  isDeprecated?: boolean;
  /** The metered quota this capability consumes, when it has one. */
  usageMetric?: UsageMetric;
  /**
   * Capabilities this one cannot function without. A super-admin feature
   * override grants the toggled key AND this closure — nothing else. Declaring
   * it here (rather than letting the grant widen implicitly) is what keeps
   * "no other feature is opened" true AND makes an overridden WhatsApp actually
   * usable, since the WhatsApp inbox reads conversations and customers.
   */
  dependsOn: readonly FeatureKey[];
}

export const FEATURE_REGISTRY: Record<FeatureKey, FeatureSpec> = {
  [FeatureKey.CORE_WORKSPACE]: {
    name: 'Workspace',
    description: 'Dashboard, clinic profile and settings.',
    category: 'Core',
    defaultEnabled: true,
    alwaysOn: true,
    dependsOn: [],
  },
  [FeatureKey.BILLING]: {
    name: 'Subscription & Billing',
    description: 'Plans, invoices, usage and upgrade requests.',
    category: 'Platform',
    defaultEnabled: true,
    alwaysOn: true,
    dependsOn: [],
  },
  [FeatureKey.SUPPORT]: {
    name: 'Support',
    description: 'Support tickets to the platform team.',
    category: 'Platform',
    defaultEnabled: true,
    alwaysOn: true,
    dependsOn: [],
  },

  [FeatureKey.APPOINTMENTS]: {
    name: 'Appointments',
    description: 'Booking, calendar and appointment lifecycle.',
    category: 'Core',
    defaultEnabled: true,
    usageMetric: USAGE_METRIC.APPOINTMENTS,
    dependsOn: [FeatureKey.SERVICES, FeatureKey.SCHEDULING, FeatureKey.CRM],
  },
  [FeatureKey.SCHEDULING]: {
    name: 'Scheduling',
    description: 'Availability, calendar slots, blocked slots and holidays.',
    category: 'Core',
    defaultEnabled: true,
    dependsOn: [FeatureKey.STAFF],
  },
  [FeatureKey.SERVICES]: {
    name: 'Services',
    description: 'Bookable service catalogue and categories.',
    category: 'Core',
    defaultEnabled: true,
    dependsOn: [],
  },
  [FeatureKey.REVIEWS]: {
    name: 'Reviews',
    description: 'Customer reviews and replies.',
    category: 'Growth',
    defaultEnabled: true,
    dependsOn: [FeatureKey.APPOINTMENTS],
  },
  [FeatureKey.CRM]: {
    name: 'Patients & CRM',
    description: 'Customer records, profiles, tags, notes and addresses.',
    category: 'Core',
    defaultEnabled: true,
    dependsOn: [],
  },
  [FeatureKey.STAFF]: {
    name: 'Doctors & Staff',
    description: 'Staff members, roles and working hours.',
    category: 'Core',
    defaultEnabled: true,
    dependsOn: [],
  },
  [FeatureKey.BRANCHES]: {
    name: 'Branches',
    description: 'Multi-branch clinic structure.',
    category: 'Core',
    defaultEnabled: true,
    dependsOn: [],
  },

  [FeatureKey.CONVERSATIONS]: {
    name: 'Conversations',
    description: 'Unified message timeline, participants and assignment.',
    category: 'Communication',
    defaultEnabled: true,
    dependsOn: [FeatureKey.CRM],
  },
  [FeatureKey.WHATSAPP]: {
    name: 'WhatsApp',
    description: 'WhatsApp accounts, contacts and messaging.',
    category: 'Communication',
    defaultEnabled: false,
    usageMetric: USAGE_METRIC.WHATSAPP_MESSAGES,
    dependsOn: [FeatureKey.CONVERSATIONS, FeatureKey.CRM],
  },
  [FeatureKey.CAMPAIGNS]: {
    name: 'Campaigns',
    description: 'Bulk outbound campaigns and recipient management.',
    category: 'Growth',
    defaultEnabled: false,
    usageMetric: USAGE_METRIC.CAMPAIGNS,
    dependsOn: [FeatureKey.WHATSAPP, FeatureKey.CRM],
  },
  [FeatureKey.NOTIFICATIONS]: {
    name: 'Notifications',
    description: 'Automated notification rules, templates and scheduling.',
    category: 'Communication',
    defaultEnabled: true,
    dependsOn: [],
  },

  [FeatureKey.AI_ASSISTANT]: {
    name: 'AI Assistant',
    description: 'AI agents, prompts, conversations and the booking assistant.',
    category: 'AI',
    defaultEnabled: false,
    usageMetric: USAGE_METRIC.AI_TOKENS,
    dependsOn: [FeatureKey.CONVERSATIONS, FeatureKey.CRM],
  },
  [FeatureKey.AUTOMATIONS]: {
    name: 'Automations',
    description: 'Workflow automation rules and runs.',
    category: 'AI',
    defaultEnabled: true,
    dependsOn: [FeatureKey.NOTIFICATIONS],
  },

  [FeatureKey.PAYMENTS]: {
    name: 'Payments',
    description: 'Online payments, invoices, refunds and settlements.',
    category: 'Payments',
    defaultEnabled: true,
    dependsOn: [FeatureKey.CRM],
  },
  [FeatureKey.ANALYTICS]: {
    name: 'Reports & Analytics',
    description: 'Dashboards, daily and monthly reports.',
    category: 'Core',
    defaultEnabled: true,
    dependsOn: [],
  },
  [FeatureKey.INTEGRATIONS]: {
    name: 'Integrations & API',
    description:
      'External connections, sync, imports, API keys and outbound webhooks.',
    category: 'Platform',
    defaultEnabled: true,
    dependsOn: [],
  },

  [FeatureKey.WHATSAPP_CAMPAIGNS]: {
    name: 'WhatsApp Campaigns (legacy)',
    description: 'Superseded by Campaigns; retained so existing rows resolve.',
    category: 'Communication',
    defaultEnabled: false,
    isDeprecated: true,
    visibility: 'internal',
    dependsOn: [FeatureKey.CAMPAIGNS],
  },
};

export const FEATURE_KEYS = Object.keys(FEATURE_REGISTRY) as FeatureKey[];

const FEATURE_KEY_SET: ReadonlySet<string> = new Set<string>(FEATURE_KEYS);

/**
 * Narrowing guard for keys arriving from the database or an API body.
 *
 * Backed by a Set rather than `key in FEATURE_REGISTRY`: `in` walks the
 * prototype chain, so an attacker-supplied `"constructor"` / `"toString"`
 * would validate as a real feature key and get written into `feature_flags`.
 */
export function isFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === 'string' && FEATURE_KEY_SET.has(value);
}

export function featureSpec(key: FeatureKey): FeatureSpec {
  return FEATURE_REGISTRY[key];
}

/** Keys that can never be gated — a denied tenant must still reach these. */
export const ALWAYS_ON_FEATURES: readonly FeatureKey[] = FEATURE_KEYS.filter(
  (k) => FEATURE_REGISTRY[k].alwaysOn === true,
);

/**
 * The transitive `dependsOn` closure of `key`, EXCLUDING `key` itself.
 *
 * This is what a super-admin feature override actually grants alongside the
 * key that was toggled: enabling WhatsApp without Conversations and CRM
 * produces an inbox that 403s on every panel it renders, which is the
 * "WhatsApp works end-to-end" requirement failing for a reason that has
 * nothing to do with WhatsApp. Cycle-guarded (a malformed registry logs
 * nothing and simply stops descending) so this can never hang a request.
 */
export function dependencyClosure(key: FeatureKey): FeatureKey[] {
  const out = new Set<FeatureKey>();
  const walk = (k: FeatureKey): void => {
    for (const dep of FEATURE_REGISTRY[k]?.dependsOn ?? []) {
      if (out.has(dep) || dep === key) continue;
      out.add(dep);
      walk(dep);
    }
  };
  walk(key);
  return [...out];
}

/**
 * True when `granted` (a key with an active override) entitles `wanted` —
 * either because they are the same capability or because `wanted` is in
 * `granted`'s declared closure.
 */
export function grantCovers(granted: FeatureKey, wanted: FeatureKey): boolean {
  return granted === wanted || dependencyClosure(granted).includes(wanted);
}

/**
 * The feature(s) a metered metric belongs to, DERIVED from each spec's
 * `usageMetric` rather than maintained as a second list.
 *
 * `USAGE_METRIC_FEATURE_KEYS` in `usage-metric.ts` was that second list, and
 * it is exactly where the `['ai', 'ai.assistant']` alias had to be hand-written
 * to paper over the key drift. Deriving removes the possibility of the two
 * disagreeing; `usage-metric.ts` stays a leaf module (no import back into the
 * registry) so nothing here creates a cycle.
 */
export function featuresForMetric(metric: UsageMetric): FeatureKey[] {
  return FEATURE_KEYS.filter((k) => FEATURE_REGISTRY[k].usageMetric === metric);
}

/**
 * The capability every COUNT-based plan cap belongs to — all 15 of them.
 *
 * Count caps live on the plan, not on a metered counter, so they used to be
 * checked with an UNSCOPED enforcement question: `isEnforced(tenantId)` with no
 * capability named. That reported "enforced" for a tenant running on a
 * super-admin feature grant and then demanded a subscription that by design
 * does not exist, failing branch creation and staff invites with a bare 404.
 * Naming the capability lets every cap ask the same scoped question the metered
 * paths ask, so a grant unmeters exactly what it granted and nothing else.
 *
 * Mapping this table completely is independent of whether a given cap is
 * ENFORCED (see {@link ENFORCED_RESOURCE_LIMITS}) — a reporting-only limit
 * still needs the right capability to render "unlimited" correctly for an
 * override tenant in the platform usage view.
 */
export const RESOURCE_LIMIT_FEATURE: Readonly<
  Record<ResourceMetric, FeatureKey>
> = {
  // Enforced at a mutation seam.
  branches: FeatureKey.BRANCHES,
  employees: FeatureKey.STAFF,
  customers: FeatureKey.CRM,
  storageBytes: FeatureKey.CORE_WORKSPACE,
  uploadedFiles: FeatureKey.CORE_WORKSPACE,
  knowledgeBaseFiles: FeatureKey.AI_ASSISTANT,
  trainingFiles: FeatureKey.AI_ASSISTANT,
  // Reporting-only — see ENFORCED_RESOURCE_LIMITS for why each one is.
  aiRequests: FeatureKey.AI_ASSISTANT,
  crmContacts: FeatureKey.WHATSAPP,
  conversations: FeatureKey.CONVERSATIONS,
  apiCalls: FeatureKey.INTEGRATIONS,
  emails: FeatureKey.NOTIFICATIONS,
  invoices: FeatureKey.PAYMENTS,
  payments: FeatureKey.PAYMENTS,
  transactions: FeatureKey.PAYMENTS,
};

/**
 * The count caps that are actually ENFORCED at a domain mutation seam.
 *
 * Every entry in {@link RESOURCE_LIMIT_FEATURE} has a `subscription_plans`
 * column, but a column is not a reason to refuse a write. Each one was reviewed
 * against a single question: "is there a deliberate, clinic-initiated action
 * this cap should refuse, and is refusing it better than recording it?".
 *
 * ENFORCED (7):
 *  - `branches`, `employees` — deliberate admin actions, already enforced
 *    (`BranchService.create`, `UsageService.assertUserSeatWithinLimit`).
 *  - `customers` — an explicit "add patient" action (`CustomerService.create`).
 *    NOT applied to `findOrCreateForBooking`: refusing there would break a
 *    booking mid-flow for a patient who is already talking to the clinic.
 *  - `storageBytes`, `uploadedFiles` — an explicit upload
 *    (`FileUploadService.register`), which already enforces a platform-wide
 *    `TENANT_QUOTA_GB`; the plan cap is applied alongside it, and the LOWER of
 *    the two wins because both are checked.
 *  - `knowledgeBaseFiles`, `trainingFiles` — explicit AI content uploads.
 *
 * REPORTING-ONLY, and why (8) — these stay visible in the platform usage view
 * and in `getUnifiedBreakdown`, they are simply never used to refuse a write:
 *  - `aiRequests` — the same consumption `AI_TOKENS` already caps atomically
 *    per turn. A second cap on the same hot path would cost an extra aggregate
 *    read per AI turn to enforce a limit that is already binding.
 *  - `crmContacts` (`whatsapp_contacts`) and `conversations` — created almost
 *    entirely by INBOUND customer messages. Refusing to create them would
 *    silently discard real customer conversations, which is a worse outcome
 *    than exceeding a soft cap; the same reasoning that leaves the WhatsApp
 *    webhook job un-gated (see `job-authorization.constants.ts`).
 *  - `emails` — `email_logs` includes password resets and security
 *    notifications. A cap here could lock a clinic out of its own account.
 *  - `apiCalls` — already governed by the per-tenant token-bucket limiter
 *    (`TenantRateLimiterService`), which is the operative control and is O(1)
 *    in Redis. Enforcing the monthly plan cap would need a live `COUNT(*)` over
 *    `api_logs` on every API-key request.
 *  - `invoices`, `payments`, `transactions` — records of money that has ALREADY
 *    moved. Refusing to write one does not prevent the payment; it only
 *    destroys the record of it, which is a financial-integrity bug, not a
 *    quota.
 */
export const ENFORCED_RESOURCE_LIMITS: ReadonlySet<ResourceMetric> =
  new Set<ResourceMetric>([
    'branches',
    'employees',
    'customers',
    'storageBytes',
    'uploadedFiles',
    'knowledgeBaseFiles',
    'trainingFiles',
  ]);

/**
 * The capability each count cap belongs to, keyed by its PLAN COLUMN.
 *
 * Derived from {@link RESOURCE_LIMIT_FEATURE} rather than hand-written, so the
 * column-keyed and metric-keyed views can never disagree. Note that
 * `max_branches`/`max_users` are each named by exactly one metric
 * (`branches`/`employees`), so the derivation is unambiguous.
 */
export const COUNT_LIMIT_FEATURE: Readonly<Record<string, FeatureKey>> =
  Object.fromEntries(
    (Object.keys(RESOURCE_LIMIT_MAP) as ResourceMetric[]).map((metric) => [
      RESOURCE_LIMIT_MAP[metric],
      RESOURCE_LIMIT_FEATURE[metric],
    ]),
  );
