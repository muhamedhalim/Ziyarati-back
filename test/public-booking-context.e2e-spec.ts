/**
 * Phase 2 — real-Postgres proof that the PUBLIC booking tenant can only ever be
 * derived server-side, and fails closed on every dimension.
 *
 * WHY THIS MATTERS: an anonymous visitor is authenticated into the shared
 * `__guest_discovery__` tenant. That is the CONVERSATION context and must never
 * be the tenant a booking is written to — nor may the visitor nominate one.
 * `PublicBookingContextService.resolveTenantFromBranch` is the single place a
 * booking tenant is produced, and it takes a BRANCH id, never a tenant id.
 *
 * Each test below removes exactly one precondition and asserts the resolution
 * stops. Together they pin the "no input can carry a tenantId" property that
 * the whole public booking design rests on.
 */
import { randomUUID } from 'node:crypto';

import { createE2eApp, cleanupTenant, type E2eApp } from './utils/whatsapp-e2e-app';
import { PublicBookingContextService } from '../src/modules/public-booking/public-booking-context.service';
import { AiConversationService } from '../src/modules/ai/ai-conversation.service';
import { ConversationSessionService } from '../src/modules/ai-orchestrator/conversation-session.service';
import { GuestSessionService } from '../src/modules/guest-chat/guest-session.service';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { TenantSetting } from '../src/entities/SaaS-Core/TenantSetting';
import { Branch } from '../src/entities/SaaS-Core/Branch';
import { TenantApprovalStatus } from '../src/entities/enums';
import type { AuthenticatedUser } from '../src/modules/auth/interfaces/authenticated-user.interface';

const SUITE = `pbc-${randomUUID().slice(0, 8)}`;

interface ClinicFixture {
  tenantId: string;
  branchId: string;
}

describe('PublicBookingContextService — real Postgres (Phase 2)', () => {
  let e2e: E2eApp;
  let context: PublicBookingContextService;
  let conversations: AiConversationService;
  let sessions: ConversationSessionService;

  let discoveryTenantId: string;
  let guest: AuthenticatedUser;
  let convId: string;

  const created: string[] = [];

  /** An APPROVED, active, opted-in clinic with one active branch. */
  async function makeClinic(
    label: string,
    overrides: {
      approvalStatus?: TenantApprovalStatus;
      tenantActive?: boolean;
      tenantDeleted?: boolean;
      branchActive?: boolean;
      branchDeleted?: boolean;
      publicBookingEnabled?: boolean;
    } = {},
  ): Promise<ClinicFixture> {
    const tenants = e2e.dataSource.getRepository(Tenant);
    const branches = e2e.dataSource.getRepository(Branch);
    const settings = e2e.dataSource.getRepository(TenantSetting);

    const tenant = await tenants.save(
      tenants.create({
        name: `E2E ${label} ${SUITE}`,
        slug: `e2e-${label}-${SUITE}`,
        contact_email: `${label}-${SUITE}@example.test`,
        approval_status: overrides.approvalStatus ?? TenantApprovalStatus.APPROVED,
        is_active: overrides.tenantActive ?? true,
      }),
    );
    created.push(tenant.id);

    await settings.save(
      settings.create({
        tenant: { id: tenant.id } as Tenant,
        public_booking_enabled: overrides.publicBookingEnabled ?? true,
      }),
    );

    const branch = await branches.save(
      branches.create({
        tenant: { id: tenant.id } as Tenant,
        name: `${label} Main`,
        is_active: overrides.branchActive ?? true,
      }),
    );

    if (overrides.branchDeleted) await branches.softDelete(branch.id);
    if (overrides.tenantDeleted) await tenants.softDelete(tenant.id);

    return { tenantId: tenant.id, branchId: branch.id };
  }

  beforeAll(async () => {
    e2e = await createE2eApp();
    context = e2e.app.get(PublicBookingContextService);
    conversations = e2e.app.get(AiConversationService);
    sessions = e2e.app.get(ConversationSessionService);

    discoveryTenantId = await e2e.app.get(GuestSessionService).ensureDiscoveryTenant();
    guest = {
      id: randomUUID(),
      tenantId: discoveryTenantId,
      email: null,
      roles: [],
      permissions: [],
      guest: true,
    };

    convId = (await conversations.start(discoveryTenantId, {})).id;
    await sessions.patch(discoveryTenantId, convId, { guestSubject: guest.id });
  }, 90_000);

  afterAll(async () => {
    await e2e.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [
      convId,
    ]).catch(() => undefined);
    await e2e.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [convId]);
    for (const tenantId of created) {
      await e2e.dataSource.query(`DELETE FROM tenant_settings WHERE tenant_id = $1`, [tenantId]);
      await e2e.dataSource.query(`DELETE FROM branches WHERE "tenantId" = $1`, [tenantId]);
      await cleanupTenant(e2e, tenantId);
    }
    await e2e.app.close();
  }, 60_000);

  describe('resolveTenantFromBranch — the only producer of a booking tenant', () => {
    it('resolves the owning clinic from a branch of a fully eligible clinic', async () => {
      const clinic = await makeClinic('ok');
      await expect(context.resolveTenantFromBranch(clinic.branchId)).resolves.toBe(
        clinic.tenantId,
      );
    });

    it('refuses a clinic that has NOT opted in to public booking', async () => {
      const clinic = await makeClinic('optout', { publicBookingEnabled: false });
      await expect(
        context.resolveTenantFromBranch(clinic.branchId),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('refuses a clinic with no tenant_settings row at all (COALESCE defaults to opted-out)', async () => {
      const clinic = await makeClinic('nosettings');
      await e2e.dataSource.query(`DELETE FROM tenant_settings WHERE tenant_id = $1`, [
        clinic.tenantId,
      ]);
      await expect(
        context.resolveTenantFromBranch(clinic.branchId),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it.each([
      ['a clinic pending approval', 'pending', { approvalStatus: TenantApprovalStatus.PENDING_APPROVAL }],
      ['a suspended clinic', 'suspended', { approvalStatus: TenantApprovalStatus.SUSPENDED }],
      ['a deactivated clinic', 'inactivet', { tenantActive: false }],
      ['a soft-deleted clinic', 'deletedt', { tenantDeleted: true }],
      ['an inactive branch', 'inactiveb', { branchActive: false }],
      ['a soft-deleted branch', 'deletedb', { branchDeleted: true }],
    ])('refuses %s', async (_label, slug, overrides) => {
      const clinic = await makeClinic(slug, overrides);
      await expect(
        context.resolveTenantFromBranch(clinic.branchId),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('refuses an unknown branch id', async () => {
      await expect(context.resolveTenantFromBranch(randomUUID())).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it('refuses an empty branch id without querying', async () => {
      await expect(context.resolveTenantFromBranch('')).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it('gives the same message for every refusal — not a clinic-state oracle', async () => {
      const optedOut = await makeClinic('oracle1', { publicBookingEnabled: false });
      const unapproved = await makeClinic('oracle2', {
        approvalStatus: TenantApprovalStatus.PENDING_APPROVAL,
      });

      const a = await context.resolveTenantFromBranch(optedOut.branchId).catch((e) => e);
      const b = await context.resolveTenantFromBranch(unapproved.branchId).catch((e) => e);
      const c = await context.resolveTenantFromBranch(randomUUID()).catch((e) => e);

      expect(b.message).toBe(a.message);
      expect(c.message).toBe(a.message);
    });
  });

  describe('requireContext — session selections become a booking context', () => {
    it('returns the SELECTED clinic tenant, never the conversation tenant', async () => {
      const clinic = await makeClinic('ctx');
      await context.patchSelection(discoveryTenantId, convId, {
        selectedClinicId: clinic.tenantId,
        selectedBranchId: clinic.branchId,
      });

      const resolved = await context.requireContext(
        discoveryTenantId,
        convId,
        guest,
        'branch',
      );

      expect(resolved.tenantId).toBe(clinic.tenantId);
      expect(resolved.tenantId).not.toBe(discoveryTenantId);
      expect(resolved.branchId).toBe(clinic.branchId);
    });

    it('detects a tampered selectedClinicId that disagrees with the branch owner', async () => {
      const clinic = await makeClinic('tamper1');
      const other = await makeClinic('tamper2');

      await context.patchSelection(discoveryTenantId, convId, {
        selectedClinicId: other.tenantId, // lies about who owns the branch
        selectedBranchId: clinic.branchId,
      });

      await expect(
        context.requireContext(discoveryTenantId, convId, guest, 'branch'),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('re-resolves per call, so a mid-conversation opt-out takes effect immediately', async () => {
      const clinic = await makeClinic('midoptout');
      await context.patchSelection(discoveryTenantId, convId, {
        selectedClinicId: clinic.tenantId,
        selectedBranchId: clinic.branchId,
      });
      await expect(
        context.requireContext(discoveryTenantId, convId, guest, 'branch'),
      ).resolves.toMatchObject({ tenantId: clinic.tenantId });

      await e2e.dataSource.query(
        `UPDATE tenant_settings SET public_booking_enabled = false WHERE tenant_id = $1`,
        [clinic.tenantId],
      );

      await expect(
        context.requireContext(discoveryTenantId, convId, guest, 'branch'),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('reports the missing step (recoverable) rather than a flat refusal', async () => {
      const clinic = await makeClinic('steps');
      await context.patchSelection(discoveryTenantId, convId, {
        selectedClinicId: clinic.tenantId,
        selectedBranchId: clinic.branchId,
        selectedServiceIds: [],
        selectedDoctorId: undefined,
        selectedStartAt: undefined,
      });

      await expect(
        context.requireContext(discoveryTenantId, convId, guest, 'service'),
      ).rejects.toMatchObject({ statusCode: 422, publicContext: { missingStep: 'service' } });

      await context.patchSelection(discoveryTenantId, convId, {
        selectedServiceIds: [randomUUID()],
      });
      await expect(
        context.requireContext(discoveryTenantId, convId, guest, 'doctor'),
      ).rejects.toMatchObject({ statusCode: 422, publicContext: { missingStep: 'doctor' } });

      await context.patchSelection(discoveryTenantId, convId, {
        selectedDoctorId: randomUUID(),
      });
      await expect(
        context.requireContext(discoveryTenantId, convId, guest, 'slot'),
      ).rejects.toMatchObject({ statusCode: 422, publicContext: { missingStep: 'slot' } });
    });

    it('refuses a guest that does not own the conversation, before reading any selection', async () => {
      const stranger: AuthenticatedUser = { ...guest, id: randomUUID() };
      await expect(
        context.requireContext(discoveryTenantId, convId, stranger, 'branch'),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });
});
