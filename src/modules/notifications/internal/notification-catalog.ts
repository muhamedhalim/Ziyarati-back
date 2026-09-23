import { PERMISSION } from '../../../rbac/rbac.constants';
import {
  NOTIFICATION_CATEGORY,
  NOTIFICATION_PRIORITY,
  NOTIFICATION_SCOPE,
  NOTIFICATION_LOCALES,
  DEFAULT_NOTIFICATION_LOCALE,
  type NotificationCategory,
  type NotificationLocale,
  type NotificationPriority,
  type NotificationScope,
} from './notification-keys';
import {
  platformPermission,
  tenantPermission,
  type RecipientPolicy,
} from './notification-recipient.policy';
import {
  freeAccessExpiryNotificationDedupe,
  freeAccessStartNotificationDedupe,
} from '../../subscription-billing/free-access-notice-keys';

/**
 * ============================================================================
 *  INTERNAL NOTIFICATION CATALOG — SINGLE SOURCE OF TRUTH
 * ============================================================================
 *
 * Every internal (staff-facing, in-app) notification the platform can produce
 * is declared here, in code, and nowhere else.
 *
 * WHY CODE AND NOT DATABASE ROWS. The outbound patient pipeline is
 * tenant-configured: a clinic authors `notification_templates` and binds them
 * with `notification_rules`. That model is right for patient messaging and
 * wrong here, for one decisive reason — a fresh tenant has ZERO rules and ZERO
 * templates (there is no seeder for either), so under a tenant-rules model
 * every internal notification would be silent until somebody configured it.
 * That is precisely the failure this system exists to fix. A code catalog is
 * always on, needs no setup, cannot be misconfigured into silence, and cannot
 * have its security notifications switched off by a tenant administrator.
 *
 * WHAT A SPEC OWNS. Everything a `notification_rules` row would have owned —
 * activation, recipients, priority, category, dedupe strategy and cooldown —
 * plus the two things that table never modelled: bilingual copy and a
 * mandatory flag. Conditions are ordinary TypeScript in the listener, not an
 * operator DSL, because there is no tenant author to serve one to.
 *
 * WHAT A SPEC DOES NOT OWN. Scheduling. Internal notifications are always
 * immediate; anything time-anchored is produced by an existing repeatable
 * sweep that emits a domain event, which then flows through here like any
 * other. One delivery path, no second scheduler.
 *
 * Invariants are enforced by `notification-catalog.spec.ts`, so a malformed
 * catalog fails CI rather than production.
 */

/** Variables, pre-normalized to display strings. See `renderNotification`. */
export type RenderVars = Readonly<Record<string, string>>;

export interface RenderedNotification {
  title: string;
  body: string;
}

export interface NotificationSpec {
  /** Which clinic-or-platform axis this notification lives on. */
  readonly scope: NotificationScope;
  readonly category: NotificationCategory;
  readonly priority: NotificationPriority;
  /** Who receives it. Executed only by `NotificationRecipientResolver`. */
  readonly recipients: RecipientPolicy;
  /**
   * `true` ⇒ a user preference can never suppress it.
   *
   * Reserved for notifications whose absence would leave someone unable to act
   * on something that materially affects them or their security. Enforced in
   * two independent places (the preferences write path AND the emit path), so
   * a row inserted straight into the database still cannot mute it.
   */
  readonly mandatory: boolean;
  /**
   * Variable names the renderers may read. Declared rather than inferred so
   * the spec test can prove the renderers and the producers agree, and so a
   * missing value becomes a visible placeholder instead of `undefined`.
   */
  readonly variables: readonly string[];
  /**
   * Stable business key for idempotency, or `null` to always insert.
   *
   * Unique PER RECIPIENT (see the migration), so it never needs to embed a
   * tenant or user id. Embedding a coarse time bucket turns it into a
   * cooldown — `HANDOVER_CUSTOMER_REPLIED` uses that so a chatty patient
   * produces one notification per window instead of one per message.
   */
  readonly dedupe: (ctx: NotificationEmitContext) => string | null;
  /** RELATIVE in-app path. The frontend adds origin and locale prefix. */
  readonly link: (ctx: NotificationEmitContext) => string | null;
  readonly entity?: (
    ctx: NotificationEmitContext,
  ) => { type: string; id?: string } | null;
  readonly render: Readonly<
    Record<NotificationLocale, (v: RenderVars) => RenderedNotification>
  >;
}

/**
 * What a producer hands `InternalNotificationService.emit`.
 *
 * `variables` is the only part the renderers see. The rest steers recipient
 * resolution, dedupe and linking.
 */
export interface NotificationEmitContext {
  /** The clinic this concerns. `null` for a platform-scope notification. */
  readonly tenantId: string | null;
  /**
   * Who caused the event, when a user did. Excluded from recipients by
   * default — nobody is notified about their own action.
   */
  readonly actorUserId?: string | null;
  /** Feeds `SPECIFIC_USERS` policies (e.g. the assignee of a handover). */
  readonly targetUserIds?: readonly (string | null | undefined)[];
  readonly variables?: Readonly<Record<string, unknown>>;
  /** Free-form ids the `dedupe`/`link`/`entity` functions read. */
  readonly refs?: Readonly<Record<string, string | null | undefined>>;
}

/** Shown in place of a variable the producer did not supply. */
export const MISSING_VARIABLE_PLACEHOLDER = '—';

/** Longest a free-text preview may be before it is elided. */
const PREVIEW_MAX = 140;

/**
 * Collapses arbitrary user-authored text to a short single-line preview.
 *
 * Notification bodies are rendered as TEXT by the frontend (never as HTML), so
 * this is not an escaping boundary — it exists so a 4,000-character ticket
 * reply does not become a 4,000-character notification row, and so newlines do
 * not break the single-line inbox layout.
 */
export function preview(text: string | null | undefined): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat;
}

const ref = (ctx: NotificationEmitContext, name: string): string | null =>
  ctx.refs?.[name] ?? null;

// ─────────────────────────────── The catalog ─────────────────────────────── //

/**
 * Phase 1 delivers the SUPPORT family — the reported bug and its mirror image.
 * Later phases append ACCOUNT/SECURITY/BILLING, then APPOINTMENTS/
 * CONVERSATIONS, then SYSTEM. Adding one is: a domain event, an emit, one
 * entry here, one `@OnEvent`. No module learns anything about notifications.
 */
export const NOTIFICATION_CATALOG = {
  /**
   * THE REPORTED BUG. Platform staff reply to a clinic's ticket; before this
   * key existed, `SupportTicketService.addPlatformReply` wrote a
   * `SupportTicketEvent` row and stopped — the clinic found out only if
   * somebody happened to reopen the ticket.
   */
  SUPPORT_TICKET_REPLIED: {
    scope: NOTIFICATION_SCOPE.TENANT,
    category: NOTIFICATION_CATEGORY.SUPPORT,
    priority: NOTIFICATION_PRIORITY.HIGH,
    // Everyone who can read the clinic's tickets — not just the ticket's
    // author, who may be on leave or no longer employed.
    recipients: tenantPermission(PERMISSION.SUPPORT_TICKETS_READ),
    // A support answer is the clinic's only channel to the platform; a user
    // must not be able to mute themselves out of hearing it.
    mandatory: true,
    variables: ['ticketNumber', 'subject', 'responderName', 'preview'],
    // Keyed on the EVENT row, not the ticket: a second reply is genuinely a
    // second notification, but a redelivery of the same reply is not.
    dedupe: (ctx) => {
      const eventId = ref(ctx, 'eventId');
      return eventId ? `ticket:reply:${eventId}` : null;
    },
    link: (ctx) => {
      const ticketId = ref(ctx, 'ticketId');
      return ticketId ? `/app/support?ticket=${ticketId}` : '/app/support';
    },
    entity: (ctx) => ({
      type: 'SupportTicket',
      id: ref(ctx, 'ticketId') ?? undefined,
    }),
    render: {
      en: (v) => ({
        title: `New reply on ticket ${v.ticketNumber}`,
        body: `${v.responderName} replied to "${v.subject}": ${v.preview}`,
      }),
      ar: (v) => ({
        title: `رد جديد على التذكرة ${v.ticketNumber}`,
        body: `قام ${v.responderName} بالرد على "${v.subject}": ${v.preview}`,
      }),
    },
  },

  /**
   * The clinic must know when support moves a ticket — above all to `resolved`,
   * because only the clinic can then confirm and close it
   * (`closeOwnTicket` requires `status === 'resolved'`), or reopen it.
   */
  SUPPORT_TICKET_STATUS_CHANGED: {
    scope: NOTIFICATION_SCOPE.TENANT,
    category: NOTIFICATION_CATEGORY.SUPPORT,
    priority: NOTIFICATION_PRIORITY.NORMAL,
    recipients: tenantPermission(PERMISSION.SUPPORT_TICKETS_READ),
    mandatory: false,
    variables: ['ticketNumber', 'subject', 'fromStatus', 'toStatus'],
    dedupe: (ctx) => {
      const eventId = ref(ctx, 'eventId');
      return eventId ? `ticket:status:${eventId}` : null;
    },
    link: (ctx) => {
      const ticketId = ref(ctx, 'ticketId');
      return ticketId ? `/app/support?ticket=${ticketId}` : '/app/support';
    },
    entity: (ctx) => ({
      type: 'SupportTicket',
      id: ref(ctx, 'ticketId') ?? undefined,
    }),
    render: {
      en: (v) => ({
        title: `Ticket ${v.ticketNumber} is now ${v.toStatus}`,
        body: `"${v.subject}" moved from ${v.fromStatus} to ${v.toStatus}.`,
      }),
      ar: (v) => ({
        title: `التذكرة ${v.ticketNumber} أصبحت ${v.toStatus}`,
        body: `تم نقل "${v.subject}" من ${v.fromStatus} إلى ${v.toStatus}.`,
      }),
    },
  },

  /**
   * The mirror gap. Before this key, a new ticket produced NO signal at all
   * unless it happened to be `urgent` — and even then only a counter
   * recomputed by SQL on each dashboard load, which nobody is required to open.
   */
  SUPPORT_TICKET_OPENED: {
    scope: NOTIFICATION_SCOPE.PLATFORM,
    category: NOTIFICATION_CATEGORY.SUPPORT,
    priority: NOTIFICATION_PRIORITY.HIGH,
    recipients: platformPermission(PERMISSION.PLATFORM_SUPPORT_TICKETS_READ),
    mandatory: true,
    variables: ['ticketNumber', 'subject', 'priority', 'clinicName'],
    // One ticket can only be opened once, so the ticket id is the key.
    dedupe: (ctx) => {
      const ticketId = ref(ctx, 'ticketId');
      return ticketId ? `ticket:opened:${ticketId}` : null;
    },
    link: (ctx) => {
      const ticketId = ref(ctx, 'ticketId');
      return ticketId
        ? `/support-desk/tickets/${ticketId}`
        : '/support-desk/tickets';
    },
    entity: (ctx) => ({
      type: 'SupportTicket',
      id: ref(ctx, 'ticketId') ?? undefined,
    }),
    render: {
      en: (v) => ({
        title: `New ${v.priority} ticket from ${v.clinicName}`,
        body: `${v.ticketNumber}: ${v.subject}`,
      }),
      ar: (v) => ({
        title: `تذكرة جديدة (${v.priority}) من ${v.clinicName}`,
        body: `${v.ticketNumber}: ${v.subject}`,
      }),
    },
  },

  /** A clinic replying is waiting on support, exactly as support replying is. */
  SUPPORT_TICKET_CUSTOMER_REPLIED: {
    scope: NOTIFICATION_SCOPE.PLATFORM,
    category: NOTIFICATION_CATEGORY.SUPPORT,
    priority: NOTIFICATION_PRIORITY.NORMAL,
    recipients: platformPermission(PERMISSION.PLATFORM_SUPPORT_TICKETS_READ),
    mandatory: false,
    variables: ['ticketNumber', 'clinicName', 'responderName', 'preview'],
    dedupe: (ctx) => {
      const eventId = ref(ctx, 'eventId');
      return eventId ? `ticket:reply:${eventId}` : null;
    },
    link: (ctx) => {
      const ticketId = ref(ctx, 'ticketId');
      return ticketId
        ? `/support-desk/tickets/${ticketId}`
        : '/support-desk/tickets';
    },
    entity: (ctx) => ({
      type: 'SupportTicket',
      id: ref(ctx, 'ticketId') ?? undefined,
    }),
    render: {
      en: (v) => ({
        title: `${v.clinicName} replied on ticket ${v.ticketNumber}`,
        body: `${v.responderName}: ${v.preview}`,
      }),
      ar: (v) => ({
        title: `ردّت ${v.clinicName} على التذكرة ${v.ticketNumber}`,
        body: `${v.responderName}: ${v.preview}`,
      }),
    },
  },

  /**
   * "Issue not resolved" — the clinic rejecting a resolution. It puts the
   * ticket back in the active queue, so the queue's owners need to know.
   */
  SUPPORT_TICKET_REOPENED: {
    scope: NOTIFICATION_SCOPE.PLATFORM,
    category: NOTIFICATION_CATEGORY.SUPPORT,
    priority: NOTIFICATION_PRIORITY.NORMAL,
    recipients: platformPermission(PERMISSION.PLATFORM_SUPPORT_TICKETS_READ),
    mandatory: false,
    variables: ['ticketNumber', 'subject', 'clinicName'],
    dedupe: (ctx) => {
      const eventId = ref(ctx, 'eventId');
      return eventId ? `ticket:reopened:${eventId}` : null;
    },
    link: (ctx) => {
      const ticketId = ref(ctx, 'ticketId');
      return ticketId
        ? `/support-desk/tickets/${ticketId}`
        : '/support-desk/tickets';
    },
    entity: (ctx) => ({
      type: 'SupportTicket',
      id: ref(ctx, 'ticketId') ?? undefined,
    }),
    render: {
      en: (v) => ({
        title: `${v.clinicName} reopened ticket ${v.ticketNumber}`,
        body: `"${v.subject}" was marked as not resolved.`,
      }),
      ar: (v) => ({
        title: `أعادت ${v.clinicName} فتح التذكرة ${v.ticketNumber}`,
        body: `تم وضع علامة "لم يتم الحل" على "${v.subject}".`,
      }),
    },
  },

  /**
   * Migrated from `admin_notifications`, which this replaces as the platform
   * feed. It was that table's ONLY producer, and its read state was global
   * across all administrators — one admin reading it cleared everyone's badge.
   * Here each recipient gets their own row and their own read state.
   */
  VERIFICATION_SUBMITTED: {
    scope: NOTIFICATION_SCOPE.PLATFORM,
    category: NOTIFICATION_CATEGORY.ACCOUNT,
    priority: NOTIFICATION_PRIORITY.NORMAL,
    // `tenants.manage` is held only by super_admin, via the ALL_PERMISSIONS
    // wildcard — which `role-permissions.seed.ts` expands into concrete
    // `role_permissions` rows, so the resolver's permission join finds it with
    // no wildcard special-casing.
    recipients: platformPermission(PERMISSION.TENANTS_MANAGE),
    mandatory: false,
    variables: ['clinicName'],
    // A clinic can resubmit after a rejection, so this is keyed on the
    // submission rather than the clinic — but only one submission can be
    // awaiting review at a time, so the clinic id is the right grain.
    dedupe: (ctx) =>
      ctx.tenantId ? `tenant:verif_submitted:${ctx.tenantId}` : null,
    link: (ctx) =>
      ctx.tenantId ? `/platform/tenants/${ctx.tenantId}` : '/platform/tenants',
    entity: (ctx) => ({ type: 'Tenant', id: ctx.tenantId ?? undefined }),
    render: {
      en: (v) => ({
        title: `${v.clinicName} submitted verification`,
        body: `${v.clinicName} has uploaded all required documents and is awaiting review.`,
      }),
      ar: (v) => ({
        title: `قدّمت ${v.clinicName} طلب التحقق`,
        body: `رفعت ${v.clinicName} جميع المستندات المطلوبة وهي بانتظار المراجعة.`,
      }),
    },
  },

  /**
   * A super admin comped the clinic (`FreeAccessOverrideService.grant`, with
   * `notifyClinic: true`). Sent once per override row — see
   * `free-access-notice-keys.ts` for why the dedupe is keyed on the override
   * id alone (one start notice per grant, ever).
   *
   * Emitted directly by `FreeAccessNoticeService.deliver()` (worker-only,
   * `subscription-billing/free-access-notice.service.ts`), NOT through
   * `internal-notification.listener.ts` like every other key here — the
   * deliberate exception documented in the free-access lifecycle plan §8, so
   * the sweep job can inspect `EmitResult.error` and retry the whole delivery
   * (in-app + email) as one unit instead of firing an event nothing awaits.
   */
  FREE_ACCESS_STARTED: {
    scope: NOTIFICATION_SCOPE.TENANT,
    category: NOTIFICATION_CATEGORY.BILLING,
    priority: NOTIFICATION_PRIORITY.NORMAL,
    // Whoever can act on billing — same holder as the expiry warning below.
    recipients: tenantPermission(PERMISSION.SUBSCRIPTION_MANAGE),
    // Access loss/gain is never something a user should be able to mute.
    mandatory: true,
    variables: ['clinicName', 'endsAt', 'durationDays'],
    dedupe: (ctx) => {
      const overrideId = ref(ctx, 'overrideId');
      return overrideId ? freeAccessStartNotificationDedupe(overrideId) : null;
    },
    link: () => '/app/billing',
    entity: (ctx) => ({
      type: 'FreeAccessOverride',
      id: ref(ctx, 'overrideId') ?? undefined,
    }),
    render: {
      en: (v) => ({
        title: 'Free access started',
        body: `${v.clinicName}'s access is now free. Duration: ${v.durationDays}. Ends: ${v.endsAt}.`,
      }),
      ar: (v) => ({
        title: 'بدأ الوصول المجاني',
        body: `أصبح وصول ${v.clinicName} مجانيًا الآن. المدة: ${v.durationDays}. تاريخ الانتهاء: ${v.endsAt}.`,
      }),
    },
  },

  /**
   * The rolling-48h expiry warning (`FreeAccessNoticeService.sweepExpiring`).
   * Dedupe is keyed on `(overrideId, endsAt)` — see `free-access-notice-keys.ts`
   * — so extending the override re-arms exactly one new warning instead of
   * either colliding with an already-delivered one or firing twice.
   */
  FREE_ACCESS_EXPIRING: {
    scope: NOTIFICATION_SCOPE.TENANT,
    category: NOTIFICATION_CATEGORY.BILLING,
    priority: NOTIFICATION_PRIORITY.HIGH,
    recipients: tenantPermission(PERMISSION.SUBSCRIPTION_MANAGE),
    mandatory: true,
    variables: ['endsAt', 'daysRemaining'],
    dedupe: (ctx) => {
      const overrideId = ref(ctx, 'overrideId');
      const endsAt = ref(ctx, 'endsAt');
      return overrideId && endsAt
        ? freeAccessExpiryNotificationDedupe(overrideId, new Date(endsAt))
        : null;
    },
    link: () => '/app/billing',
    entity: (ctx) => ({
      type: 'FreeAccessOverride',
      id: ref(ctx, 'overrideId') ?? undefined,
    }),
    render: {
      en: (v) => ({
        title: 'Free access is ending soon',
        body: `Your free access ends on ${v.endsAt} (${v.daysRemaining} day(s) remaining). Subscribe to keep uninterrupted access.`,
      }),
      ar: (v) => ({
        title: 'الوصول المجاني على وشك الانتهاء',
        body: `ينتهي وصولك المجاني في ${v.endsAt} (متبقٍ ${v.daysRemaining} يوم). اشترك للحفاظ على الوصول دون انقطاع.`,
      }),
    },
  },
} as const satisfies Record<string, NotificationSpec>;

/** Every catalogued key, typed. Derived from the catalog so it cannot drift. */
export type NotificationKey = keyof typeof NOTIFICATION_CATALOG;

export const NOTIFICATION_KEYS = Object.keys(
  NOTIFICATION_CATALOG,
) as NotificationKey[];

export function isNotificationKey(value: string): value is NotificationKey {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_CATALOG, value);
}

export function getSpec(key: NotificationKey): NotificationSpec {
  return NOTIFICATION_CATALOG[key];
}

/**
 * Whether a user is allowed to mute a whole category.
 *
 * Derived from the catalog rather than kept as a second hardcoded list, so it
 * can never fall out of step with the `mandatory` flags it describes. A
 * category in which EVERY key is mandatory is not mutable — offering the
 * toggle would promise the user something the emit path would then ignore.
 */
export function isCategoryMutable(category: NotificationCategory): boolean {
  const keys = NOTIFICATION_KEYS.filter(
    (k) => NOTIFICATION_CATALOG[k].category === category,
  );
  return keys.length > 0 && keys.some((k) => !NOTIFICATION_CATALOG[k].mandatory);
}

/** Categories a preferences UI may offer, in a stable order. */
export function mutableCategories(): NotificationCategory[] {
  const seen: NotificationCategory[] = [];
  for (const key of NOTIFICATION_KEYS) {
    const { category } = NOTIFICATION_CATALOG[key];
    if (!seen.includes(category) && isCategoryMutable(category)) {
      seen.push(category);
    }
  }
  return seen;
}

/**
 * Turns raw producer values into the display strings a renderer receives.
 *
 * MISSING-VARIABLE HANDLING, in one place: a declared variable the producer
 * omitted (or set to `null`/`undefined`/`NaN`) renders as `—`. It never
 * renders as `undefined`, an empty gap, or a raw `{{token}}`. Undeclared
 * values are dropped rather than passed through, so a renderer can only ever
 * read what its spec declares.
 */
export function normalizeVariables(
  spec: NotificationSpec,
  raw: Readonly<Record<string, unknown>> | null | undefined,
): RenderVars {
  const out: Record<string, string> = {};
  for (const name of spec.variables) {
    const value = raw?.[name];
    out[name] =
      value === null || value === undefined
        ? MISSING_VARIABLE_PLACEHOLDER
        : stringify(value);
  }
  return out;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim() || MISSING_VARIABLE_PLACEHOLDER;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? String(value)
      : MISSING_VARIABLE_PLACEHOLDER;
  }
  if (typeof value === 'boolean') return String(value);
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? MISSING_VARIABLE_PLACEHOLDER
      : value.toISOString();
  }
  try {
    return JSON.stringify(value) ?? MISSING_VARIABLE_PLACEHOLDER;
  } catch {
    return MISSING_VARIABLE_PLACEHOLDER;
  }
}

/**
 * Renders a stored row for one reader.
 *
 * Called at READ time, not write time — which is what lets a single row serve
 * an Arabic and an English reader, and lets a copy fix apply to notifications
 * that already exist.
 *
 * Two fallbacks, because an inbox that renders an empty row is worse than one
 * that renders an approximate row: an unknown locale falls back to English,
 * and a key no longer in the catalog (an old row after a key was renamed or
 * retired) renders a neutral placeholder instead of throwing and taking the
 * whole inbox response down with it.
 */
export function renderNotification(
  key: string,
  locale: NotificationLocale,
  variables: Readonly<Record<string, unknown>> | null | undefined,
): RenderedNotification {
  if (!isNotificationKey(key)) {
    return { title: key, body: '' };
  }
  const spec = NOTIFICATION_CATALOG[key];
  const vars = normalizeVariables(spec, variables);
  const render =
    spec.render[locale] ?? spec.render[DEFAULT_NOTIFICATION_LOCALE];
  return render(vars);
}

/** Exposed for the catalog spec, which asserts every key renders in both. */
export const CATALOG_LOCALES = NOTIFICATION_LOCALES;
