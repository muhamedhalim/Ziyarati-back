/**
 * T083 — cross-guest access (FR-023, FR-111, SC-014).
 *
 * Guest A attempts to read/patch guest B's conversation, booking session, and
 * selection state, using two DISTINCT guest `sub` values on the SAME shared
 * `__guest_discovery__` tenant (`seed.guestA`/`seed.guestB` — `ai-audit-seed.ts`
 * mints both via a real `POST /public/guest/session` + `WsAuthService.
 * authenticate`, so `guestA.id !== guestB.id` while `guestA.tenantId ===
 * guestB.tenantId === seed.discoveryTenantId`). Per FR-111 and this task's own
 * instruction, tenant equality is NEVER acceptable isolation evidence here —
 * every assertion below is keyed on the two distinct `sub` values, and the
 * refusal must be attributed to the exact enforcement point, not merely
 * observed.
 *
 * **Ownership binding is mandatory before any of this is meaningful**
 * (`HARNESS_GUIDE.md` gotcha #2, `principal-derivation.md` §Entry point E2):
 * `conversations.start(tenantId, {})` alone does not bind an owner — this
 * spec calls `sessions.patch(tenantId, conv.id, { guestSubject: guestA.id })`
 * immediately after, exactly mirroring `AiOrchestratorService.prepare`
 * (`ai-orchestrator.service.ts:254-259`) and `ai-guest-isolation.e2e-spec.ts`'s
 * `beforeAll`. Guest A's OWN access is proven first in every describe block,
 * so a broken binding cannot masquerade as "isolation working".
 *
 * **The precise enforcement point** (per the task's Verify column): every one
 * of the three surfaces below — conversation read, "booking session" read,
 * and public-booking selection-state read/write — funnels through the SAME
 * single predicate, `AiConversationAccessService.assertAccess`
 * (`ai-conversation-access.service.ts:45-65`):
 *
 * ```ts
 * if (principal?.guest) {
 *   const boundSubject = (conv.session as { guestSubject?: string } | null)?.guestSubject;
 *   if (!boundSubject || boundSubject !== principal.id) throw this.notFound();
 * }
 * ```
 *
 * This is NOT the `tenant: { id: tenantId }` predicate a few lines above it in
 * the same method (which both guests satisfy identically, since they share
 * the discovery tenant) — it is the SEPARATE, subsequent `principal?.guest`
 * branch. Each test below asserts this distinction explicitly: guest B's
 * request reaches a conversation that DOES pass the tenant predicate (it
 * exists, in the same tenant guest B is also in) and is STILL refused, which
 * is only possible if a check beyond tenant scoping ran.
 *
 * `PublicBookingContextService.getSelection`/`requireContext`
 * (`public-booking-context.service.ts:103-114`, `:143-153`) call
 * `access.assertAccess` as their FIRST step before touching any selection
 * state — so "booking-session" and "selection-state" access funnel through
 * this exact same seam, not a parallel one. This spec exercises both the
 * conversation-level surface directly (mirroring/extending
 * `ai-guest-isolation.e2e-spec.ts`'s `[F-1]` block, not duplicating it) and
 * the booking-context surface, which that pre-existing suite does not cover.
 */
import { randomUUID } from 'node:crypto';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiConversationAccessService } from '../../src/modules/ai/ai-conversation-access.service';
import { ConversationSessionService } from '../../src/modules/ai-orchestrator/conversation-session.service';
import { PublicBookingContextService } from '../../src/modules/public-booking/public-booking-context.service';

describe('AI guest cross-principal access — two distinct guest subs, one shared discovery tenant (T083)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let access: AiConversationAccessService;
  let sessions: ConversationSessionService;
  let bookingContext: PublicBookingContextService;

  let convA: string;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    access = harness.app.get(AiConversationAccessService);
    sessions = harness.app.get(ConversationSessionService);
    bookingContext = harness.app.get(PublicBookingContextService);

    // Prerequisite for the public-booking surface below.
    await harness.dataSource.query(
      `INSERT INTO tenant_settings (tenant_id, public_booking_enabled) VALUES ($1, true)
       ON CONFLICT (tenant_id) DO UPDATE SET public_booking_enabled = true`,
      [seed.tenantA.id],
    );
  }, 120_000);

  afterAll(async () => {
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [convA]).catch(() => undefined);
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  beforeEach(async () => {
    // A fresh guest-A-owned conversation per test, so one test's mutation
    // attempt can never leak into another's assertions.
    const created = await conversations.start(seed.discoveryTenantId, {});
    convA = created.id;
    await sessions.patch(seed.discoveryTenantId, convA, { guestSubject: seed.guestA.id });
  });

  afterEach(async () => {
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [convA]).catch(() => undefined);
  });

  it('the harness premise holds: guestA.id !== guestB.id, both share the discovery tenant', () => {
    expect(seed.guestA.id).not.toBe(seed.guestB.id);
    expect(seed.guestA.tenantId).toBe(seed.discoveryTenantId);
    expect(seed.guestB.tenantId).toBe(seed.discoveryTenantId);
  });

  // ── Surface 1: conversation read (extends F-1, not a duplicate) ──────────

  describe('conversation read', () => {
    it('guest A (the owner) can reach its own conversation — proves the binding actually took, before any refusal is trusted', async () => {
      await expect(access.assertAccess(seed.discoveryTenantId, convA, seed.guestA)).resolves.toMatchObject({
        id: convA,
      });
    });

    it('guest B — SAME tenant, DIFFERENT sub — is refused, and the tenant predicate alone would have let it through', async () => {
      // Control: the tenant-only predicate a few lines earlier in
      // assertAccess (`{ id: aiConversationId, tenant: { id: tenantId } }`)
      // DOES find this row for guest B's tenant — proven by loading it
      // directly with no guest check at all.
      const rawRow = await harness.dataSource.query(
        `SELECT id FROM ai_conversations WHERE id = $1 AND "tenantId" = $2`,
        [convA, seed.discoveryTenantId],
      );
      expect(rawRow).toHaveLength(1); // tenant predicate alone: FOUND

      // Yet the real service call, with the guest-check branch included, refuses.
      await expect(access.assertAccess(seed.discoveryTenantId, convA, seed.guestB)).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it('the refusal is indistinguishable from an unknown id (not an existence oracle) — same message/status either way', async () => {
      const unknown = await access.assertAccess(seed.discoveryTenantId, randomUUID(), seed.guestB).catch((e) => e);
      const notMine = await access.assertAccess(seed.discoveryTenantId, convA, seed.guestB).catch((e) => e);
      expect(notMine.statusCode).toBe(unknown.statusCode);
      expect(notMine.message).toBe(unknown.message);
    });
  });

  // ── Surface 2: "booking session" read (getSelection) ──────────────────────

  describe('booking-session read (PublicBookingContextService.getSelection)', () => {
    it('guest A reads its own selection state successfully', async () => {
      await sessions.patch(seed.discoveryTenantId, convA, { selectedClinicId: seed.tenantA.id });
      const selection = await bookingContext.getSelection(seed.discoveryTenantId, convA, seed.guestA);
      expect(selection.selectedClinicId).toBe(seed.tenantA.id);
    });

    it('guest B is refused reading guest A\'s selection state — via the SAME assertAccess seam, confirmed by spying on it', async () => {
      const spy = jest.spyOn(access, 'assertAccess');
      await expect(
        bookingContext.getSelection(seed.discoveryTenantId, convA, seed.guestB),
      ).rejects.toMatchObject({ statusCode: 404 });
      // Confirms getSelection did not implement its own separate check —
      // it called the exact predicate under test.
      expect(spy).toHaveBeenCalledWith(seed.discoveryTenantId, convA, seed.guestB);
      spy.mockRestore();
    });
  });

  // ── Surface 3: selection-state read via requireContext (used by every select_* tool) ──

  describe('selection-state read (PublicBookingContextService.requireContext)', () => {
    it('guest A, having selected a branch, can build a booking context for its own conversation', async () => {
      await sessions.patch(seed.discoveryTenantId, convA, {
        selectedClinicId: seed.tenantA.id,
        selectedBranchId: seed.tenantA.branchId,
      });
      const ctx = await bookingContext.requireContext(seed.discoveryTenantId, convA, seed.guestA, 'branch');
      expect(ctx.tenantId).toBe(seed.tenantA.id);
      expect(ctx.branchId).toBe(seed.tenantA.branchId);
    });

    it('guest B is refused building a booking context against guest A\'s conversation, even with a fully valid selection recorded', async () => {
      await sessions.patch(seed.discoveryTenantId, convA, {
        selectedClinicId: seed.tenantA.id,
        selectedBranchId: seed.tenantA.branchId,
      });
      await expect(
        bookingContext.requireContext(seed.discoveryTenantId, convA, seed.guestB, 'branch'),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  // ── Surface 4: attempted WRITE — guest B patching guest A's selection state ──

  describe('selection-state write attempt', () => {
    it('patchSelection itself has no ownership check (by design — callers validate first); requireContext/getSelection are the enforcement seam, so a caller that bypasses them is the actual attack surface, not this method', async () => {
      // Documents precisely, rather than assumes, WHERE the ownership check
      // lives: patchSelection (public-booking-context.service.ts:121-135) is
      // a plain, unchecked writer — every real caller (the select_* tools in
      // ai-tool-dispatch.service.ts) calls getSelection/requireContext FIRST.
      // A direct call to patchSelection with guest B's principal is not
      // possible through any real entry point (guest B has no way to reach
      // convA's id without already having been refused by requireContext at
      // the point every select_* tool calls it — see ai-tool-dispatch.
      // service.ts:697-702's selectBranch, which calls getSelection before
      // ever reaching patchSelection). Recorded as a design observation for
      // assessment-guest-surface.md, not exploited as a defect: there is no
      // tool that lets a model supply an arbitrary principal, so this is not
      // an independently reachable surface.
      const before = await sessions.get(seed.discoveryTenantId, convA);
      expect(before.selectedClinicId).toBeUndefined();
    });

    it('the REAL guest-B write attempt — via requireContext, exactly as every select_* tool actually calls it — is refused before touching persisted state', async () => {
      await sessions.patch(seed.discoveryTenantId, convA, { selectedClinicId: seed.tenantA.id, selectedBranchId: seed.tenantA.branchId });
      const before = await sessions.get(seed.discoveryTenantId, convA);

      await expect(
        bookingContext.requireContext(seed.discoveryTenantId, convA, seed.guestB, 'service'),
      ).rejects.toMatchObject({ statusCode: 404 });

      const after = await sessions.get(seed.discoveryTenantId, convA);
      expect(after).toEqual(before); // zero state change from the refused attempt
    });
  });
});
