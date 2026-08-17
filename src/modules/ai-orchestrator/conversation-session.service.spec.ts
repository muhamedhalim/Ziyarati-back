import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  ConversationSessionService,
  SESSION_UNSET,
} from './conversation-session.service';
import { AiConversation } from '../../entities/AI Agent/AiConversation';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

/**
 * N-1 — `sessionPatch` used to be an unvalidated key-space. It reaches
 * `AiSession`, which holds two security-bearing families of keys:
 *
 *   - `guestSubject`, the ownership binding `AiConversationAccessService`
 *     compares against the guest token's `sub`; and
 *   - `selected*` / `context.customerId`, from which the PUBLIC booking flow
 *     derives the clinic tenant and the booking subject.
 *
 * A client that could write either would be injecting a `tenantId` indirectly.
 * `patchFromClient` is the whitelist; `patch` stays open for trusted server
 * writers (touchChannel, setAgent, the `select_*` tools).
 */
const TENANT = 'tenant-1';
const CONV = 'conv-1';

describe('ConversationSessionService', () => {
  let service: ConversationSessionService;
  let conversations: MockRepository;

  /** Returns the merged session the service persisted. */
  const persisted = () =>
    (
      conversations.save.mock.calls.at(-1)?.[0] as {
        session: Record<string, unknown>;
      }
    ).session;

  beforeEach(async () => {
    conversations = createMockRepository();
    conversations.save.mockImplementation(async (c: unknown) => c);
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationSessionService,
        {
          provide: getRepositoryToken(AiConversation),
          useValue: conversations,
        },
      ],
    }).compile();
    service = moduleRef.get(ConversationSessionService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('patchFromClient', () => {
    it('[N-1] drops guestSubject — a client must not be able to adopt a conversation', async () => {
      conversations.findOne.mockResolvedValueOnce({
        id: CONV,
        session: { guestSubject: 'guest-a' },
      });

      await service.patchFromClient(TENANT, CONV, {
        guestSubject: 'attacker',
        currentIntent: 'book',
      } as never);

      expect(persisted()).toMatchObject({
        guestSubject: 'guest-a', // unchanged
        currentIntent: 'book', // client-owned key applied
      });
    });

    it('[N-1] drops selected* — the public booking tenant is derived from selectedBranchId', async () => {
      conversations.findOne.mockResolvedValueOnce({ id: CONV, session: {} });

      await service.patchFromClient(TENANT, CONV, {
        selectedClinicId: 'other-clinic',
        selectedBranchId: 'other-branch',
        selectedDoctorId: 'other-doctor',
        language: 'ar',
      } as never);

      const session = persisted();
      expect(session).not.toHaveProperty('selectedClinicId');
      expect(session).not.toHaveProperty('selectedBranchId');
      expect(session).not.toHaveProperty('selectedDoctorId');
      expect(session).toMatchObject({ language: 'ar' });
    });

    it('[N-1] strips context.customerId — it is the server-bound booking subject', async () => {
      conversations.findOne.mockResolvedValueOnce({
        id: CONV,
        session: {
          context: { customerId: 'real-customer', memoryConsent: true },
        },
      });

      await service.patchFromClient(TENANT, CONV, {
        context: { customerId: 'victim-customer', memoryConsent: false },
      });

      expect(persisted().context).toEqual({
        customerId: 'real-customer', // preserved from the server-written value
        memoryConsent: false, // client-owned context key applied
      });
    });

    it('strips context.recalledMemories (written by the orchestrator memory loader)', async () => {
      conversations.findOne.mockResolvedValueOnce({
        id: CONV,
        session: { context: { recalledMemories: [{ content: 'real' }] } },
      });

      await service.patchFromClient(TENANT, CONV, {
        context: { recalledMemories: [{ content: 'injected' }] },
      });

      expect(persisted().context).toEqual({
        recalledMemories: [{ content: 'real' }],
      });
    });

    it('drops unknown keys silently rather than rejecting (no probe signal)', async () => {
      conversations.findOne.mockResolvedValueOnce({ id: CONV, session: {} });

      await expect(
        service.patchFromClient(TENANT, CONV, { notARealKey: 'x' } as never),
      ).resolves.toBeDefined();
      expect(persisted()).not.toHaveProperty('notARealKey');
    });

    it('applies every client-owned key', async () => {
      conversations.findOne.mockResolvedValueOnce({ id: CONV, session: {} });

      await service.patchFromClient(TENANT, CONV, {
        currentIntent: 'book_appointment',
        language: 'ar',
        currentTool: 'search_clinics',
        currentBooking: { step: 2 },
        device: 'web',
        timezone: 'Asia/Riyadh',
      });

      expect(persisted()).toMatchObject({
        currentIntent: 'book_appointment',
        language: 'ar',
        currentTool: 'search_clinics',
        currentBooking: { step: 2 },
        device: 'web',
        timezone: 'Asia/Riyadh',
      });
    });
  });

  describe('patch (trusted server writers)', () => {
    it('still writes guestSubject — the orchestrator binds it at creation (FND-001)', async () => {
      conversations.findOne.mockResolvedValueOnce({ id: CONV, session: {} });

      await service.patch(TENANT, CONV, { guestSubject: 'guest-a' });

      expect(persisted()).toMatchObject({ guestSubject: 'guest-a' });
    });

    it('still writes selected* — the select_* booking tools depend on it', async () => {
      conversations.findOne.mockResolvedValueOnce({ id: CONV, session: {} });

      await service.patch(TENANT, CONV, { selectedBranchId: 'branch-1' });

      expect(persisted()).toMatchObject({ selectedBranchId: 'branch-1' });
    });

    it('never overwrites existing state with undefined', async () => {
      conversations.findOne.mockResolvedValueOnce({
        id: CONV,
        session: { language: 'ar' },
      });

      await service.patch(TENANT, CONV, { language: undefined });

      expect(persisted()).toMatchObject({ language: 'ar' });
    });

    // AI-006: unlike `undefined` (preserves the value, above), SESSION_UNSET
    // genuinely clears it — this is the fix `selectClinic`'s reset needs.
    it('SESSION_UNSET genuinely clears an existing value (unlike undefined)', async () => {
      conversations.findOne.mockResolvedValueOnce({
        id: CONV,
        session: {
          selectedDoctorId: 'doc-1',
          selectedServiceIds: ['svc-1'],
          selectedStartAt: '2027-06-01T10:00:00Z',
        },
      });

      await service.patch(TENANT, CONV, {
        selectedDoctorId: SESSION_UNSET,
        selectedServiceIds: SESSION_UNSET,
        selectedStartAt: SESSION_UNSET,
      });

      const session = persisted();
      expect(session.selectedDoctorId).toBeNull();
      expect(session.selectedServiceIds).toBeNull();
      expect(session.selectedStartAt).toBeNull();
    });

    // R11 rollback constraint: the sentinel must be a value a PRE-CHANGE
    // reader already tolerates. It is stored as a plain JSON `null` — not a
    // symbol or a wrapper object — which is exactly what makes it safe: any
    // existing or future reader doing a truthy/nullish check on this field
    // treats it identically to "absent", with no sentinel-awareness required.
    it('R11 — the stored sentinel is a plain null, not a special marker type', async () => {
      conversations.findOne.mockResolvedValueOnce({
        id: CONV,
        session: { selectedDoctorId: 'doc-1' },
      });

      await service.patch(TENANT, CONV, { selectedDoctorId: SESSION_UNSET });

      const stored = persisted().selectedDoctorId;
      expect(stored).toBe(null);
      expect(typeof stored).toBe('object'); // typeof null — confirms it is JSON `null`, not undefined/a symbol
      expect(stored).toBeFalsy(); // any `if (session.selectedDoctorId)` reader already treats this as unset
    });
  });
});
