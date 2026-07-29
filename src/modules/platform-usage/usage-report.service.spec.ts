import { UsageReportService } from './usage-report.service';
import { UsageReportSchedule } from '../../entities/System/UsageReportSchedule';
import { PlatformUsageService } from './platform-usage.service';
import { EmailService } from '../email/email.service';
import { QueueService } from '../../queue/queue.service';
import { createMockRepository, createMockQueryBuilder, MockRepository, MockQueryBuilder } from '../../../test/utils/mock-factories';

describe('UsageReportService.runSchedule — atomic per-minute claim (gap-closure pass, §0.8.11)', () => {
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

  it('runs and delivers when the claim succeeds (this call wins the minute bucket)', async () => {
    (qb.execute as jest.Mock).mockResolvedValueOnce({ affected: 1 });

    const res = await service.runSchedule('s1');

    expect(email.sendDoctorNotification).toHaveBeenCalled();
    expect(res.status).toBe('SENT');
  });

  it('skips the run entirely when the claim fails — a concurrent tick/manual-run race for the SAME minute, protecting the "run now" endpoint from double-sending', async () => {
    (qb.execute as jest.Mock).mockResolvedValueOnce({ affected: 0 });

    const res = await service.runSchedule('s1');

    expect(email.sendDoctorNotification).not.toHaveBeenCalled();
    expect(res.status).toBe('SKIPPED: already run for this minute');
  });

  it('the claim UPDATE only matches a row whose last_run_at is null or before this minute bucket', async () => {
    (qb.execute as jest.Mock).mockResolvedValueOnce({ affected: 1 });

    await service.runSchedule('s1');

    expect(qb.where).toHaveBeenCalledWith(
      expect.stringContaining('last_run_at IS NULL OR last_run_at < :bucketStart'),
      expect.objectContaining({ id: 's1' }),
    );
  });
});
