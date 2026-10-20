import { AiExecutionService } from './ai-execution.service';
import { AI_TOOL } from './tools/ai-tools.constants';
import {
  DEFAULT_ASSISTANT_SYSTEM_PROMPT,
  DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT,
  DEFAULT_WHATSAPP_SYSTEM_PROMPT,
} from './prompt/default-system-prompt';

/**
 * Focused coverage for the channel matrix `availableTools()` /
 * `defaultSystemPrompt()` decide between — guest web, WhatsApp, and staff
 * (dashboard/REST/WebSocket). Every other collaborator is a stub: neither
 * method touches anything but `this.ctx.getUser()` and the `channel`
 * argument, so a full `sendMessage`/`streamMessage` fixture would only add
 * unrelated maintenance surface (see `ai-execution.service.spec.ts`'s
 * identical convention for `resolveTemperature`).
 *
 * WHY THIS MATTERS: a patient messaging Clinic A's own WhatsApp number must
 * never be offered `search_clinics` / `get_clinic_details` /
 * `search_public_availability` — cross-tenant discovery tools that carry no
 * entry in `AI_TOOL_PERMISSION` and so pass the staff filter unchecked. This
 * is the regression suite for that boundary, and for the two existing
 * branches (guest, staff) staying byte-identical now that a third exists.
 */
describe('AiExecutionService — availableTools() / defaultSystemPrompt() channel matrix', () => {
  let service: AiExecutionService;
  let getUser: jest.Mock;

  beforeEach(() => {
    getUser = jest.fn().mockReturnValue(undefined);
    const unused = {} as any;
    service = new AiExecutionService(
      unused, // aiConversations
      unused, // messages
      unused, // rag
      unused, // providers
      unused, // dataSource
      unused, // usage
      unused, // dispatch
      { getUser } as any, // ctx
      unused, // timeline
      unused, // metrics
      unused, // emitter
      unused, // budgets
      unused, // costs
      unused, // requests
      unused, // modelRouter
      unused, // processingPolicy
      unused, // subscriptions
      unused, // access
      { get: jest.fn().mockReturnValue(10) } as any, // config — constructor reads AI_MAX_TOOL_CALLS_PER_ITERATION eagerly
      unused, // platformSettings
      unused, // bookingContext
      unused, // directives
    );
  });

  const availableTools = (channel: string) =>
    (service as any).availableTools(channel) as { name: string }[];
  const defaultSystemPrompt = (channel: string) =>
    (service as any).defaultSystemPrompt(channel) as string;
  const names = (channel: string) => availableTools(channel).map((t) => t.name);

  describe('WHATSAPP channel (authenticated bot actor)', () => {
    beforeEach(() => {
      getUser.mockReturnValue({
        id: 'bot-user-1',
        guest: false,
        permissions: [],
      });
    });

    it('EXCLUDES the cross-tenant discovery tools', () => {
      const toolNames = names('WHATSAPP');
      expect(toolNames).not.toContain(AI_TOOL.SEARCH_CLINICS);
      expect(toolNames).not.toContain(AI_TOOL.GET_CLINIC_DETAILS);
      expect(toolNames).not.toContain(AI_TOOL.SEARCH_PUBLIC_AVAILABILITY);
    });

    it('INCLUDES the own-clinic discovery tools and book_appointment, regardless of permissions', () => {
      // Deliberately no permissions on this principal — WHATSAPP_CHANNEL_TOOL_NAMES
      // is not permission-filtered the way the staff branch is; the bot
      // actor's real RBAC permissions gate EXECUTION (AiToolDispatchService),
      // not advertisement.
      const toolNames = names('WHATSAPP');
      expect(toolNames).toEqual(
        expect.arrayContaining([
          AI_TOOL.LIST_CLINIC_BRANCHES,
          AI_TOOL.LIST_CLINIC_DOCTORS,
          AI_TOOL.LIST_CLINIC_SERVICES,
          // Own-clinic FACTS: where the branch is, when it is open, and which
          // days a doctor works. Tenant-bound from `ctx.tenantId` exactly like
          // the three above, so they widen what a patient can ask about
          // without widening which clinic they can reach.
          AI_TOOL.GET_BRANCH_INFO,
          AI_TOOL.GET_DOCTOR_SCHEDULE,
          AI_TOOL.CHECK_AVAILABILITY,
          AI_TOOL.GET_CUSTOMER_INSURANCE_STATUS,
          AI_TOOL.BOOK_APPOINTMENT,
          AI_TOOL.RESCHEDULE_APPOINTMENT,
          AI_TOOL.CANCEL_APPOINTMENT,
          // F-27: the patient's own appointments — the only source of a cancel/reschedule id.
          AI_TOOL.LIST_MY_APPOINTMENTS,
          AI_TOOL.REQUEST_HUMAN_HANDOVER,
        ]),
      );
      // And NOTHING else — the admin/dashboard toolset is not offered either.
      expect(toolNames).toHaveLength(12);
    });

    it('uses the WhatsApp system prompt', () => {
      expect(defaultSystemPrompt('WHATSAPP')).toBe(
        DEFAULT_WHATSAPP_SYSTEM_PROMPT,
      );
    });
  });

  describe('guest (public web widget) — unaffected by the new WHATSAPP branch', () => {
    beforeEach(() => {
      getUser.mockReturnValue({
        id: 'guest-sub',
        guest: true,
        permissions: [],
      });
    });

    it('gets the public discovery + public booking toolset on every transport, including WHATSAPP', () => {
      // The guest check runs BEFORE the channel switch, so a guest principal
      // (should one ever appear on a non-web transport) is never downgraded
      // OR upgraded by channel — the existing precedence is preserved.
      for (const channel of ['REST', 'WEBSOCKET', 'WHATSAPP']) {
        const toolNames = names(channel);
        expect(toolNames).toContain(AI_TOOL.SEARCH_CLINICS);
        expect(toolNames).toContain('list_cities');
        expect(toolNames).not.toContain(AI_TOOL.LIST_CLINIC_BRANCHES);
        expect(toolNames).not.toContain(AI_TOOL.LIST_MY_APPOINTMENTS);
      }
    });

    it('uses the public booking system prompt regardless of channel', () => {
      expect(defaultSystemPrompt('REST')).toBe(
        DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT,
      );
      expect(defaultSystemPrompt('WHATSAPP')).toBe(
        DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT,
      );
    });
  });

  describe('staff (dashboard / REST / WebSocket) — unaffected by the new WHATSAPP branch', () => {
    beforeEach(() => {
      getUser.mockReturnValue({
        id: 'staff-user-1',
        guest: false,
        permissions: [],
      });
    });

    it('gets the staff booking + admin toolset (permission-filtered), and never the WhatsApp own-clinic tools', () => {
      for (const channel of ['REST', 'WEBSOCKET']) {
        const toolNames = names(channel);
        expect(toolNames).toContain(AI_TOOL.SEARCH_CLINICS); // unauthenticated-safe, still shared
        expect(toolNames).not.toContain(AI_TOOL.LIST_CLINIC_BRANCHES);
        expect(toolNames).not.toContain(AI_TOOL.LIST_CLINIC_DOCTORS);
        expect(toolNames).not.toContain(AI_TOOL.LIST_CLINIC_SERVICES);
        // Needs a customer bound to the conversation — a WhatsApp contact has one, staff do not.
        expect(toolNames).not.toContain(AI_TOOL.LIST_MY_APPOINTMENTS);
      }
    });

    it('uses the staff system prompt on REST/WEBSOCKET', () => {
      expect(defaultSystemPrompt('REST')).toBe(DEFAULT_ASSISTANT_SYSTEM_PROMPT);
      expect(defaultSystemPrompt('WEBSOCKET')).toBe(
        DEFAULT_ASSISTANT_SYSTEM_PROMPT,
      );
    });
  });
});

/**
 * F-28 — which transport gets which pinned ESTABLISHED BOOKING CONTEXT.
 *
 * The public widget always had one (built from the guest's booking session). A
 * WhatsApp patient is not a guest but has the same problem — tool results are not
 * replayed — so that transport now gets the own-clinic working set. Nobody else
 * does: a staff turn has no booking flow to pin.
 */
describe('AiExecutionService — buildBookingContext() per transport (F-28)', () => {
  const OWN_CLINIC_BLOCK = 'ESTABLISHED BOOKING CONTEXT (own clinic)';
  const PUBLIC_BLOCK = 'ESTABLISHED BOOKING CONTEXT (public)';

  function make(user: unknown) {
    const unused = {} as any;
    const describeOwnClinicContext = jest.fn().mockResolvedValue(OWN_CLINIC_BLOCK);
    const describeSelection = jest.fn().mockResolvedValue(PUBLIC_BLOCK);
    const service = new AiExecutionService(
      unused, // aiConversations
      unused, // messages
      unused, // rag
      unused, // providers
      unused, // dataSource
      unused, // usage
      { describeOwnClinicContext } as any, // dispatch
      { getUser: jest.fn().mockReturnValue(user) } as any, // ctx
      unused, // timeline
      unused, // metrics
      unused, // emitter
      unused, // budgets
      unused, // costs
      unused, // requests
      unused, // modelRouter
      unused, // processingPolicy
      unused, // subscriptions
      unused, // access
      { get: jest.fn().mockReturnValue(10) } as any, // config
      unused, // platformSettings
      { describeSelection } as any, // bookingContext
      unused, // directives
    );
    const build = (channel?: string) =>
      (service as any).buildBookingContext('tenant-1', 'conv-1', channel) as Promise<
        string | undefined
      >;
    return { build, describeOwnClinicContext, describeSelection };
  }

  const bot = { id: 'bot-user-1', guest: false, permissions: [] };
  const staff = { id: 'staff-1', guest: false, permissions: [] };
  const guest = { id: 'guest-sub', guest: true, permissions: [] };

  it('WHATSAPP, non-guest: the own-clinic working set, read for THIS tenant and conversation', async () => {
    const { build, describeOwnClinicContext, describeSelection } = make(bot);

    await expect(build('WHATSAPP')).resolves.toBe(OWN_CLINIC_BLOCK);
    expect(describeOwnClinicContext).toHaveBeenCalledWith('tenant-1', 'conv-1');
    expect(describeSelection).not.toHaveBeenCalled();
  });

  it('WHATSAPP with nothing to pin yet: no block at all', async () => {
    const { build, describeOwnClinicContext } = make(bot);
    describeOwnClinicContext.mockResolvedValue(null);

    await expect(build('WHATSAPP')).resolves.toBeUndefined();
  });

  it('a guest keeps the public block on every transport, WHATSAPP included — never the own-clinic one', async () => {
    for (const channel of ['REST', 'WEBSOCKET', 'WHATSAPP', undefined]) {
      const { build, describeOwnClinicContext, describeSelection } = make(guest);
      await expect(build(channel)).resolves.toBe(PUBLIC_BLOCK);
      expect(describeSelection).toHaveBeenCalledTimes(1);
      expect(describeOwnClinicContext).not.toHaveBeenCalled();
    }
  });

  it('a staff turn on REST / WEBSOCKET / BACKGROUND_JOB gets no block and reads nothing', async () => {
    for (const channel of ['REST', 'WEBSOCKET', 'BACKGROUND_JOB', undefined]) {
      const { build, describeOwnClinicContext, describeSelection } = make(staff);
      await expect(build(channel)).resolves.toBeUndefined();
      expect(describeOwnClinicContext).not.toHaveBeenCalled();
      expect(describeSelection).not.toHaveBeenCalled();
    }
  });

  it('no principal at all: no block', async () => {
    const { build } = make(undefined);
    await expect(build('WHATSAPP')).resolves.toBeUndefined();
  });

  it('an unreadable working set degrades to the date alone — it must never fail the patient’s turn, nor cost it its clock', async () => {
    const { build, describeOwnClinicContext } = make(bot);
    describeOwnClinicContext.mockRejectedValue(new Error('db down'));

    const block = await build('WHATSAPP');
    expect(block).toMatch(/^ESTABLISHED BOOKING CONTEXT\n- today: \d{4}-\d{2}-\d{2} \(/);
    expect(block).not.toContain('(id ');
  });
});
