/**
 * Tenant operational settings — read/write/persistence, tenant isolation,
 * authorization, and business-logic wiring, against real Postgres.
 *
 * This is the backend half of the "Booking & operations" settings tab fix:
 * the frontend regression (UI reverting to the pre-save value) is covered by
 * `Ziyarati-font/.../SettingsSections.test.tsx`; this suite proves the API
 * contract that fix relies on (the PATCH response IS the authoritative saved
 * row) and — per the task's own worked example — that toggling a setting
 * through the REAL `PATCH /tenants/me/settings` endpoint (not a direct DB
 * write, unlike the existing `public-booking-flow`/`public-booking-context`
 * e2e-specs) actually changes what a downstream consumer does:
 *
 *   publicBookingEnabled       -> public clinic discovery listing
 *   enforceStaffWorkingHours   -> availability for an unscheduled staff day
 *   publicBookingEnabled       -> the public AI chatbot's own tools (list_cities /
 *                                 search_clinics / select_clinic), not just REST
 *   botEnabled                 -> whether an inbound WhatsApp message starts an AI turn
 *
 * `bookingConfirmation`, `feedbackDelayMinutes` and `currency` are intentionally
 * NOT given business-logic assertions here — nothing consumes them (wiring them
 * would need a manual-approval flow / a feedback-request job that do not exist),
 * so there is no behaviour to assert; they are reported, not silently skipped.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import {
  createE2eApp,
  createOwnerFixture,
  authHeader,
  cleanupTenant,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { Branch } from '../src/entities/SaaS-Core/Branch';
import { StaffProfile } from '../src/entities/Staff/StaffProfile';
import { User } from '../src/entities/Auth&RBAC/User';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { Role } from '../src/entities/Auth&RBAC/Role';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { City } from '../src/entities/System&Lookup/City';
import {
  AiToolDispatchService,
  type ToolContext,
} from '../src/modules/ai/tools/ai-tool-dispatch.service';
import { AI_TOOL } from '../src/modules/ai/tools/ai-tools.constants';
import { AI_PUBLIC_TOOL } from '../src/modules/ai/tools/ai-public-booking-tools.constants';
import { AiConversationService } from '../src/modules/ai/ai-conversation.service';
import { ConversationSessionService } from '../src/modules/ai-orchestrator/conversation-session.service';
import { AiOrchestratorService } from '../src/modules/ai-orchestrator/ai-orchestrator.service';
import { GuestSessionService } from '../src/modules/guest-chat/guest-session.service';
import { FreeAccessOverrideService } from '../src/modules/subscription-billing/free-access-override.service';
import { WhatsappInboundAiService } from '../src/modules/whatsapp/whatsapp-inbound-ai.service';
import type { AuthenticatedUser } from '../src/modules/auth/interfaces/authenticated-user.interface';

const API = '/api/v1';
const SUITE = `ts-${randomUUID().slice(0, 8)}`;

describe('Tenant settings — real Postgres', () => {
  let e2e: E2eApp;
  let ownerA: OwnerFixture;
  let ownerB: OwnerFixture;
  let receptionistToken: string;
  let branchId: string;
  let staffId: string;

  beforeAll(async () => {
    e2e = await createE2eApp();
    ownerA = await createOwnerFixture(e2e, `${SUITE}-a`);
    ownerB = await createOwnerFixture(e2e, `${SUITE}-b`);

    const ds = e2e.dataSource;

    // A branch + a staff member with NO StaffSchedule row — the exact
    // "nothing configured for this day" case `enforceStaffWorkingHours`
    // decides the meaning of.
    const branch = await ds.getRepository(Branch).save(
      ds.getRepository(Branch).create({
        tenant: { id: ownerA.tenantId } as Tenant,
        name: `${SUITE} Main`,
        is_active: true,
        timezone: 'Asia/Riyadh',
      }),
    );
    branchId = branch.id;

    const doctorUser = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        tenant: { id: ownerA.tenantId } as Tenant,
        email: `doctor-${SUITE}@example.test`,
        full_name: `Dr ${SUITE}`,
        is_active: true,
      }),
    );
    const staff = await ds.getRepository(StaffProfile).save(
      ds.getRepository(StaffProfile).create({
        tenant: { id: ownerA.tenantId } as Tenant,
        user: { id: doctorUser.id } as User,
        // NOT NULL + globally unique (StaffService assigns it in production).
        public_slug: `dr-${SUITE}`,
        title: 'Consultant',
        is_available_for_booking: true,
      }),
    );
    staffId = staff.id;

    // A receptionist principal on tenant A, for the authorization check —
    // same pre-seeded SYSTEM role lookup `createOwnerFixture` uses for
    // 'owner'.
    const receptionistRole = await ds
      .getRepository(Role)
      .createQueryBuilder('r')
      .where('r.slug = :slug', { slug: 'receptionist' })
      .andWhere('r."tenantId" IS NULL')
      .getOne();
    if (!receptionistRole) {
      throw new Error(
        'Seeded system role "receptionist" not found — run the RBAC seed against the test database first.',
      );
    }
    const receptionistUser = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        tenant: { id: ownerA.tenantId } as Tenant,
        email: `receptionist-${SUITE}@example.test`,
        full_name: `Receptionist ${SUITE}`,
        is_active: true,
      }),
    );
    await ds.getRepository(UserRole).save(
      ds.getRepository(UserRole).create({
        user: { id: receptionistUser.id } as User,
        role: { id: receptionistRole.id } as Role,
      }),
    );
    receptionistToken = await e2e.jwt.signAsync(
      { sub: receptionistUser.id, tenantId: ownerA.tenantId, type: 'access' },
      {
        secret: e2e.config.get<string>(
          'JWT_ACCESS_SECRET',
          'dev-access-secret',
        ),
        expiresIn: '15m',
      },
    );
  }, 60_000);

  afterAll(async () => {
    const q = (sql: string, p: unknown[]) =>
      e2e.dataSource.query(sql, p).catch(() => undefined);
    await q(`DELETE FROM staff_profiles WHERE "tenantId" = $1`, [
      ownerA.tenantId,
    ]);
    await q(`DELETE FROM branches WHERE "tenantId" = $1`, [ownerA.tenantId]);
    await q(`DELETE FROM tenant_settings WHERE tenant_id = $1`, [
      ownerA.tenantId,
    ]);
    await q(`DELETE FROM tenant_settings WHERE tenant_id = $1`, [
      ownerB.tenantId,
    ]);
    await cleanupTenant(e2e, ownerA.tenantId);
    await cleanupTenant(e2e, ownerB.tenantId);
    await e2e.app.close();
  }, 30_000);

  // ── Read / write / persistence ──────────────────────────────────────── //

  describe('read/write/persistence', () => {
    it('GET lazily creates and returns a default settings row', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerA.token))
        .expect(200);

      expect(res.body).toMatchObject({
        booking_confirmation: 'AUTO',
        payment_required: true,
        cancellation_hours: 24,
        feedback_delay_minutes: 360,
        default_language: 'ar',
        currency: 'SAR', // default flipped by migration 1730123000000 (Saudi-first)
        bot_enabled: true,
        enforce_staff_working_hours: false,
        public_booking_enabled: false,
        // T011 (spec 014) — fail-closed defaults.
        self_cancellation_enabled: false,
        self_reschedule_enabled: false,
        reminders_enabled: false,
        reminder_lead_minutes: [],
      });
    });

    it('PATCH updates only the supplied fields; the response is the saved row', async () => {
      const res = await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerA.token))
        .send({ cancellationHours: 48, botEnabled: false })
        .expect(200);

      expect(res.body.cancellation_hours).toBe(48);
      expect(res.body.bot_enabled).toBe(false);
      // Untouched fields keep their prior value — partial update, not a reset.
      expect(res.body.booking_confirmation).toBe('AUTO');
      expect(res.body.default_language).toBe('ar');
    });

    it('the PATCH is durably persisted — a fresh GET reflects it', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerA.token))
        .expect(200);

      expect(res.body.cancellation_hours).toBe(48);
      expect(res.body.bot_enabled).toBe(false);
    });

    it('T011 (spec 014): PATCH round-trips the self-service/reminder switches', async () => {
      const res = await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerA.token))
        .send({
          selfCancellationEnabled: true,
          remindersEnabled: true,
          reminderLeadMinutes: [1440, 60],
        })
        .expect(200);

      expect(res.body.self_cancellation_enabled).toBe(true);
      expect(res.body.self_reschedule_enabled).toBe(false); // untouched
      expect(res.body.reminders_enabled).toBe(true);
      expect(res.body.reminder_lead_minutes).toEqual([1440, 60]);
    });

    it('T011 (spec 014): PATCH rejects a reminder lead time outside the supported set', async () => {
      const res = await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerA.token))
        .send({ reminderLeadMinutes: [45] })
        .expect(400);

      expect(res.body.message).toBeDefined();
    });
  });

  // ── Tenant isolation / IDOR ─────────────────────────────────────────── //

  describe('tenant isolation', () => {
    it("tenant B's settings are untouched by tenant A's PATCH", async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerB.token))
        .expect(200);

      expect(res.body.cancellation_hours).toBe(24);
      expect(res.body.bot_enabled).toBe(true);
    });

    it("tenant B PATCHing its own settings never affects tenant A's row", async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerB.token))
        .send({ cancellationHours: 5 })
        .expect(200);

      const a = await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerA.token))
        .expect(200);
      expect(a.body.cancellation_hours).toBe(48); // still tenant A's own value

      const b = await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerB.token))
        .expect(200);
      expect(b.body.cancellation_hours).toBe(5);
    });
  });

  // ── Authorization ────────────────────────────────────────────────────── //

  describe('authorization', () => {
    it('a receptionist (neither owner nor manager) cannot update settings', async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/settings`)
        .set(...authHeader(receptionistToken))
        .send({ botEnabled: true })
        .expect(403);
    });

    it('a receptionist can still read settings (read is any authenticated tenant user)', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/me/settings`)
        .set(...authHeader(receptionistToken))
        .expect(200);
    });
  });

  // ── Business logic: publicBookingEnabled -> public discovery ───────────
  // The task's own worked example: Settings = Disabled -> Save -> Database
  // -> Public Booking/Discovery -> clinic not offered; Enabled -> offered.

  describe('business logic — publicBookingEnabled drives public clinic discovery', () => {
    it('disabled (the default): the clinic is not listed', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/public/discovery/clinics`)
        .query({ q: SUITE })
        .expect(200);
      expect(
        res.body.find((c: { id: string }) => c.id === ownerA.tenantId),
      ).toBeUndefined();
    });

    it('enabling it via the real settings PATCH makes the clinic discoverable', async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerA.token))
        .send({ publicBookingEnabled: true })
        .expect(200);

      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/public/discovery/clinics`)
        .query({ q: SUITE })
        .expect(200);
      expect(
        res.body.find((c: { id: string }) => c.id === ownerA.tenantId),
      ).toBeDefined();
    });

    it('disabling it again via PATCH removes the clinic from discovery', async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerA.token))
        .send({ publicBookingEnabled: false })
        .expect(200);

      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/public/discovery/clinics`)
        .query({ q: SUITE })
        .expect(200);
      expect(
        res.body.find((c: { id: string }) => c.id === ownerA.tenantId),
      ).toBeUndefined();
    });
  });

  // ── Business logic: enforceStaffWorkingHours -> availability ───────────

  describe('business logic — enforceStaffWorkingHours drives staff availability', () => {
    const window = {
      branchId: '',
      staffId: '',
      startTime: '2027-04-12T10:00:00.000Z',
      endTime: '2027-04-12T10:30:00.000Z',
    };

    beforeAll(() => {
      window.branchId = branchId;
      window.staffId = staffId;
    });

    it('off (the default): a staff day with no configured schedule is unconstrained by working hours', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/scheduling/availability/check`)
        .set(...authHeader(ownerA.token))
        .query(window)
        .expect(200);
      expect(res.body.conflicts.outsideAvailability).toBe(false);
    });

    it('turning it on via the real settings PATCH makes the same unscheduled window unbookable', async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerA.token))
        .send({ enforceStaffWorkingHours: true })
        .expect(200);

      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/scheduling/availability/check`)
        .set(...authHeader(ownerA.token))
        .query(window)
        .expect(200);
      expect(res.body.conflicts.outsideAvailability).toBe(true);
      expect(res.body.available).toBe(false);
    });

    it('turning it back off restores the unconstrained default', async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerA.token))
        .send({ enforceStaffWorkingHours: false })
        .expect(200);

      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/scheduling/availability/check`)
        .set(...authHeader(ownerA.token))
        .query(window)
        .expect(200);
      expect(res.body.conflicts.outsideAvailability).toBe(false);
    });
  });
  // ── Profile: optional text fields must be clearable ──────────────────────── //

  describe('profile — optional fields can be cleared', () => {
    const patchProfile = (body: Record<string, unknown>) =>
      request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me`)
        .set(...authHeader(ownerA.token))
        .send(body)
        .expect(200);
    const readProfile = () =>
      request(e2e.app.getHttpServer())
        .get(`${API}/tenants/me`)
        .set(...authHeader(ownerA.token))
        .expect(200);

    it('a blank legalName / contactPhone clears to NULL; an OMITTED field is left alone', async () => {
      await patchProfile({ legalName: 'Legal LLC', contactPhone: '+966500000009' });
      expect((await readProfile()).body).toMatchObject({
        legal_name: 'Legal LLC',
        contact_phone: '+966500000009',
      });

      // Omitting a field must NOT clear it…
      await patchProfile({ name: `E2E Clinic ${SUITE}` });
      expect((await readProfile()).body).toMatchObject({
        legal_name: 'Legal LLC',
        contact_phone: '+966500000009',
      });

      // …but sending it blank must (it used to answer 200 and keep the old value).
      const cleared = await patchProfile({ legalName: '', contactPhone: '   ' });
      expect(cleared.body.legal_name).toBeNull();
      expect(cleared.body.contact_phone).toBeNull();
      const stored = (await readProfile()).body;
      expect(stored.legal_name).toBeNull();
      expect(stored.contact_phone).toBeNull();
    });

    it("tenant B's profile is untouched by tenant A clearing its own", async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me`)
        .set(...authHeader(ownerB.token))
        .send({ legalName: 'B Legal LLC' })
        .expect(200);

      await patchProfile({ legalName: '' });

      const b = await request(e2e.app.getHttpServer())
        .get(`${API}/tenants/me`)
        .set(...authHeader(ownerB.token))
        .expect(200);
      expect(b.body.legal_name).toBe('B Legal LLC');
    });
  });

  // ── Settings PATCH → the PUBLIC CHATBOT (real tool dispatcher) ───────────── //

  describe('business logic — publicBookingEnabled drives the public AI chatbot', () => {
    let tools: AiToolDispatchService;
    let ctx: ToolContext;
    let cityId: string;
    const convIds: string[] = [];

    /** Calls a tool exactly as the model would — through the real dispatcher. */
    const call = (name: string, args: Record<string, unknown> = {}) =>
      tools.execute(ctx, {
        id: randomUUID(),
        name,
        arguments: JSON.stringify(args),
      });

    const setPublicBooking = (enabled: boolean) =>
      request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerA.token))
        .send({ publicBookingEnabled: enabled })
        .expect(200);

    beforeAll(async () => {
      const ds = e2e.dataSource;
      tools = e2e.app.get(AiToolDispatchService);

      const city = await ds.getRepository(City).save(
        ds.getRepository(City).create({
          name_en: `Chatville ${SUITE}`,
          name_ar: `مدينة ${SUITE}`,
        }),
      );
      cityId = city.id;
      await ds.getRepository(Branch).update({ id: branchId }, { city_id: cityId });

      // Unmetered, so an entitlement decision can never be what hides the clinic.
      await e2e.app.get(FreeAccessOverrideService).grant(ownerA.tenantId, {
        reason: `e2e ${SUITE}`,
        durationDays: null,
      });

      const discoveryTenantId = await e2e.app
        .get(GuestSessionService)
        .ensureDiscoveryTenant();
      const guest: AuthenticatedUser = {
        id: randomUUID(),
        tenantId: discoveryTenantId,
        email: null,
        roles: [],
        permissions: [],
        guest: true,
      };
      const conv = await e2e.app
        .get(AiConversationService)
        .start(discoveryTenantId, {});
      convIds.push(conv.id);
      await e2e.app
        .get(ConversationSessionService)
        .patch(discoveryTenantId, conv.id, { guestSubject: guest.id });
      ctx = {
        tenantId: discoveryTenantId,
        aiConversationId: conv.id,
        permissions: [],
        principal: guest,
      };
    }, 60_000);

    afterAll(async () => {
      const q = (sql: string, p: unknown[]) =>
        e2e.dataSource.query(sql, p).catch(() => undefined);
      await q(`DELETE FROM ai_messages WHERE ai_conversation_id = ANY($1)`, [
        convIds,
      ]);
      await q(`DELETE FROM ai_tool_calls WHERE ai_conversation_id = ANY($1)`, [
        convIds,
      ]);
      await q(`DELETE FROM ai_conversations WHERE id = ANY($1)`, [convIds]);
      await q(`DELETE FROM free_access_overrides WHERE tenant_id = $1`, [
        ownerA.tenantId,
      ]);
      await q(`UPDATE branches SET city_id = NULL WHERE id = $1`, [branchId]);
      await q(`DELETE FROM cities WHERE id = $1`, [cityId]);
    }, 30_000);

    const offered = async () => ({
      cities: JSON.stringify(await call(AI_PUBLIC_TOOL.LIST_CITIES)),
      clinics: JSON.stringify(
        await call(AI_TOOL.SEARCH_CLINICS, { query: SUITE }),
      ),
      selected: (await call(AI_PUBLIC_TOOL.SELECT_CLINIC, {
        clinicId: ownerA.tenantId,
      })) as { success?: boolean },
    });

    it('OFF: the clinic is invisible to the chatbot and cannot be selected for booking', async () => {
      await setPublicBooking(false);

      const seen = await offered();

      expect(seen.cities).not.toContain(cityId);
      expect(seen.clinics).not.toContain(ownerA.tenantId);
      expect(seen.selected.success).toBe(false);
    });

    it('ON (via the real settings PATCH): the clinic appears and can be selected', async () => {
      await setPublicBooking(true);

      const seen = await offered();

      expect(seen.cities).toContain(cityId);
      expect(seen.clinics).toContain(ownerA.tenantId);
      expect(seen.selected.success).toBe(true);
    });

    it('OFF again: the change takes effect immediately — nothing serves a stale "listed" answer', async () => {
      await setPublicBooking(false);

      const seen = await offered();

      expect(seen.cities).not.toContain(cityId);
      expect(seen.clinics).not.toContain(ownerA.tenantId);
      expect(seen.selected.success).toBe(false);
    });
  });

  // ── Settings PATCH → the inbound WhatsApp AI auto-reply ──────────────────── //

  describe('business logic — botEnabled drives the inbound WhatsApp AI reply', () => {
    let inbound: WhatsappInboundAiService;
    let handleStream: jest.SpyInstance;

    const setBot = (enabled: boolean) =>
      request(e2e.app.getHttpServer())
        .patch(`${API}/tenants/me/settings`)
        .set(...authHeader(ownerA.token))
        .send({ botEnabled: enabled })
        .expect(200);

    const deliver = () =>
      inbound.handleInboundValue(ownerA.tenantId, {
        messaging_product: 'whatsapp',
        metadata: { phone_number_id: `pnid-${SUITE}` },
        messages: [
          {
            id: `wamid.${SUITE}.${randomUUID().slice(0, 6)}`,
            from: '966500000123',
            type: 'text',
            text: { body: 'hello' },
          },
        ],
      } as never);

    beforeAll(async () => {
      inbound = e2e.app.get(WhatsappInboundAiService);
      // The AI itself is not under test (and there is no model key here) — what
      // is under test is whether the clinic's own switch lets a turn START.
      // A turn needs a thread, which comes from the account the message arrived on.
      await e2e.dataSource.query(
        `INSERT INTO whatsapp_accounts (phone_number_id, connection_status, is_default, is_active, "tenantId") VALUES ($1,'CONNECTED',true,true,$2)`,
        [`pnid-${SUITE}`, ownerA.tenantId],
      );
      handleStream = jest
        .spyOn(e2e.app.get(AiOrchestratorService), 'handleStream')
        .mockResolvedValue({ reply: undefined } as never);
      await e2e.app.get(FreeAccessOverrideService).grant(ownerA.tenantId, {
        reason: `e2e-bot ${SUITE}`,
        durationDays: null,
      });
    }, 30_000);

    beforeEach(() => handleStream.mockClear());

    afterAll(async () => {
      handleStream.mockRestore();
      const q = (sql: string, p: unknown[]) =>
        e2e.dataSource.query(sql, p).catch(() => undefined);
      await q(`DELETE FROM free_access_overrides WHERE tenant_id = $1`, [
        ownerA.tenantId,
      ]);
      // A live inbound turn provisions the clinic's AI Bot Actor: a tenant-scoped
      // role, its grants, and an audit row — all of which FK the tenant.
      await q(
        `DELETE FROM user_roles WHERE "userId" IN (SELECT id FROM users WHERE "tenantId" = $1)`,
        [ownerA.tenantId],
      );
      await q(
        `DELETE FROM role_permissions WHERE "roleId" IN (SELECT id FROM roles WHERE "tenantId" = $1)`,
        [ownerA.tenantId],
      );
      await q(`DELETE FROM roles WHERE "tenantId" = $1`, [ownerA.tenantId]);
      await q(`DELETE FROM audit_logs WHERE "tenantId" = $1`, [ownerA.tenantId]);
    });

    it('OFF: an inbound message starts no AI turn', async () => {
      await setBot(false);

      await deliver();

      expect(handleStream).not.toHaveBeenCalled();
    });

    it('ON (via the real settings PATCH): the same inbound message starts the AI turn', async () => {
      await setBot(true);

      await deliver();

      expect(handleStream).toHaveBeenCalledTimes(1);
    });

    it('OFF again: the switch is read per message, never cached', async () => {
      await setBot(false);

      await deliver();

      expect(handleStream).not.toHaveBeenCalled();
    });
  });

});
