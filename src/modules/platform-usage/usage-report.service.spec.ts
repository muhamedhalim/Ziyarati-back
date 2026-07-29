import { UsageReportService } from './usage-report.service';
import { UsageReportSchedule } from '../../entities/System/UsageReportSchedule';
import { PlatformUsageService } from './platform-usage.service';
import { EmailService } from '../email/email.service';
import { QueueService } from '../../queue/queue.service';
import { createMockRepository, createMockQueryBuilder, MockRepository, MockQueryBuilder } from '../../../test/utils/mock-factories';

describe('UsageReportService.runSchedule — atomic claim, retry-after-failure (gap-closure pass, §0.8.6)', () => {
  let service: UsageReportService;
  let schedules: MockRepository;
  let qb: MockQueryBuilder;
  let platformUsage: { summary: jest.Mock; executiveInsights: jest.Mock };
  let email: { sendDoctorNotification: jest.Mock };

  const schedule = {
    id: 's1',
    name: 'Weekly',
    frequency: 'WEEKLY',
    delivery: 'EMAIL',
    target: 'admin@x.com',
    sections: null,
  } as unknown as UsageReportSchedule;

  beforeEach(() => {
    schedules = createMockRepository();
    qb = createMockQueryBuilder();
    (schedules.createQueryBuilder as jest.Mock).mockReturnValue(qb);
    schedules.findOne.mockResolvedValue(schedule);

    platformUsage = {
      summary: jest.fn().mockResolvedValue({ periodMonth: '2026-07', totals: {}, alerts: [], insights: [] }),
      executiveInsights: jest.fn().mockResolvedValue(null),
    };
    email = { sendDoctorNotification: jest.fn().mockResolvedValue(undefined) };

    service = new UsageReportService(
      schedules as never,
      platformUsage as unknown as PlatformUsageService,
      email as unknown as EmailService,
      {} as unknown as QueueService,
    );
  });

  it('runs and delivers when the claim succeeds', async () => {
    (qb.execute as jest.Mock).mockResolvedValueOnce({ affected: 1 });

    const res = await service.runSchedule('s1');

    expect(email.sendDoctorNotification).toHaveBeenCalled();
    expect(res.status).toBe('SENT');
  });

  it('passes a BUSINESS-PROCESS idempotency key (schedule id + claimed-run timestamp), never the rendered digest text', async () => {
    (qb.execute as jest.Mock).mockResolvedValueOnce({ affected: 1 });

    await service.runSchedule('s1');

    const call = email.sendDoctorNotification.mock.calls[0][0];
    expect(call.idempotencyKey).toMatch(/^usage-report:s1:.+/);
  });

  it('skips the run entirely when the claim fails — a concurrent tick/manual-run race for the SAME instant', async () => {
    (qb.execute as jest.Mock).mockResolvedValueOnce({ affected: 0 });

    const res = await service.runSchedule('s1');

    expect(email.sendDoctorNotification).not.toHaveBeenCalled();
    expect(res.status).toBe('SKIPPED: already run very recently (concurrent tick/manual-run race)');
  });

  it('the claim UPDATE bypasses the short window entirely when the last attempt FAILED — a manual retry must never be blocked', async () => {
    (qb.execute as jest.Mock).mockResolvedValueOnce({ affected: 1 });

    await service.runSchedule('s1');

    expect(qb.where).toHaveBeenCalledWith(
      expect.stringContaining("last_status LIKE 'FAILED%'"),
      expect.objectContaining({ id: 's1' }),
    );
  });

  it('records a FAILED status (not re-thrown) and does not block delivery from completing the report attempt', async () => {
    (qb.execute as jest.Mock).mockResolvedValueOnce({ affected: 1 });
    email.sendDoctorNotification.mockRejectedValueOnce(new Error('smtp down'));

    const res = await service.runSchedule('s1');

    expect(res.status).toMatch(/^FAILED: smtp down/);
    expect(schedules.update).toHaveBeenCalledWith('s1', expect.objectContaining({ last_status: expect.stringMatching(/^FAILED/) }));
  });
});

describe('UsageReportService.deliver — per-recipient idempotency within a run (gap-closure pass, §0.11)', () => {
  let service: UsageReportService;
  let schedules: MockRepository;
  let qb: MockQueryBuilder;
  let platformUsage: { summary: jest.Mock; executiveInsights: jest.Mock };
  let email: { sendDoctorNotification: jest.Mock };

  const multiSchedule = {
    id: 's1',
    name: 'Weekly',
    frequency: 'WEEKLY',
    delivery: 'EMAIL',
    target: 'a@x.com, b@x.com, c@x.com',
    sections: null,
    last_run_recipient_status: null,
  } as unknown as UsageReportSchedule;

  beforeEach(() => {
    schedules = createMockRepository();
    qb = createMockQueryBuilder();
    (schedules.createQueryBuilder as jest.Mock).mockReturnValue(qb);
    (qb.execute as jest.Mock).mockResolvedValue({ affected: 1 });
    schedules.findOne.mockResolvedValue(multiSchedule);

    platformUsage = {
      summary: jest.fn().mockResolvedValue({ periodMonth: '2026-07', totals: {}, alerts: [], insights: [] }),
      executiveInsights: jest.fn().mockResolvedValue(null),
    };
    email = { sendDoctorNotification: jest.fn().mockResolvedValue(undefined) };

    service = new UsageReportService(
      schedules as never,
      platformUsage as unknown as PlatformUsageService,
      email as unknown as EmailService,
      {} as unknown as QueueService,
    );
  });

  it('sends to every comma-separated recipient with a per-recipient business key', async () => {
    await service.runSchedule('s1');

    expect(email.sendDoctorNotification).toHaveBeenCalledTimes(3);
    const keys = email.sendDoctorNotification.mock.calls.map((c) => c[0].idempotencyKey);
    expect(keys[0]).toMatch(/^usage-report:s1:.+:a@x\.com$/);
    expect(keys[1]).toMatch(/^usage-report:s1:.+:b@x\.com$/);
    expect(keys[2]).toMatch(/^usage-report:s1:.+:c@x\.com$/);
  });

  it('persists last_run_recipient_status to the DB after EACH recipient succeeds, not only at the end', async () => {
    await service.runSchedule('s1');

    // One incremental write per recipient, each a superset of the last —
    // this is what survives a hard crash between recipients.
    expect(schedules.update).toHaveBeenCalledWith('s1', { last_run_recipient_status: { 'a@x.com': 'SENT' } });
    expect(schedules.update).toHaveBeenCalledWith('s1', { last_run_recipient_status: { 'a@x.com': 'SENT', 'b@x.com': 'SENT' } });
  });

  it('resets last_run_recipient_status to {} once the whole run succeeds, ready for the next due cycle', async () => {
    await service.runSchedule('s1');

    expect(schedules.update).toHaveBeenCalledWith('s1', { last_run_recipient_status: {} });
  });

  it('skips recipients already marked SENT from a prior interrupted attempt at the SAME cycle, and does not reset progress on failure', async () => {
    schedules.findOne.mockResolvedValueOnce({
      ...multiSchedule,
      last_run_recipient_status: { 'a@x.com': 'SENT' }, // process crashed after recipient #1 last time
    });
    email.sendDoctorNotification.mockRejectedValueOnce(new Error('smtp down')); // fails on b@x.com this time

    const res = await service.runSchedule('s1');

    expect(email.sendDoctorNotification).toHaveBeenCalledTimes(1); // only b@x.com attempted — a@x.com skipped
    expect(email.sendDoctorNotification).toHaveBeenCalledWith(expect.objectContaining({ to: 'b@x.com' }));
    expect(res.status).toMatch(/^FAILED: smtp down/);
    // The {} reset only happens on FULL success — must NOT fire here.
    expect(schedules.update).not.toHaveBeenCalledWith('s1', { last_run_recipient_status: {} });
  });
});
