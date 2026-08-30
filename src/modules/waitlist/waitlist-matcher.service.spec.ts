import {
  MATCH_OFFER_TOP_N,
  WaitlistMatcherService,
} from './waitlist-matcher.service';
import { WaitlistState } from '../../entities/enums';
import { AvailabilityService } from '../scheduling/availability.service';

describe('WaitlistMatcherService (T157)', () => {
  const slot = {
    branchId: 'b1',
    staffId: 's1',
    serviceIds: ['svc1'],
    startAt: new Date('2031-01-01T09:00:00.000Z'),
    endAt: new Date('2031-01-01T10:00:00.000Z'),
  };

  const build = (pool: any[]) => {
    const entries: any = {
      find: jest.fn().mockResolvedValue(pool),
    };
    const availability = {
      assertBookable: jest.fn().mockResolvedValue(undefined),
    };
    const matcher = new WaitlistMatcherService(
      entries,
      availability as unknown as AvailabilityService,
    );
    return { matcher, entries, availability };
  };

  it('queries a BOUNDED pool (tenant + service + WAITING, ordered priority desc/created_at asc, take capped)', async () => {
    const { matcher, entries } = build([]);
    await matcher.findEligibleEntries('t1', slot);
    expect(entries.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenant: { id: 't1' },
          state: WaitlistState.WAITING,
        }),
        order: { priority: 'DESC', created_at: 'ASC' },
        take: expect.any(Number),
      }),
    );
  });

  it('excludes a candidate whose preferred_branch/staff does not match the freed slot', async () => {
    const pool = [
      { id: 'e1', preferred_branch: { id: 'OTHER' }, preferred_staff: null },
      { id: 'e2', preferred_branch: null, preferred_staff: { id: 'OTHER' } },
      { id: 'e3', preferred_branch: null, preferred_staff: null },
    ];
    const { matcher } = build(pool);
    const result = await matcher.findEligibleEntries('t1', slot);
    expect(result.map((e) => e.id)).toEqual(['e3']);
  });

  it('excludes a candidate whose preferred window does not cover the freed slot', async () => {
    const pool = [
      {
        id: 'too-early',
        window_start: null,
        window_end: new Date('2030-12-31T00:00:00.000Z'), // before slot.startAt
        preferred_branch: null,
        preferred_staff: null,
      },
      {
        id: 'too-late',
        window_start: new Date('2031-02-01T00:00:00.000Z'), // after slot.startAt
        window_end: null,
        preferred_branch: null,
        preferred_staff: null,
      },
      {
        id: 'in-window',
        window_start: new Date('2031-01-01T00:00:00.000Z'),
        window_end: new Date('2031-01-31T00:00:00.000Z'),
        preferred_branch: null,
        preferred_staff: null,
      },
    ];
    const { matcher } = build(pool);
    const result = await matcher.findEligibleEntries('t1', slot);
    expect(result.map((e) => e.id)).toEqual(['in-window']);
  });

  it('caps matches at MATCH_OFFER_TOP_N even with a larger eligible pool', async () => {
    const pool = Array.from({ length: MATCH_OFFER_TOP_N + 5 }, (_, i) => ({
      id: `e${i}`,
      preferred_branch: null,
      preferred_staff: null,
    }));
    const { matcher } = build(pool);
    const result = await matcher.findEligibleEntries('t1', slot);
    expect(result).toHaveLength(MATCH_OFFER_TOP_N);
  });

  it('FR-W006 — offers nothing when the slot is no longer genuinely bookable at the moment of offer', async () => {
    const pool = [{ id: 'e1', preferred_branch: null, preferred_staff: null }];
    const { matcher, availability } = build(pool);
    availability.assertBookable.mockRejectedValue(new Error('not bookable'));

    const result = await matcher.findEligibleEntries('t1', slot);

    expect(result).toEqual([]);
    expect(availability.assertBookable).toHaveBeenCalledWith(
      't1',
      slot.branchId,
      slot.staffId,
      slot.startAt,
      slot.endAt,
    );
  });

  it('returns [] immediately for an appointment with no services, never querying the pool', async () => {
    const { matcher, entries } = build([]);
    const result = await matcher.findEligibleEntries('t1', {
      ...slot,
      serviceIds: [],
    });
    expect(result).toEqual([]);
    expect(entries.find).not.toHaveBeenCalled();
  });
});
