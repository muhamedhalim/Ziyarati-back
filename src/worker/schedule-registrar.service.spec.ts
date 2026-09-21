import { ScheduleRegistrarService } from './schedule-registrar.service';
import { QueueService } from '../queue/queue.service';
import { JOB, QUEUE } from '../queue/queue.constants';

describe('ScheduleRegistrarService', () => {
  let service: ScheduleRegistrarService;
  let queue: { addRepeatable: jest.Mock };
  let config: { get: jest.Mock };

  beforeEach(() => {
    queue = { addRepeatable: jest.fn().mockResolvedValue(undefined) };
    config = { get: jest.fn((_key: string, fallback?: unknown) => fallback) };
    service = new ScheduleRegistrarService(
      queue as unknown as QueueService,
      config as any,
    );
  });

  /**
   * FND-014 — monthly reports had no scheduled fallback (manual-only). Fails
   * today because no `kind: 'monthly'` repeatable is registered at all — the
   * only `QUEUE.ANALYTICS`/`JOB.ANALYTICS_GENERATE_REPORT` registration is the
   * pre-existing DAILY sweep (`kind` absent).
   */
  it('registers a monthly report tick, offset from the daily analytics.generateReport cron', async () => {
    await service.onApplicationBootstrap();

    const monthlyCall = queue.addRepeatable.mock.calls.find(
      ([q, name, data]) =>
        q === QUEUE.ANALYTICS &&
        name === JOB.ANALYTICS_GENERATE_REPORT &&
        (data as { kind?: string })?.kind === 'monthly',
    );
    expect(monthlyCall).toBeDefined();
    const [, , data, cron] = monthlyCall!;
    expect(data).toMatchObject({ tenantId: null, kind: 'monthly' });
    // Runs monthly (not daily), and strictly after the daily 00:30 UTC tick.
    expect(cron).toBe('35 0 1 * *');
  });

  it('still registers the pre-existing daily analytics.generateReport sweep unchanged', async () => {
    await service.onApplicationBootstrap();

    expect(queue.addRepeatable).toHaveBeenCalledWith(
      QUEUE.ANALYTICS,
      JOB.ANALYTICS_GENERATE_REPORT,
      { tenantId: null },
      '30 0 * * *',
    );
  });

  it('registers the campaign DLQ recovery sweep, every 5 minutes (FND-020)', async () => {
    await service.onApplicationBootstrap();

    expect(queue.addRepeatable).toHaveBeenCalledWith(
      QUEUE.CAMPAIGNS_MAINTENANCE,
      JOB.CAMPAIGNS_RECOVER_DLQ,
      { tenantId: null },
      '*/5 * * * *',
    );
  });

  it('does not throw when the queue is unreachable (fail-soft boot)', async () => {
    queue.addRepeatable.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  // ── T024 (spec 014): the four new repeatable sweeps ────────────────────
  it('registers subscriptions.renewalBill daily, offset from the pre-existing renewal check', async () => {
    await service.onApplicationBootstrap();
    expect(queue.addRepeatable).toHaveBeenCalledWith(
      QUEUE.SUBSCRIPTIONS,
      JOB.SUBSCRIPTIONS_RENEWAL_BILL,
      { tenantId: null },
      '15 2 * * *',
    );
    expect(queue.addRepeatable).toHaveBeenCalledWith(
      QUEUE.SUBSCRIPTIONS,
      JOB.SUBSCRIPTIONS_RENEWAL_CHECK,
      { tenantId: null },
      '0 2 * * *',
    );
  });

  it('registers platform.waitlistExpiry every 5 minutes', async () => {
    await service.onApplicationBootstrap();
    expect(queue.addRepeatable).toHaveBeenCalledWith(
      QUEUE.PLATFORM,
      JOB.PLATFORM_WAITLIST_EXPIRY,
      { tenantId: null },
      '*/5 * * * *',
    );
  });

  it('registers platform.queueDayClose daily', async () => {
    await service.onApplicationBootstrap();
    expect(queue.addRepeatable).toHaveBeenCalledWith(
      QUEUE.PLATFORM,
      JOB.PLATFORM_QUEUE_DAY_CLOSE,
      { tenantId: null },
      '50 23 * * *',
    );
  });

  it('registers platform.birthdayGreetings hourly', async () => {
    await service.onApplicationBootstrap();
    expect(queue.addRepeatable).toHaveBeenCalledWith(
      QUEUE.PLATFORM,
      JOB.PLATFORM_BIRTHDAY_GREETINGS,
      { tenantId: null },
      '10 * * * *',
    );
  });

  it('registers platform.exportExpiry daily, not colliding with any other platform/ai sweep', async () => {
    await service.onApplicationBootstrap();
    expect(queue.addRepeatable).toHaveBeenCalledWith(
      QUEUE.PLATFORM,
      JOB.PLATFORM_EXPORT_EXPIRY,
      { tenantId: null },
      '45 4 * * *',
    );
    const platformCrons = queue.addRepeatable.mock.calls
      .filter(([q]) => q === QUEUE.PLATFORM)
      .map(([, , , cron]) => cron);
    expect(new Set(platformCrons).size).toBe(platformCrons.length);
  });

  it('registration is idempotent across simulated replicas — two bootstraps issue the identical call set', async () => {
    await service.onApplicationBootstrap();
    const firstRound = [...queue.addRepeatable.mock.calls];
    queue.addRepeatable.mockClear();

    await service.onApplicationBootstrap(); // a second worker replica booting
    const secondRound = [...queue.addRepeatable.mock.calls];

    expect(secondRound).toEqual(firstRound);
  });

  /**
   * AI-008 (FR-029c, T077/T078): the ai_tool_calls attempt-row retention purge
   * must be a real repeatable sweep, and its cron slot must not collide with
   * the two other daily-ish sweeps it was deliberately offset from.
   */
  it('registers the AI tool-call retention purge, offset from the AI memory cleanup and analytics cleanup sweeps', async () => {
    await service.onApplicationBootstrap();

    expect(queue.addRepeatable).toHaveBeenCalledWith(
      QUEUE.AI,
      JOB.AI_MEMORY_CLEANUP,
      { tenantId: null },
      '0 4 * * *',
    );
    expect(queue.addRepeatable).toHaveBeenCalledWith(
      QUEUE.AI,
      JOB.AI_TOOL_CALL_RETENTION,
      { tenantId: null },
      '30 4 * * *',
    );
    expect(queue.addRepeatable).toHaveBeenCalledWith(
      QUEUE.ANALYTICS,
      JOB.ANALYTICS_CLEANUP,
      { tenantId: null },
      '15 3 * * *',
    );

    const crons = [
      '15 3 * * *', // ANALYTICS_CLEANUP
      '0 4 * * *', // AI_MEMORY_CLEANUP
      '30 4 * * *', // AI_TOOL_CALL_RETENTION
    ];
    expect(new Set(crons).size).toBe(crons.length);
  });
});
