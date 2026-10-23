/**
 * T155 — record-based post-incident reconstruction (FR-080).
 *
 * Executes one ALLOWED and one REFUSED tool call in each of the three tool
 * catalogs (core, admin, public), driven through a REAL turn
 * (`AiExecutionService.sendMessage`, exactly as the REST orchestrator would
 * call it) so the turn-level ledgers (`ai_execution_metrics`, `ai_cost_logs`,
 * `ai_usage_logs`) are populated by production code, not this test. Every
 * assertion below re-reads the row from Postgres with a fresh `dataSource.query`
 * call — never the in-memory `result`/`toolCtx` object the test itself built —
 * because the goal is what an incident responder could recover from the
 * database ALONE, after the process that ran the turn is long gone.
 *
 * The 15 fields named by T155 (user, tenant, request/correlation id,
 * conversation, agent, channel, tool, sanitized arguments, resource,
 * authorization decision + reason, action, outcome, model + token usage,
 * cost, timestamp) are checked one by one for each case via `reconstruct()`,
 * which returns a per-field RECOVERED/MISSING verdict. A MISSING verdict is
 * not a test bug to fix — per the task's own instruction, "a missing field is
 * a candidate finding" — so this file asserts the CURRENT (possibly gapped)
 * behavior precisely, both ways, and prints a full manifest for T159's
 * evidence file.
 */
import { randomUUID } from 'node:crypto';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scriptedToolCall } from './fixtures/scripted-ai-provider';

import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiExecutionService } from '../../src/modules/ai/ai-execution.service';
import { TenantContextService } from '../../src/core/tenant-context/tenant-context.service';
import { PublicBookingContextService } from '../../src/modules/public-booking/public-booking-context.service';
import { ConversationSessionService } from '../../src/modules/ai-orchestrator/conversation-session.service';
import { WhatsappBotActorService } from '../../src/modules/whatsapp/whatsapp-bot-actor.service';

import { User } from '../../src/entities/Auth&RBAC/User';
import { Role } from '../../src/entities/Auth&RBAC/Role';
import { UserRole } from '../../src/entities/Auth&RBAC/UserRole';
import { Tenant } from '../../src/entities/SaaS-Core/Tenant';
import { StaffProfile } from '../../src/entities/Staff/StaffProfile';
import { StaffSchedule } from '../../src/entities/Staff/StaffSchedule';
import { Service, PricingType } from '../../src/entities/Services/Service';

import { ROLE, ROLE_PERMISSIONS, PERMISSION } from '../../src/rbac/rbac.constants';
import { AI_TOOL } from '../../src/modules/ai/tools/ai-tools.constants';
import { AI_ADMIN_TOOL } from '../../src/modules/ai/tools/ai-admin-tools.constants';
import { AI_PUBLIC_TOOL } from '../../src/modules/ai/tools/ai-public-booking-tools.constants';
import { currentPeriodMonth } from '../../src/modules/ai/ai.constants';
import type { AuthenticatedUser } from '../../src/modules/auth/interfaces/authenticated-user.interface';

describe('W10 — record-based reconstruction, one allowed + one refused call per catalog (T155)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let execution: AiExecutionService;
  let tenantContext: TenantContextService;
  let bookingContext: PublicBookingContextService;
  let sessions: ConversationSessionService;

  let ownerUserId: string;
  let ownerPrincipal: AuthenticatedUser;
  let doctorPrincipal: AuthenticatedUser;
  let guestAPrincipal: AuthenticatedUser;
  let guestBPrincipal: AuthenticatedUser;
  let serviceId: string;

  const convIds: string[] = [];
  /** Every synthetic marker planted on a turn, so we can prove none of them leak into a table they weren't stamped into on purpose (or DO leak, which is itself the finding). */
  const CORRELATION_MARKER_PREFIX = 'w10-recon-cid-';

  // Field-by-field manifest collected across every case, printed once at the end for T159.
  type FieldVerdict = 'RECOVERED' | 'MISSING' | 'PARTIAL';
  interface CaseManifest {
    catalog: 'core' | 'admin' | 'public';
    outcome: 'ALLOWED' | 'REFUSED';
    tool: string;
    fields: Record<string, { verdict: FieldVerdict; note: string }>;
  }
  const manifest: CaseManifest[] = [];

  /**
   * Full deletion chain for one tenant this fixture (or a previous failed run
   * of it) created — everything `teardownAiAuditSeed` does NOT know about
   * (payment_links, staff_schedules, services, the AI-bot's role/user) plus
   * the appointment-adjacent child tables `public-booking-flow.e2e-spec.ts`'s
   * own afterAll cleans for the same reason. Idempotent / catch-and-continue,
   * like `teardownAiAuditSeed` itself. Does NOT delete the `tenants` row
   * itself — the caller decides whether to (via `teardownAiAuditSeed` for a
   * live seed tenant, or directly for an orphaned one).
   */
  async function cleanupTenantSideEffects(tenantId: string): Promise<void> {
    const ds = harness.dataSource;
    const q = (sql: string, params: unknown[]) => ds.query(sql, params).catch(() => undefined);
    await q(`DELETE FROM payment_links WHERE "tenantId" = $1`, [tenantId]);
    await q(`DELETE FROM appointment_services WHERE "tenantId" = $1`, [tenantId]);
    await q(`DELETE FROM appointment_status_logs WHERE "tenantId" = $1`, [tenantId]);
    await q(`DELETE FROM appointment_history WHERE "tenantId" = $1`, [tenantId]);
    await q(`DELETE FROM scheduled_notifications WHERE "tenantId" = $1`, [tenantId]);
    await q(`DELETE FROM ai_tool_calls WHERE tenant_id = $1`, [tenantId]);
    await q(
      `DELETE FROM ai_messages WHERE ai_conversation_id::text IN (SELECT id::text FROM ai_conversations WHERE "tenantId" = $1)`,
      [tenantId],
    );
    await q(`DELETE FROM ai_conversations WHERE "tenantId" = $1`, [tenantId]);
    await q(`DELETE FROM appointments WHERE "tenantId" = $1`, [tenantId]);
    await q(`DELETE FROM staff_schedules WHERE "tenantId" = $1`, [tenantId]);
    await q(`DELETE FROM staff_profiles WHERE "tenantId" = $1`, [tenantId]);
    await q(`DELETE FROM service_prices WHERE "tenantId" = $1`, [tenantId]);
    await q(`DELETE FROM services WHERE "tenantId" = $1`, [tenantId]);
    await q(`DELETE FROM audit_logs WHERE "tenantId" = $1`, [tenantId]); // role provisioning writes an audit row FK'd to the tenant
    await q(`DELETE FROM role_permissions WHERE "roleId" IN (SELECT id FROM roles WHERE "tenantId" = $1)`, [tenantId]);
    await q(`DELETE FROM user_roles WHERE "userId" IN (SELECT id FROM users WHERE "tenantId" = $1)`, [tenantId]);
    await q(`DELETE FROM roles WHERE "tenantId" = $1`, [tenantId]);
    await q(`DELETE FROM users WHERE "tenantId" = $1`, [tenantId]);
    await q(`DELETE FROM tenant_settings WHERE tenant_id = $1`, [tenantId]);
  }

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    execution = harness.app.get(AiExecutionService);
    tenantContext = harness.app.get(TenantContextService);
    bookingContext = harness.app.get(PublicBookingContextService);
    sessions = harness.app.get(ConversationSessionService);

    const ds = harness.dataSource;

    // A second, higher-privilege principal in tenant A (the seed's own staff user
    // is ROLE.DOCTOR, which — confirmed by reading rbac.constants.ts — holds only
    // DASHBOARD_ACCESS + APPOINTMENTS_READ_OWN, i.e. neither APPOINTMENTS_CREATE
    // nor ANALYTICS_DASHBOARD_READ. That makes the EXISTING seed staff user a
    // ready-made REFUSED principal for both the core and admin catalogs, and this
    // new OWNER principal the ALLOWED one for the same two catalogs.
    const users = ds.getRepository(User);
    const roles = ds.getRepository(Role);
    const userRoles = ds.getRepository(UserRole);
    const ownerUser = await users.save(
      users.create({
        tenant: { id: seed.tenantA.id } as Tenant,
        email: `w10-owner-${randomUUID().slice(0, 8)}@example.test`,
        full_name: 'W10 Recon Owner',
        is_active: true,
      }),
    );
    ownerUserId = ownerUser.id;
    const ownerRole = await roles
      .createQueryBuilder('r')
      .where('r.slug = :slug', { slug: ROLE.OWNER })
      .andWhere('r."tenantId" IS NULL')
      .getOne();
    if (!ownerRole) throw new Error('seeded system role "owner" not found — run the RBAC seed first.');
    await userRoles.save(userRoles.create({ user: { id: ownerUser.id } as User, role: { id: ownerRole.id } as Role }));

    ownerPrincipal = {
      id: ownerUser.id,
      tenantId: seed.tenantA.id,
      email: ownerUser.email,
      roles: [ROLE.OWNER],
      permissions: ROLE_PERMISSIONS[ROLE.OWNER] as string[],
      guest: false,
    };
    doctorPrincipal = {
      id: seed.tenantA.staffUserId,
      tenantId: seed.tenantA.id,
      email: null,
      roles: [ROLE.DOCTOR],
      permissions: ROLE_PERMISSIONS[ROLE.DOCTOR] as string[],
      guest: false,
    };
    guestAPrincipal = seed.guestA;
    guestBPrincipal = seed.guestB;

    // Working hours (08:00-20:00 every day, Asia/Riyadh — the branch's default
    // timezone, `Branch.ts:38`) for the seed staff member at the seed branch —
    // `AppointmentsService.create` calls `assertBookable`, which requires a
    // `StaffSchedule` row covering the requested slot, and the base seed fixture
    // does not create one. Mirrors `test/public-booking-flow.e2e-spec.ts`'s
    // `makeClinic()`.
    for (let day = 0; day < 7; day += 1) {
      await ds.getRepository(StaffSchedule).save(
        ds.getRepository(StaffSchedule).create({
          tenant: { id: seed.tenantA.id } as Tenant,
          staff: { id: seed.tenantA.staffProfileId } as StaffProfile,
          branch: { id: seed.tenantA.branchId } as never,
          day_of_week: day,
          start_time: '08:00:00',
          end_time: '20:00:00',
          is_active: true,
        }),
      );
    }

    // One bookable service — needed only for the public-catalog booking, whose
    // `requireContext(need:'book')` requires `selectedServiceIds` to be
    // non-empty (public-booking-context.service.ts:169-172). No `ServicePrice`
    // row is created, so it is not "configured anywhere" and therefore not
    // branch-restricted (appointment.service.ts:1199-1201) — no extra fixture
    // needed for AppointmentsService.create to accept it.
    const service = await ds.getRepository(Service).save(
      ds.getRepository(Service).create({
        public_slug: `svc-${Math.random().toString(36).slice(2, 10)}`,
        tenant: { id: seed.tenantA.id } as Tenant,
        name: 'W10 Recon Consultation',
        duration_minutes: 30,
        pricing_type: PricingType.FIXED,
        base_price: 100,
        is_active: true,
      }),
    );
    serviceId = service.id;

    // Gotcha #3 (HARNESS_GUIDE.md): public booking tools need this opt-in row.
    // payment_required:false keeps the booking off the payment-link gateway —
    // same reason test/public-booking-flow.e2e-spec.ts's makeClinic() sets it
    // ("keep the happy path off the payment gateway"): a payment_links row
    // would otherwise FK-block appointment cleanup in afterAll below.
    await ds.query(
      `INSERT INTO tenant_settings (tenant_id, public_booking_enabled, payment_required) VALUES ($1, true, false)
       ON CONFLICT (tenant_id) DO UPDATE SET public_booking_enabled = true, payment_required = false`,
      [seed.tenantA.id],
    );

    // Defensive fixture hygiene, discovered the hard way while building this
    // spec: `WhatsappBotActorService.ensureBotUser` (whatsapp-bot-actor.service.ts:82-100)
    // looks up the bot user SCOPED TO THIS TENANT ("tenant_id = X AND email =
    // 'ai-bot@bot.internal'"), finds none, and INSERTs with that same fixed
    // literal email for every tenant — but `users.email` carries a GLOBAL
    // unique index (`uq_user_email_global`, migration
    // 1730035000000-GlobalUserEmailUniqueness.ts), not a per-tenant one,
    // despite this file's own docstring claiming "users.email is unique PER
    // TENANT" (whatsapp-bot-actor.service.ts:13). An earlier iteration of
    // THIS spec left an orphaned bot user behind (its owning tenant's
    // teardown failed on an unrelated FK chain before this file added the
    // cleanup below), which then permanently blocked every later run from
    // ever creating tenant A's own bot actor — confirmed live, not
    // hypothetical. If such a stale row is found (owned by neither of this
    // run's own tenants), remove just that row before proceeding; flagged
    // separately as a candidate finding (the missing conflict-handling), out
    // of W10's scope to fix.
    const staleBotRows: { id: string; tenantId: string }[] = await ds.query(
      `SELECT id, "tenantId" FROM users WHERE email = 'ai-bot@bot.internal' AND "tenantId" NOT IN ($1, $2)`,
      [seed.tenantA.id, seed.tenantB.id],
    );
    for (const row of staleBotRows) {
      await cleanupTenantSideEffects(row.tenantId);
      await ds.query(`DELETE FROM tenants WHERE id = $1`, [row.tenantId]).catch(() => undefined);
    }

    // Pre-warm tenant A's AI-bot actor here, with retries, rather than letting
    // the public-catalog booking test hit it cold (tolerates a genuine
    // transient race against a concurrently-running session claiming the same
    // literal email for a different tenant at almost the same instant).
    const botActor = harness.app.get(WhatsappBotActorService);
    let botAcquired = false;
    let lastBotError: unknown;
    for (let attempt = 0; attempt < 10 && !botAcquired; attempt += 1) {
      try {
        await botActor.ensureBotActor(seed.tenantA.id);
        botAcquired = true;
      } catch (err) {
        lastBotError = err;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    if (!botAcquired) {
      throw new Error(
        `W10 fixture: could not acquire tenant A's AI-bot actor after 10 attempts (global email uniqueness collision with a concurrent session) — last error: ${(lastBotError as Error)?.message}`,
      );
    }
  }, 120_000);

  afterAll(async () => {
    const ds = harness.dataSource;
    const q = (sql: string, params: unknown[]) => ds.query(sql, params).catch(() => undefined);
    // Scoped by conversation id, never by tenant_id, for anything under the
    // SHARED discovery tenant (ai-audit-seed.ts's own teardown never deletes
    // that tenant's rows wholesale, for the same reason).
    await q(`DELETE FROM ai_tool_calls WHERE ai_conversation_id = ANY($1)`, [convIds]);
    await q(`DELETE FROM ai_cost_entries WHERE ai_conversation_id::text = ANY($1)`, [convIds]);
    await q(`DELETE FROM ai_execution_metrics WHERE ai_conversation_id::text = ANY($1)`, [convIds]);
    await q(`DELETE FROM ai_messages WHERE ai_conversation_id = ANY($1)`, [convIds]);
    await q(`DELETE FROM ai_conversations WHERE id = ANY($1)`, [convIds]);
    // Everything teardownAiAuditSeed does not know about (payment_links, the
    // AI-bot's role/user, staff_schedules, services) — left undone here it
    // would block that call's own `DELETE FROM tenants` via the SAME FK chain
    // this fixture hit while under development (payment_links -> appointments
    // -> staff_profiles -> users -> tenants; roles -> tenants).
    await cleanupTenantSideEffects(seed.tenantA.id);
    await q(`DELETE FROM user_roles WHERE "userId" = $1`, [ownerUserId]);
    await q(`DELETE FROM users WHERE id = $1`, [ownerUserId]);

    await teardownAiAuditSeed(ds, seed);
    await harness.close();
  }, 60_000);

  /** Drives one real turn with a single scripted tool call, under the given principal. Returns the correlation marker planted before the turn ran. */
  async function driveTurn(
    tenantIdForTurn: string,
    conversationId: string,
    principal: AuthenticatedUser,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const marker = `${CORRELATION_MARKER_PREFIX}${randomUUID()}`;
    harness.provider.reset();
    harness.provider.script([
      { toolCalls: [scriptedToolCall(toolName, args)] },
      { content: `Scripted final answer for ${toolName}.` },
    ]);
    await tenantContext.run(async () => {
      tenantContext.setPrincipal(principal);
      tenantContext.setCorrelationId(marker);
      await execution.sendMessage(tenantIdForTurn, conversationId, { content: `please ${toolName}` }, 'REST');
    });
    return marker;
  }

  /** Every row this test is allowed to reconstruct FROM — always a fresh SELECT, never a variable captured during `driveTurn`. */
  async function fetchRecords(tenantIdForTurn: string, conversationId: string, toolName: string) {
    const ds = harness.dataSource;
    const [toolCallRows, metricRows, usageLogRows, costLogRows] = await Promise.all([
      ds.query(
        `SELECT * FROM ai_tool_calls WHERE ai_conversation_id = $1 AND tool_name = $2 ORDER BY created_at DESC LIMIT 1`,
        [conversationId, toolName],
      ),
      ds.query(
        `SELECT * FROM ai_execution_metrics WHERE ai_conversation_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [conversationId],
      ),
      ds.query(`SELECT * FROM ai_usage_logs WHERE "tenantId" = $1 AND period_month = $2`, [
        tenantIdForTurn,
        currentPeriodMonth(),
      ]),
      ds.query(`SELECT * FROM ai_cost_logs WHERE "tenantId" = $1 AND period_month = $2`, [
        tenantIdForTurn,
        currentPeriodMonth(),
      ]),
    ]);
    return {
      toolCallRow: toolCallRows[0] as Record<string, unknown> | undefined,
      metricRow: metricRows[0] as Record<string, unknown> | undefined,
      usageLogRow: usageLogRows[0] as Record<string, unknown> | undefined,
      costLogRow: costLogRows[0] as Record<string, unknown> | undefined,
    };
  }

  /** True if `needle` appears as a value (stringified) anywhere in any of the 4 fetched rows. */
  function appearsAnywhere(
    needle: string,
    records: Awaited<ReturnType<typeof fetchRecords>>,
  ): boolean {
    const blob = JSON.stringify([records.toolCallRow, records.metricRow, records.usageLogRow, records.costLogRow]);
    return blob.includes(needle);
  }

  function record(m: CaseManifest) {
    manifest.push(m);
  }

  // ───────────────────────────── CORE catalog ─────────────────────────────

  describe('core catalog — book_appointment', () => {
    it('ALLOWED: an owner books successfully — reconstruct the 15 fields from ai_tool_calls + ai_execution_metrics + ai_usage_logs + ai_cost_logs alone', async () => {
      const conv = await conversations.start(seed.tenantA.id, { agentId: seed.tenantA.agentId });
      convIds.push(conv.id);
      const args = {
        branchId: seed.tenantA.branchId,
        customerId: seed.tenantA.customerIds[0],
        staffId: seed.tenantA.staffProfileId,
        startAt: '2027-04-01T10:00:00Z',
        serviceIds: [serviceId], // AppointmentsService.create needs endAt or >=1 service to derive the duration
      };
      const marker = await driveTurn(seed.tenantA.id, conv.id, ownerPrincipal, AI_TOOL.BOOK_APPOINTMENT, args);
      const rec = await fetchRecords(seed.tenantA.id, conv.id, AI_TOOL.BOOK_APPOINTMENT);

      // tool / action / conversation / tenant / resource / outcome / timestamp — all present on the ai_tool_calls row.
      expect(rec.toolCallRow).toBeDefined();
      expect(rec.toolCallRow!.tool_name).toBe(AI_TOOL.BOOK_APPOINTMENT);
      expect(rec.toolCallRow!.ai_conversation_id).toBe(conv.id);
      expect(rec.toolCallRow!.tenant_id).toBe(seed.tenantA.id);
      expect(rec.toolCallRow!.status).toBe('SUCCEEDED');
      expect(rec.toolCallRow!.appointment_id).toBeTruthy();
      expect(rec.toolCallRow!.created_at).toBeTruthy();
      // sanitized arguments: present, but VERBATIM (no redaction at all) — the
      // customerId/staffId/startAt an attacker or a responder alike would see.
      expect(rec.toolCallRow!.arguments).toMatchObject(args);

      // model + token usage + cost + channel + agent linkage — only on the
      // TURN-level ai_execution_metrics row (there is no such column on
      // ai_tool_calls), joined here purely by ai_conversation_id (this test has
      // exactly one tool call per turn, so the join is 1:1 — with N tool calls
      // in one turn it would NOT be, since ai_execution_metrics has no
      // per-tool-call granularity).
      expect(rec.metricRow).toBeDefined();
      expect(rec.metricRow!.channel).toBe('REST');
      expect(rec.metricRow!.model).toBe('scripted-stub-model');
      expect(Number(rec.metricRow!.total_tokens)).toBeGreaterThan(0);
      expect(rec.metricRow!.tool_calls_count).toBe(1);
      expect(rec.metricRow!.tool_success_count).toBe(1);

      // agent: NOT on ai_tool_calls or ai_execution_metrics at all (checked by
      // absence of the column key itself — SELECT * proves the schema has no
      // such column); only recoverable, and only at MONTHLY-AGGREGATE
      // granularity (not per-call), from ai_usage_logs.
      expect(rec.toolCallRow && 'agent_id' in rec.toolCallRow).toBe(false);
      expect(rec.metricRow && 'agent_id' in rec.metricRow).toBe(false);
      expect(rec.usageLogRow).toBeDefined();
      expect(rec.usageLogRow!.agentId).toBe(seed.tenantA.agentId);

      // [PROMOTED, RTP row 13, AI-017/T073] user (the acting principal): now a
      // dedicated `actor_user_id` column on `ai_tool_calls` (and, collaterally
      // via the SAME landed fix, on `ai_execution_metrics` — M2/T072-T073),
      // and the owner's id is directly recoverable as a column value.
      expect(rec.toolCallRow && 'actor_user_id' in rec.toolCallRow).toBe(true);
      expect(rec.toolCallRow!.actor_user_id).toBe(ownerPrincipal.id);
      expect(appearsAnywhere(ownerPrincipal.id, rec)).toBe(true);

      // [Collateral, same landed fix as row 12/AI-016/T072] request/correlation
      // id: the marker set on TenantContextService before the turn ran is now
      // stamped on `ai_tool_calls.correlation_id` (claim inserts) — this file
      // exercises the SAME `run()`/metrics code T072 changed, so the assertion
      // that nothing recovers it is no longer true (RTP row 12 itself is owned
      // by ai-w10-correlation-id.spec.ts/T089; this is the collateral half here).
      expect(rec.toolCallRow!.correlation_id).toBe(marker);
      expect(appearsAnywhere(marker, rec)).toBe(true);

      // authorization decision + reason: for an ALLOWED call there is no
      // explicit "why allowed" text anywhere — status=SUCCEEDED is the closest
      // thing to a decision record, and it carries no reason string.
      expect(rec.toolCallRow!.error).toBeNull();

      record({
        catalog: 'core',
        outcome: 'ALLOWED',
        tool: AI_TOOL.BOOK_APPOINTMENT,
        fields: {
          user: { verdict: 'RECOVERED', note: '[PROMOTED, row 13] ai_tool_calls.actor_user_id (and ai_execution_metrics.actor_user_id, collaterally)' },
          tenant: { verdict: 'RECOVERED', note: 'ai_tool_calls.tenant_id' },
          'request/correlation id': { verdict: 'RECOVERED', note: '[Collateral, same fix as row 12] ai_tool_calls.correlation_id' },
          conversation: { verdict: 'RECOVERED', note: 'ai_tool_calls.ai_conversation_id' },
          agent: { verdict: 'PARTIAL', note: 'only at monthly-aggregate granularity via ai_usage_logs.agentId, not per-call' },
          channel: { verdict: 'PARTIAL', note: 'ai_execution_metrics.channel is per-TURN, joined to this call only because the turn had exactly 1 tool call' },
          tool: { verdict: 'RECOVERED', note: 'ai_tool_calls.tool_name' },
          'sanitized arguments': { verdict: 'RECOVERED', note: 'ai_tool_calls.arguments — but stored verbatim/unredacted, not actually sanitized' },
          resource: { verdict: 'RECOVERED', note: 'ai_tool_calls.appointment_id' },
          'authorization decision + reason': { verdict: 'PARTIAL', note: 'status=SUCCEEDED implies "allowed"; no explicit reason text for an allow' },
          action: { verdict: 'RECOVERED', note: 'same as tool (ai_tool_calls.tool_name)' },
          outcome: { verdict: 'RECOVERED', note: 'ai_tool_calls.status' },
          'model + token usage': { verdict: 'PARTIAL', note: 'per-TURN only, via ai_execution_metrics, not per-call' },
          cost: { verdict: 'PARTIAL', note: 'per-TURN (ai_execution_metrics.cost_usd) and monthly-aggregate (ai_cost_logs), not per-call' },
          timestamp: { verdict: 'RECOVERED', note: 'ai_tool_calls.created_at / completed_at' },
        },
      });
    }, 30_000);

    it('REFUSED: a doctor (no appointments.create) is denied — [PROMOTED, RTP row 11] now writes exactly one ai_tool_calls ATTEMPT row (DENIED), recovering user/tenant/tool/reason/correlation directly', async () => {
      const conv = await conversations.start(seed.tenantA.id, { agentId: seed.tenantA.agentId });
      convIds.push(conv.id);
      const args = {
        branchId: seed.tenantA.branchId,
        customerId: seed.tenantA.customerIds[0],
        staffId: seed.tenantA.staffProfileId,
        startAt: '2027-04-01T11:00:00Z',
      };
      const marker = await driveTurn(seed.tenantA.id, conv.id, doctorPrincipal, AI_TOOL.BOOK_APPOINTMENT, args);
      const rec = await fetchRecords(seed.tenantA.id, conv.id, AI_TOOL.BOOK_APPOINTMENT);

      // [PROMOTED, RTP row 11, AI-008/T067] The permission check in
      // bookAppointment() still returns BEFORE this.run() is ever called
      // (ai-tool-dispatch.service.ts:459-464) — but it now ALSO calls
      // recordAttempt() on the way out, writing a terminal ATTEMPT row
      // (never a claim key) before returning.
      expect(rec.toolCallRow).toBeDefined();
      expect(rec.toolCallRow!.status).toBe('DENIED');
      expect(rec.toolCallRow!.idempotency_key).toMatch(
        new RegExp(`^attempt:${AI_TOOL.BOOK_APPOINTMENT}:[0-9a-f-]{36}$`),
      );
      expect(rec.toolCallRow!.error).toMatch(/Forbidden.*appointments\.create/);
      expect(rec.toolCallRow!.tool_name).toBe(AI_TOOL.BOOK_APPOINTMENT);
      expect(rec.toolCallRow!.tenant_id).toBe(seed.tenantA.id);
      expect(rec.toolCallRow!.appointment_id).toBeNull(); // no booking was ever created

      // The turn itself still completed and is ALSO recorded, as before —
      // parity now holds at both the per-call ledger AND the turn aggregate.
      expect(rec.metricRow).toBeDefined();
      expect(rec.metricRow!.tool_calls_count).toBe(1);
      expect(rec.metricRow!.tool_failure_count).toBe(1);
      expect(rec.metricRow!.success).toBe(true); // the TURN succeeded; only the tool call inside it was refused

      expect(appearsAnywhere(doctorPrincipal.id, rec)).toBe(true);
      expect(appearsAnywhere(marker, rec)).toBe(true);
      expect(appearsAnywhere(seed.tenantA.customerIds[0], rec)).toBe(true); // the refused args now DO reach durable storage, verbatim

      record({
        catalog: 'core',
        outcome: 'REFUSED',
        tool: AI_TOOL.BOOK_APPOINTMENT,
        fields: {
          user: { verdict: 'RECOVERED', note: '[PROMOTED, row 13] ai_tool_calls.actor_user_id on the ATTEMPT row' },
          tenant: { verdict: 'RECOVERED', note: 'ai_tool_calls.tenant_id on the ATTEMPT row, not just via the turn' },
          'request/correlation id': { verdict: 'RECOVERED', note: '[Collateral, same fix as row 12] ai_tool_calls.correlation_id on the ATTEMPT row' },
          conversation: { verdict: 'RECOVERED', note: 'ai_tool_calls.ai_conversation_id on the ATTEMPT row' },
          agent: { verdict: 'MISSING', note: 'still no agent_id column on ai_tool_calls at all' },
          channel: { verdict: 'PARTIAL', note: 'per-turn only — still no channel column on ai_tool_calls' },
          tool: { verdict: 'RECOVERED', note: '[PROMOTED, row 11] ai_tool_calls.tool_name names exactly which tool was refused' },
          'sanitized arguments': { verdict: 'RECOVERED', note: '[PROMOTED, row 11] ai_tool_calls.arguments — the refused args now persist, verbatim/unredacted' },
          resource: { verdict: 'MISSING', note: 'n/a for a refusal — no appointment was ever created to name' },
          'authorization decision + reason': { verdict: 'RECOVERED', note: '[PROMOTED, row 11] status=DENIED + ai_tool_calls.error carries the exact Forbidden reason text' },
          action: { verdict: 'RECOVERED', note: 'same as tool (ai_tool_calls.tool_name)' },
          outcome: { verdict: 'RECOVERED', note: '[PROMOTED, row 11] ai_tool_calls.status=DENIED is call-specific, not just an aggregate count' },
          'model + token usage': { verdict: 'PARTIAL', note: 'per-turn only' },
          cost: { verdict: 'PARTIAL', note: 'per-turn/monthly only' },
          timestamp: { verdict: 'RECOVERED', note: '[PROMOTED, row 11] ai_tool_calls.created_at is now specific to the refused call' },
        },
      });
    }, 30_000);
  });

  // ──────────────────────────── ADMIN catalog ─────────────────────────────

  describe('admin catalog — get_dashboard_kpis', () => {
    it('ALLOWED: an owner reads dashboard KPIs — full reconstruction attempt', async () => {
      const conv = await conversations.start(seed.tenantA.id, { agentId: seed.tenantA.agentId });
      convIds.push(conv.id);
      const marker = await driveTurn(seed.tenantA.id, conv.id, ownerPrincipal, AI_ADMIN_TOOL.GET_DASHBOARD_KPIS, {});
      const rec = await fetchRecords(seed.tenantA.id, conv.id, AI_ADMIN_TOOL.GET_DASHBOARD_KPIS);

      expect(rec.toolCallRow).toBeDefined();
      expect(rec.toolCallRow!.status).toBe('SUCCEEDED');
      expect(rec.toolCallRow!.tenant_id).toBe(seed.tenantA.id);
      // Read-only admin tools have no dedicated "resource" column — the target
      // (this tenant's own dashboard) is implicit in tenant_id, not a separate id.
      expect(rec.toolCallRow!.appointment_id).toBeNull();
      expect(rec.toolCallRow!.actor_user_id).toBe(ownerPrincipal.id);
      expect(appearsAnywhere(ownerPrincipal.id, rec)).toBe(true);
      expect(rec.toolCallRow!.correlation_id).toBe(marker);
      expect(appearsAnywhere(marker, rec)).toBe(true);

      record({
        catalog: 'admin',
        outcome: 'ALLOWED',
        tool: AI_ADMIN_TOOL.GET_DASHBOARD_KPIS,
        fields: {
          user: { verdict: 'RECOVERED', note: '[PROMOTED, row 13] same as core: ai_tool_calls.actor_user_id' },
          tenant: { verdict: 'RECOVERED', note: 'ai_tool_calls.tenant_id' },
          'request/correlation id': { verdict: 'RECOVERED', note: '[Collateral, same fix as row 12] ai_tool_calls.correlation_id' },
          conversation: { verdict: 'RECOVERED', note: 'ai_tool_calls.ai_conversation_id' },
          agent: { verdict: 'PARTIAL', note: 'monthly-aggregate only, via ai_usage_logs' },
          channel: { verdict: 'PARTIAL', note: 'per-turn only, via ai_execution_metrics' },
          tool: { verdict: 'RECOVERED', note: 'ai_tool_calls.tool_name' },
          'sanitized arguments': { verdict: 'RECOVERED', note: 'empty object — nothing to sanitize for this tool' },
          resource: { verdict: 'MISSING', note: 'read-only aggregate tool has no dedicated resource id column; implicit in tenant_id only' },
          'authorization decision + reason': { verdict: 'PARTIAL', note: 'status=SUCCEEDED only' },
          action: { verdict: 'RECOVERED', note: 'same as tool' },
          outcome: { verdict: 'RECOVERED', note: 'ai_tool_calls.status' },
          'model + token usage': { verdict: 'PARTIAL', note: 'per-turn only' },
          cost: { verdict: 'PARTIAL', note: 'per-turn/monthly only' },
          timestamp: { verdict: 'RECOVERED', note: 'ai_tool_calls.created_at' },
        },
      });
    }, 30_000);

    it('REFUSED: a doctor (no analytics.dashboard.read) is denied — [PROMOTED, RTP row 11] the previously-statically-flagged denial-before-ledger gap (w3-tools-admin.md) is closed: one ATTEMPT row, DENIED, naming the exact permission slug', async () => {
      const conv = await conversations.start(seed.tenantA.id, { agentId: seed.tenantA.agentId });
      convIds.push(conv.id);
      const marker = await driveTurn(seed.tenantA.id, conv.id, doctorPrincipal, AI_ADMIN_TOOL.GET_DASHBOARD_KPIS, {});
      const rec = await fetchRecords(seed.tenantA.id, conv.id, AI_ADMIN_TOOL.GET_DASHBOARD_KPIS);

      expect(rec.toolCallRow).toBeDefined();
      expect(rec.toolCallRow!.status).toBe('DENIED');
      expect(rec.toolCallRow!.idempotency_key).toMatch(
        new RegExp(`^attempt:${AI_ADMIN_TOOL.GET_DASHBOARD_KPIS}:[0-9a-f-]{36}$`),
      );
      expect(rec.toolCallRow!.tool_name).toBe(AI_ADMIN_TOOL.GET_DASHBOARD_KPIS);
      expect(rec.metricRow!.tool_failure_count).toBe(1);
      expect(appearsAnywhere(doctorPrincipal.id, rec)).toBe(true);
      expect(appearsAnywhere(marker, rec)).toBe(true);
      expect(appearsAnywhere(PERMISSION.ANALYTICS_DASHBOARD_READ, rec)).toBe(true); // the permission slug that caused the refusal is now persisted, in ai_tool_calls.error

      record({
        catalog: 'admin',
        outcome: 'REFUSED',
        tool: AI_ADMIN_TOOL.GET_DASHBOARD_KPIS,
        fields: {
          user: { verdict: 'RECOVERED', note: '[PROMOTED, row 13] ai_tool_calls.actor_user_id on the ATTEMPT row' },
          tenant: { verdict: 'RECOVERED', note: 'ai_tool_calls.tenant_id on the ATTEMPT row' },
          'request/correlation id': { verdict: 'RECOVERED', note: '[Collateral, same fix as row 12] ai_tool_calls.correlation_id' },
          conversation: { verdict: 'RECOVERED', note: 'ai_tool_calls.ai_conversation_id on the ATTEMPT row' },
          agent: { verdict: 'MISSING', note: 'still no agent_id column on ai_tool_calls' },
          channel: { verdict: 'PARTIAL', note: 'per-turn only' },
          tool: { verdict: 'RECOVERED', note: '[PROMOTED, row 11] ai_tool_calls.tool_name names exactly which admin tool was refused' },
          'sanitized arguments': { verdict: 'RECOVERED', note: 'empty object — nothing to sanitize for this tool, but the row itself now exists' },
          resource: { verdict: 'MISSING', note: 'read-only aggregate tool has no dedicated resource id, refused or not' },
          'authorization decision + reason': { verdict: 'RECOVERED', note: '[PROMOTED, row 11] status=DENIED + ai_tool_calls.error names the exact required-permission slug' },
          action: { verdict: 'RECOVERED', note: 'same as tool' },
          outcome: { verdict: 'RECOVERED', note: '[PROMOTED, row 11] ai_tool_calls.status=DENIED is call-specific' },
          'model + token usage': { verdict: 'PARTIAL', note: 'per-turn only' },
          cost: { verdict: 'PARTIAL', note: 'per-turn/monthly only' },
          timestamp: { verdict: 'RECOVERED', note: '[PROMOTED, row 11] ai_tool_calls.created_at is call-specific now' },
        },
      });
    }, 30_000);
  });

  // ──────────────────────────── PUBLIC catalog ─────────────────────────────

  describe('public catalog — book_public_appointment', () => {
    it('ALLOWED: a guest with a fully-populated booking session books successfully — reconstruct, including the ai_tool_calls tenant-stamping quirk (conversation tenant, not the clinic tenant)', async () => {
      const conv = await conversations.start(seed.discoveryTenantId, {});
      convIds.push(conv.id);
      await sessions.patch(seed.discoveryTenantId, conv.id, { guestSubject: guestAPrincipal.id });
      await bookingContext.patchSelection(seed.discoveryTenantId, conv.id, {
        selectedClinicId: seed.tenantA.id,
        selectedBranchId: seed.tenantA.branchId,
        selectedDoctorId: seed.tenantA.staffProfileId,
        selectedServiceIds: [serviceId],
        selectedStartAt: '2027-04-02T10:00:00Z',
      });

      const args = { fullName: 'W10 Recon Patient', phone: '+15555550100', hasInsurance: false };
      const marker = await driveTurn(
        seed.discoveryTenantId,
        conv.id,
        guestAPrincipal,
        AI_PUBLIC_TOOL.BOOK_PUBLIC_APPOINTMENT,
        args,
      );
      const rec = await fetchRecords(seed.discoveryTenantId, conv.id, AI_PUBLIC_TOOL.BOOK_PUBLIC_APPOINTMENT);

      expect(rec.toolCallRow).toBeDefined();
      expect(rec.toolCallRow!.status).toBe('SUCCEEDED');
      expect(rec.toolCallRow!.appointment_id).toBeTruthy();
      // The tenant-stamping quirk: ai_tool_calls.tenant_id is the CONVERSATION
      // tenant (the shared guest discovery tenant) — never the clinic tenant that
      // actually owns the resulting appointment. Confirmed live here, not assumed.
      expect(rec.toolCallRow!.tenant_id).toBe(seed.discoveryTenantId);
      expect(rec.toolCallRow!.tenant_id).not.toBe(seed.tenantA.id);
      // [PROMOTED, RTP row 14, AI-024/T074] The real clinic tenant is now
      // ALSO directly recoverable via a dedicated `resource_tenant_id` column
      // — no JSONB parsing required (the free-form `result.tenantId` blob
      // this tool happens to embed, ai-tool-dispatch.service.ts:926, still
      // works too and is checked below for continuity, but is no longer the
      // ONLY way to recover it).
      expect(rec.toolCallRow!.resource_tenant_id).toBe(seed.tenantA.id);
      const resultBlob = rec.toolCallRow!.result as Record<string, unknown>;
      expect(resultBlob.tenantId).toBe(seed.tenantA.id);
      // Verify the real appointment actually landed in the clinic tenant, confirming the blob is accurate and not coincidental.
      const apptRows = await harness.dataSource.query(`SELECT "tenantId" FROM appointments WHERE id = $1`, [
        rec.toolCallRow!.appointment_id,
      ]);
      expect(apptRows[0].tenantId).toBe(seed.tenantA.id);

      // [PROMOTED, RTP row 14] the exact clinic-scoped query the finding asks
      // for: a query that names ONLY the clinic tenant now returns the public
      // booking it received, even though `tenant_id` itself is the discovery
      // tenant, not the clinic.
      const clinicScoped = await harness.dataSource.query(
        `SELECT id FROM ai_tool_calls WHERE tool_name = $1 AND ai_conversation_id = $2 AND (tenant_id = $3 OR resource_tenant_id = $3)`,
        [AI_PUBLIC_TOOL.BOOK_PUBLIC_APPOINTMENT, conv.id, seed.tenantA.id],
      );
      expect(clinicScoped).toHaveLength(1);
      expect(clinicScoped[0].id).toBe(rec.toolCallRow!.id);

      // PII (fullName/phone) is stored verbatim in `arguments`, with no redaction.
      expect(rec.toolCallRow!.arguments).toMatchObject(args);

      // [PROMOTED, RTP row 13] guest exclusion (AI-017/T073) holds: the ATTEMPT/
      // claim actor column is explicit null for a guest-driven booking (the
      // real acting party is the selected clinic's bot actor, resolved
      // server-side — never the guest's own id) — this assertion is
      // UNCHANGED, and its continued truth is itself the proof the guest
      // privacy fix is doing its job here, not an oversight.
      expect(rec.toolCallRow!.actor_user_id).toBeNull();
      expect(appearsAnywhere(guestAPrincipal.id, rec)).toBe(false);
      // [Collateral, same fix as row 12] correlation id is stamped regardless
      // of the acting principal being a guest.
      expect(rec.toolCallRow!.correlation_id).toBe(marker);
      expect(appearsAnywhere(marker, rec)).toBe(true);

      record({
        catalog: 'public',
        outcome: 'ALLOWED',
        tool: AI_PUBLIC_TOOL.BOOK_PUBLIC_APPOINTMENT,
        fields: {
          user: { verdict: 'MISSING', note: 'guest principal id not present as a value anywhere — BY DESIGN (AI-017/T073 guest exclusion): actor_user_id is explicit null for a guest turn, never the guest\'s own id' },
          tenant: { verdict: 'RECOVERED', note: '[PROMOTED, row 14] ai_tool_calls.tenant_id is still the GUEST/CONVERSATION tenant, but ai_tool_calls.resource_tenant_id now directly names the real clinic tenant — a clinic-scoped query (tenant_id = X OR resource_tenant_id = X) returns this booking' },
          'request/correlation id': { verdict: 'RECOVERED', note: '[Collateral, same fix as row 12] ai_tool_calls.correlation_id' },
          conversation: { verdict: 'RECOVERED', note: 'ai_tool_calls.ai_conversation_id' },
          agent: { verdict: 'MISSING', note: 'the discovery-tenant conversation has no ai_agent at all; ai_usage_logs never gets a row for this turn (only written when an agent is present, ai-execution.service.ts:460-461)' },
          channel: { verdict: 'PARTIAL', note: 'per-turn only, stamped under the GUEST tenant' },
          tool: { verdict: 'RECOVERED', note: 'ai_tool_calls.tool_name' },
          'sanitized arguments': { verdict: 'RECOVERED', note: 'stored verbatim, including patient fullName/phone (PII), unredacted' },
          resource: { verdict: 'RECOVERED', note: 'ai_tool_calls.appointment_id' },
          'authorization decision + reason': { verdict: 'PARTIAL', note: 'status=SUCCEEDED only' },
          action: { verdict: 'RECOVERED', note: 'same as tool' },
          outcome: { verdict: 'RECOVERED', note: 'ai_tool_calls.status' },
          'model + token usage': { verdict: 'PARTIAL', note: 'per-turn only, under the guest tenant' },
          cost: { verdict: 'PARTIAL', note: 'per-turn only under the guest tenant; ai_usage_logs never written (no agent)' },
          timestamp: { verdict: 'RECOVERED', note: 'ai_tool_calls.created_at' },
        },
      });
    }, 30_000);

    it('REFUSED: a guest with NO selection context at all is refused — NO ai_tool_calls row exists (8 of the 9 public tools never write one regardless of outcome; this is the ONE that sometimes does, and here it does not because the failure happens before run() is reached)', async () => {
      const conv = await conversations.start(seed.discoveryTenantId, {});
      convIds.push(conv.id);
      await sessions.patch(seed.discoveryTenantId, conv.id, { guestSubject: guestBPrincipal.id });
      // Deliberately NO patchSelection call — requirePublicContext('book') throws
      // "no branch selected" (public-booking-context.service.ts:155-156) before
      // bookPublicAppointment() ever calls this.run().

      const args = { fullName: 'Nobody', phone: '+15555550199' };
      const marker = await driveTurn(
        seed.discoveryTenantId,
        conv.id,
        guestBPrincipal,
        AI_PUBLIC_TOOL.BOOK_PUBLIC_APPOINTMENT,
        args,
      );
      const rec = await fetchRecords(seed.discoveryTenantId, conv.id, AI_PUBLIC_TOOL.BOOK_PUBLIC_APPOINTMENT);

      // UNCHANGED by T067: this precondition failure ("no branch selected",
      // requirePublicContext) throws BEFORE bookPublicAppointment() ever
      // calls run() — it is NOT one of T067's 5 recordAttempt sites (those
      // are the 3 core write tools' permission gates + the 8 admin tools'
      // shared gate; book_public_appointment's SESSION-PRECONDITION failure
      // is neither). So this specific case is genuinely still unledgered.
      expect(rec.toolCallRow).toBeUndefined();
      expect(rec.metricRow).toBeDefined();
      expect(rec.metricRow!.tool_failure_count).toBe(1);
      expect(appearsAnywhere(guestBPrincipal.id, rec)).toBe(false); // guest exclusion (AI-017/T073) — unchanged, still correctly absent
      // [Collateral, same fix as row 12] ai_execution_metrics now ALSO carries
      // correlation_id (M2/T072) — the marker is recoverable via the TURN
      // record even though no ai_tool_calls row exists for this refusal.
      expect(appearsAnywhere(marker, rec)).toBe(true);
      expect(appearsAnywhere('Nobody', rec)).toBe(false); // the refused call's PII args never reach durable storage either

      record({
        catalog: 'public',
        outcome: 'REFUSED',
        tool: AI_PUBLIC_TOOL.BOOK_PUBLIC_APPOINTMENT,
        fields: {
          user: { verdict: 'MISSING', note: 'no row' },
          tenant: { verdict: 'PARTIAL', note: 'per-turn only, under the guest tenant' },
          'request/correlation id': { verdict: 'PARTIAL', note: '[Collateral, same fix as row 12] recoverable via ai_execution_metrics.correlation_id (the turn), no per-call ai_tool_calls row exists for this precondition failure' },
          conversation: { verdict: 'PARTIAL', note: 'per-turn only' },
          agent: { verdict: 'MISSING', note: 'n/a — no agent, no row' },
          channel: { verdict: 'PARTIAL', note: 'per-turn only' },
          tool: { verdict: 'MISSING', note: 'no row names which public tool was refused' },
          'sanitized arguments': { verdict: 'MISSING', note: 'the refused args (including patient PII) never reach any durable table' },
          resource: { verdict: 'MISSING', note: 'n/a — no row' },
          'authorization decision + reason': { verdict: 'MISSING', note: '"no branch selected" reason is never persisted' },
          action: { verdict: 'MISSING', note: 'n/a — no row' },
          outcome: { verdict: 'PARTIAL', note: 'aggregate failure count only' },
          'model + token usage': { verdict: 'PARTIAL', note: 'per-turn only' },
          cost: { verdict: 'PARTIAL', note: 'per-turn only' },
          timestamp: { verdict: 'PARTIAL', note: 'turn timestamp only' },
        },
      });
    }, 30_000);
  });

  it('prints the full reconstruction manifest for T159 evidence capture', () => {
    process.stdout.write('\n===W10-RECONSTRUCTION-MANIFEST-START===\n');
    process.stdout.write(JSON.stringify(manifest, null, 2));
    process.stdout.write('\n===W10-RECONSTRUCTION-MANIFEST-END===\n');
    expect(manifest.length).toBe(6);
  });
});
