import { HttpStatus } from '@nestjs/common';

import { WaitlistOfferService } from './waitlist-offer.service';
import { WaitlistOfferState, WaitlistState } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

function mockQueryBuilder(affected = 1) {
  const qb: any = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected }),
  };
  return qb;
}

describe('WaitlistOfferService (T158)', () => {
  const build = () => {
    const offers: any = {
      create: jest.fn((x) => x),
      save: jest.fn((x) => Promise.resolve({ id: 'offer-1', ...x })),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => mockQueryBuilder(1)),
    };
    const entries: any = {
      update: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => mockQueryBuilder(1)),
    };
    const appointmentRepo: any = { findOne: jest.fn() };
    const matcher: any = {
      findEligibleEntries: jest.fn().mockResolvedValue([]),
    };
    const appointments: any = { create: jest.fn() };
    const links: any = { issue: jest.fn().mockResolvedValue('secret-token') };
    const botActor: any = {
      ensureBotActor: jest.fn().mockResolvedValue({ id: 'bot-1' }),
    };
    const tenantContext: any = {
      run: jest.fn((fn: () => unknown) => fn()),
      setPrincipal: jest.fn(),
    };

    const svc = new WaitlistOfferService(
      offers,
      entries,
      appointmentRepo,
      matcher,
      appointments,
      links,
      botActor,
      tenantContext,
    );
    return {
      svc,
      offers,
      entries,
      appointmentRepo,
      matcher,
      appointments,
      links,
      botActor,
      tenantContext,
    };
  };

  const pendingOffer = () => ({
    id: 'offer-1',
    entry: {
      id: 'entry-1',
      customer: { id: 'cust-1' },
      service: { id: 'svc-1' },
    },
    branch: { id: 'branch-1' },
    staff: { id: 'staff-1' },
    start_at: new Date('2031-01-01T09:00:00.000Z'),
    end_at: new Date('2031-01-01T10:00:00.000Z'),
    state: WaitlistOfferState.PENDING,
  });

  describe('accept — the exactly-one-appointment guarantee', () => {
    it('gates on a conditional UPDATE BEFORE ever calling AppointmentsService.create; on success, fulfils the entry and withdraws siblings', async () => {
      const { svc, offers, entries, appointments } = build();
      const offerQb = mockQueryBuilder(1); // this request WON the conditional update
      offers.createQueryBuilder.mockReturnValue(offerQb);
      offers.findOne.mockResolvedValue(pendingOffer());
      appointments.create.mockResolvedValue({
        id: 'appt-1',
        start_at: pendingOffer().start_at,
      });

      const result = await svc.accept('t1', 'offer-1');

      // The claim happens BEFORE create() is ever called.
      expect(offerQb.set).toHaveBeenCalledWith({
        state: WaitlistOfferState.ACCEPTED,
      });
      expect(appointments.create).toHaveBeenCalledWith(
        't1',
        'bot-1',
        expect.objectContaining({
          branchId: 'branch-1',
          customerId: 'cust-1',
          staffId: 'staff-1',
          serviceIds: ['svc-1'],
        }),
      );
      expect(offers.update).toHaveBeenCalledWith('offer-1', {
        appointment: { id: 'appt-1' },
      });
      expect(entries.update).toHaveBeenCalledWith('entry-1', {
        state: WaitlistState.FULFILLED,
      });
      expect(result.appointment.id).toBe('appt-1');
    });

    it('the LOSER of the conditional update (0 rows affected) never calls create() — returns 409 with the offer current state immediately', async () => {
      const { svc, offers, appointments } = build();
      const offerQb = mockQueryBuilder(0); // LOST the race
      offers.createQueryBuilder.mockReturnValue(offerQb);
      offers.findOne.mockResolvedValue({
        ...pendingOffer(),
        state: WaitlistOfferState.ACCEPTED,
      });

      await expect(svc.accept('t1', 'offer-1')).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
        publicContext: { state: WaitlistOfferState.ACCEPTED },
      });
      expect(appointments.create).not.toHaveBeenCalled();
    });

    it('FR-W009 — if the WINNER then loses a DIFFERENT race inside create() (slot taken elsewhere), rolls the offer back to WITHDRAWN and the entry back to WAITING', async () => {
      const { svc, offers, entries, appointments } = build();
      offers.createQueryBuilder.mockReturnValue(mockQueryBuilder(1));
      offers.findOne.mockResolvedValue(pendingOffer());
      appointments.create.mockRejectedValue(
        new AppError(ErrorCode.SLOT_ALREADY_BOOKED, {
          status: HttpStatus.CONFLICT,
        }),
      );

      await expect(svc.accept('t1', 'offer-1')).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
        publicContext: { state: WaitlistOfferState.WITHDRAWN },
      });
      expect(offers.update).toHaveBeenCalledWith('offer-1', {
        state: WaitlistOfferState.WITHDRAWN,
      });
      expect(entries.update).toHaveBeenCalledWith('entry-1', {
        state: WaitlistState.WAITING,
      });
    });

    it('a non-conflict failure from create() (e.g. quota exhausted) still reverts the offer/entry but rethrows the ORIGINAL error, not a misleading "someone else booked it" message', async () => {
      const { svc, offers, entries, appointments } = build();
      offers.createQueryBuilder.mockReturnValue(mockQueryBuilder(1));
      offers.findOne.mockResolvedValue(pendingOffer());
      const quotaErr = new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Usage limit reached',
      });
      appointments.create.mockRejectedValue(quotaErr);

      await expect(svc.accept('t1', 'offer-1')).rejects.toBe(quotaErr);
      expect(offers.update).toHaveBeenCalledWith('offer-1', {
        state: WaitlistOfferState.WITHDRAWN,
      });
      expect(entries.update).toHaveBeenCalledWith('entry-1', {
        state: WaitlistState.WAITING,
      });
    });
  });

  describe('decline', () => {
    it('the winner of the conditional update declines cleanly and reverts the entry to WAITING', async () => {
      const { svc, offers, entries } = build();
      offers.createQueryBuilder.mockReturnValue(mockQueryBuilder(1));
      offers.findOne.mockResolvedValue(pendingOffer());
      const entriesQb = mockQueryBuilder(1);
      entries.createQueryBuilder.mockReturnValue(entriesQb);

      const result = await svc.decline('t1', 'offer-1');

      expect(result).toEqual({ state: WaitlistOfferState.DECLINED });
      // Regression guard: a real (non-mocked) repository returns `entry` as
      // `undefined` unless the relation is explicitly requested — a bug an
      // over-permissive mock alone can't catch, only found via the real e2e
      // suite (`test/waitlist-staff-and-token-validity.e2e-spec.ts`).
      expect(offers.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ relations: { entry: true } }),
      );
      expect(entriesQb.set).toHaveBeenCalledWith({
        state: WaitlistState.WAITING,
      });
    });

    it('a not-actionable offer (already terminal) returns 409 with its current state', async () => {
      const { svc, offers } = build();
      offers.createQueryBuilder.mockReturnValue(mockQueryBuilder(0));
      offers.findOne.mockResolvedValue({
        ...pendingOffer(),
        state: WaitlistOfferState.EXPIRED,
      });

      await expect(svc.decline('t1', 'offer-1')).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
        publicContext: { state: WaitlistOfferState.EXPIRED },
      });
    });
  });

  describe('expireDueOffers / evaluateFreedSlot', () => {
    it("expireDueOffers reverts each expired offer's entry OFFERED -> WAITING", async () => {
      const { svc, offers, entries } = build();
      offers.find.mockResolvedValue([
        { id: 'o1', entry: { id: 'e1' }, responds_by: new Date(0) },
      ]);
      const offersQb = mockQueryBuilder(1);
      offers.createQueryBuilder.mockReturnValue(offersQb);
      const entriesQb = mockQueryBuilder(1);
      entries.createQueryBuilder.mockReturnValue(entriesQb);

      const count = await svc.expireDueOffers();

      expect(offersQb.set).toHaveBeenCalledWith({
        state: WaitlistOfferState.EXPIRED,
      });
      expect(entriesQb.set).toHaveBeenCalledWith({
        state: WaitlistState.WAITING,
      });
      expect(count).toBe(1);
    });

    it('evaluateFreedSlot derives the slot from the appointment row when no override is given, and creates offers for each eligible entry', async () => {
      const { svc, appointmentRepo, matcher, entries, offers, links } = build();
      appointmentRepo.findOne.mockResolvedValue({
        id: 'appt-1',
        branch: { id: 'branch-1' },
        staff: { id: 'staff-1' },
        start_at: new Date('2031-01-01T09:00:00.000Z'),
        end_at: new Date('2031-01-01T10:00:00.000Z'),
        services: [{ service: { id: 'svc-1' } }],
      });
      matcher.findEligibleEntries.mockResolvedValue([{ id: 'entry-1' }]);
      entries.createQueryBuilder.mockReturnValue(mockQueryBuilder(1));

      const result = await svc.evaluateFreedSlot('t1', 'appt-1');

      expect(matcher.findEligibleEntries).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({
          branchId: 'branch-1',
          staffId: 'staff-1',
          serviceIds: ['svc-1'],
        }),
      );
      expect(offers.save).toHaveBeenCalled();
      expect(links.issue).toHaveBeenCalled();
      expect(result).toEqual({ offered: 1 });
    });

    it('evaluateFreedSlot returns {offered: 0} without matching when the appointment cannot be found (never throws)', async () => {
      const { svc, appointmentRepo, matcher } = build();
      appointmentRepo.findOne.mockResolvedValue(null);

      const result = await svc.evaluateFreedSlot('t1', 'missing-appt');

      expect(result).toEqual({ offered: 0 });
      expect(matcher.findEligibleEntries).not.toHaveBeenCalled();
    });
  });
});
