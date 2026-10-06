import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { WhatsappAiHoursService } from './whatsapp-ai-hours.service';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { WorkingHour } from '../../entities/Staff/WorkingHour';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

// Sunday 2026-01-04 10:00 in Riyadh.
const AT = new Date('2026-01-04T10:00:00+03:00');
const wh = (branch: string, day: number, s: string, e: string) => ({
  id: `${branch}-${day}`,
  branch: { id: branch },
  day_of_week: day,
  start_time: s,
  end_time: e,
  is_closed: false,
});

describe('WhatsappAiHoursService', () => {
  let svc: WhatsappAiHoursService;
  let hours: MockRepository;
  let branches: MockRepository;

  beforeEach(async () => {
    hours = createMockRepository();
    branches = createMockRepository();
    const m = await Test.createTestingModule({
      providers: [
        WhatsappAiHoursService,
        { provide: getRepositoryToken(WorkingHour), useValue: hours },
        { provide: getRepositoryToken(Branch), useValue: branches },
      ],
    }).compile();
    svc = m.get(WhatsappAiHoursService);
  });

  it('scopes both reads to the tenant, and to active branches', async () => {
    branches.find.mockResolvedValue([{ id: 'b1', timezone: 'Asia/Riyadh' }]);
    hours.find.mockResolvedValue([]);

    await svc.isOpen('t1', null, AT);

    expect(branches.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenant: { id: 't1' },
          is_active: true,
        }),
      }),
    );
    expect(hours.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenant: { id: 't1' } }),
      }),
    );
  });

  it('a given branch is looked up within the tenant, so a foreign branch id finds nothing → not applicable', async () => {
    branches.find.mockResolvedValue([]);

    expect(await svc.isOpen('t1', 'foreign-branch', AT)).toBeNull();
    expect(branches.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'foreign-branch',
          tenant: { id: 't1' },
        }),
      }),
    );
    expect(hours.find).not.toHaveBeenCalled();
  });

  it('whole clinic: open when ANY branch is open', async () => {
    branches.find.mockResolvedValue([
      { id: 'b1', timezone: 'Asia/Riyadh' },
      { id: 'b2', timezone: 'Asia/Riyadh' },
    ]);
    hours.find.mockResolvedValue([
      wh('b1', 0, '18:00', '22:00'), // closed now
      wh('b2', 0, '09:00', '12:00'), // open now
    ]);

    expect(await svc.isOpen('t1', null, AT)).toBe(true);
  });

  it('whole clinic: closed when every configured branch is closed', async () => {
    branches.find.mockResolvedValue([{ id: 'b1', timezone: 'Asia/Riyadh' }]);
    hours.find.mockResolvedValue([wh('b1', 0, '18:00', '22:00')]);

    expect(await svc.isOpen('t1', null, AT)).toBe(false);
  });

  it('a branch with no hours does not count as closed: it is skipped, and with none configured anywhere the answer is null', async () => {
    branches.find.mockResolvedValue([
      { id: 'b1', timezone: 'Asia/Riyadh' },
      { id: 'b2', timezone: 'Asia/Riyadh' },
    ]);
    hours.find.mockResolvedValue([]);
    expect(await svc.isOpen('t1', null, AT)).toBeNull();

    hours.find.mockResolvedValue([wh('b2', 0, '09:00', '12:00')]);
    expect(await svc.isOpen('t1', null, AT)).toBe(true);
  });

  it("uses each branch's own timezone", async () => {
    // 10:00 Riyadh = 07:00 UTC: a UTC branch with a 09:00–12:00 window is still closed.
    branches.find.mockResolvedValue([{ id: 'b1', timezone: 'UTC' }]);
    hours.find.mockResolvedValue([wh('b1', 0, '09:00', '12:00')]);

    expect(await svc.isOpen('t1', 'b1', AT)).toBe(false);
  });

  it('propagates a read failure (the policy turns it into POLICY_READ_FAILED)', async () => {
    branches.find.mockRejectedValue(new Error('db'));
    await expect(svc.isOpen('t1', null, AT)).rejects.toThrow('db');
  });
});
