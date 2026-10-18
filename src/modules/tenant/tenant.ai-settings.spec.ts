import { AppError, ErrorCode } from '../../common/errors';
import { FeatureKey } from '../subscription-billing/feature-registry';
import { TenantService } from './tenant.service';

/**
 * The clinic-level WhatsApp AI settings written through `updateSettings`:
 * the on/off switch (`botEnabled`, with its entitlement guard and audit record)
 * and the automatic-takeover window (`aiHumanTakeoverMinutes`).
 */
describe('TenantService.updateSettings — WhatsApp AI settings', () => {
  const build = (stored: Record<string, unknown>) => {
    const saved: Record<string, unknown>[] = [];
    const settings = {
      findOne: jest.fn().mockResolvedValue(stored),
      create: jest.fn(),
      save: jest.fn(async (row: Record<string, unknown>) => {
        saved.push({ ...row });
        return { id: 'ts-1', ...row };
      }),
    };
    const access = {
      assertAccess: jest.fn().mockResolvedValue({ allowed: true }),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new TenantService(
      {} as never,
      settings as never,
      {} as never,
      {} as never,
      access as never,
      audit as never,
    );
    return { service, saved, access, audit };
  };

  const stored = (over: Record<string, unknown> = {}) => ({
    bot_enabled: true,
    ai_human_takeover_minutes: 0,
    ai_schedule_mode: 'ALWAYS',
    ai_assignment_mode: 'ALL',
    ...over,
  });

  describe('botEnabled — switching the AI on', () => {
    it('is refused when the plan does not include the AI assistant, and nothing is saved', async () => {
      const f = build(stored({ bot_enabled: false }));
      f.access.assertAccess.mockRejectedValue(
        new AppError(ErrorCode.NO_ACTIVE_SUBSCRIPTION),
      );

      await expect(
        f.service.updateSettings('t1', { botEnabled: true }, 'u1'),
      ).rejects.toMatchObject({ code: ErrorCode.NO_ACTIVE_SUBSCRIPTION });

      expect(f.saved).toHaveLength(0);
      expect(f.audit.record).not.toHaveBeenCalled();
    });

    it('asks the access authority about THIS clinic and the AI assistant — the same authority as every other gate', async () => {
      const f = build(stored({ bot_enabled: false }));

      await f.service.updateSettings('t1', { botEnabled: true }, 'u1');

      expect(f.access.assertAccess).toHaveBeenCalledWith(
        't1',
        FeatureKey.AI_ASSISTANT,
        expect.objectContaining({ surface: 'http' }),
      );
      expect(f.saved[0].bot_enabled).toBe(true);
    });

    it('saves when the clinic is entitled', async () => {
      const f = build(stored({ bot_enabled: false }));

      const result = await f.service.updateSettings(
        't1',
        { botEnabled: true },
        'u1',
      );

      expect(result.bot_enabled).toBe(true);
    });

    it('is not re-checked when it was already on — an unrelated save must never fail on entitlement', async () => {
      const f = build(stored({ bot_enabled: true }));
      f.access.assertAccess.mockRejectedValue(new Error('would fail'));

      await f.service.updateSettings(
        't1',
        { botEnabled: true, currency: 'SAR' },
        'u1',
      );

      expect(f.access.assertAccess).not.toHaveBeenCalled();
    });
  });

  describe('botEnabled — switching the AI off', () => {
    it('is always allowed, even for a clinic that is not entitled', async () => {
      const f = build(stored({ bot_enabled: true }));
      f.access.assertAccess.mockRejectedValue(new Error('not entitled'));

      await f.service.updateSettings('t1', { botEnabled: false }, 'u1');

      expect(f.access.assertAccess).not.toHaveBeenCalled();
      expect(f.saved[0].bot_enabled).toBe(false);
    });
  });

  describe('audit', () => {
    it('records who switched the assistant on or off, with the before and after', async () => {
      const f = build(stored({ bot_enabled: true }));

      await f.service.updateSettings('t1', { botEnabled: false }, 'u1');

      expect(f.audit.record).toHaveBeenCalledWith({
        tenantId: 't1',
        actorUserId: 'u1',
        action: 'tenant.ai_assistant_toggled',
        entityType: 'tenant_settings',
        entityId: 'ts-1',
        before: { bot_enabled: true },
        after: { bot_enabled: false },
      });
    });

    it('records nothing when the switch did not change, or was not part of the request', async () => {
      const same = build(stored({ bot_enabled: true }));
      await same.service.updateSettings('t1', { botEnabled: true }, 'u1');
      const other = build(stored());
      await other.service.updateSettings('t1', { currency: 'SAR' }, 'u1');

      expect(same.audit.record).not.toHaveBeenCalled();
      expect(other.audit.record).not.toHaveBeenCalled();
    });
  });

  describe('aiHumanTakeoverMinutes', () => {
    it('is saved', async () => {
      const f = build(stored());

      await f.service.updateSettings(
        't1',
        { aiHumanTakeoverMinutes: 30 },
        'u1',
      );

      expect(f.saved[0].ai_human_takeover_minutes).toBe(30);
    });

    it('can be set back to 0 (off)', async () => {
      const f = build(stored({ ai_human_takeover_minutes: 30 }));

      await f.service.updateSettings('t1', { aiHumanTakeoverMinutes: 0 }, 'u1');

      expect(f.saved[0].ai_human_takeover_minutes).toBe(0);
    });

    it('is left alone by a request that does not mention it', async () => {
      const f = build(stored({ ai_human_takeover_minutes: 45 }));

      await f.service.updateSettings('t1', { currency: 'SAR' }, 'u1');

      expect(f.saved[0].ai_human_takeover_minutes).toBe(45);
    });
  });

  describe('aiScheduleMode / aiAssignmentMode', () => {
    it('are saved, and the change is audited with both the old and the new modes', async () => {
      const f = build(stored());

      await f.service.updateSettings(
        't1',
        { aiScheduleMode: 'WORKING_HOURS', aiAssignmentMode: 'ASSIGNED_ONLY' },
        'u1',
      );

      expect(f.saved[0]).toMatchObject({
        ai_schedule_mode: 'WORKING_HOURS',
        ai_assignment_mode: 'ASSIGNED_ONLY',
      });
      expect(f.audit.record).toHaveBeenCalledWith({
        tenantId: 't1',
        actorUserId: 'u1',
        action: 'tenant.ai_policy_updated',
        entityType: 'tenant_settings',
        entityId: 'ts-1',
        before: { ai_schedule_mode: 'ALWAYS', ai_assignment_mode: 'ALL' },
        after: {
          ai_schedule_mode: 'WORKING_HOURS',
          ai_assignment_mode: 'ASSIGNED_ONLY',
        },
      });
    });

    it('a request that does not mention them leaves them alone and writes no audit record', async () => {
      const f = build(
        stored({
          ai_schedule_mode: 'OUTSIDE_WORKING_HOURS',
          ai_assignment_mode: 'ASSIGNED_ONLY',
        }),
      );

      await f.service.updateSettings('t1', { currency: 'SAR' }, 'u1');

      expect(f.saved[0]).toMatchObject({
        ai_schedule_mode: 'OUTSIDE_WORKING_HOURS',
        ai_assignment_mode: 'ASSIGNED_ONLY',
      });
      expect(f.audit.record).not.toHaveBeenCalled();
    });

    it('re-sending the current values is not a change: nothing audited', async () => {
      const f = build(stored());

      await f.service.updateSettings(
        't1',
        { aiScheduleMode: 'ALWAYS', aiAssignmentMode: 'ALL' },
        'u1',
      );

      expect(f.audit.record).not.toHaveBeenCalled();
    });

    it('do not need the AI entitlement: narrowing or scheduling is not switching the AI on', async () => {
      const f = build(stored());

      await f.service.updateSettings(
        't1',
        { aiScheduleMode: 'WORKING_HOURS' },
        'u1',
      );

      expect(f.access.assertAccess).not.toHaveBeenCalled();
    });
  });
});
