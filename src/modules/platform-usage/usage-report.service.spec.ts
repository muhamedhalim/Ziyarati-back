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
