import { Logger } from '@nestjs/common';

import {
  CONTACT_TURN_LOCK_TIMINGS,
  ContactTurnBusyError,
  ContactTurnLockService,
} from './contact-turn-lock.service';

const TENANT = 't1';
const WA_ID = '966500000000';

describe('ContactTurnLockService', () => {
  let locks: { acquire: jest.Mock; release: jest.Mock; renew: jest.Mock };
  let service: ContactTurnLockService;

  beforeEach(() => {
    locks = {
      acquire: jest.fn().mockResolvedValue('tok'),
      release: jest.fn().mockResolvedValue(undefined),
      renew: jest.fn().mockResolvedValue(true),
    };
    service = new ContactTurnLockService(locks as never);
    // Small timings so the real timers used below stay fast.
    service.timings = { ttlMs: 1000, renewMs: 15, waitMs: 60, pollMs: 5 };
  });

  afterEach(() => jest.restoreAllMocks());

  it('has production timings that leave room to renew: renew well under ttl, and a bounded wait', () => {
    expect(CONTACT_TURN_LOCK_TIMINGS.renewMs).toBeLessThan(
      CONTACT_TURN_LOCK_TIMINGS.ttlMs / 2,
    );
    expect(CONTACT_TURN_LOCK_TIMINGS.waitMs).toBeLessThan(
      CONTACT_TURN_LOCK_TIMINGS.ttlMs,
    );
  });

  it('runs the turn while holding the lock and releases it afterwards', async () => {
    const order: string[] = [];
    locks.acquire.mockImplementation(async () => {
      order.push('acquire');
      return 'tok';
    });
    locks.release.mockImplementation(async () => {
      order.push('release');
    });

    const result = await service.run(TENANT, WA_ID, async () => {
      order.push('turn');
      return 'done';
    });

    expect(result).toBe('done');
    expect(order).toEqual(['acquire', 'turn', 'release']);
    expect(locks.release).toHaveBeenCalledWith(expect.any(String), 'tok');
  });

  it('tells the turn it did not have to wait when the lock was free', async () => {
    const fn = jest.fn().mockResolvedValue(undefined);

    await service.run(TENANT, WA_ID, fn);

    expect(fn).toHaveBeenCalledWith({ waited: false });
  });

  it('queues behind another turn and then runs, telling it that it waited', async () => {
    locks.acquire
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('tok');
    const fn = jest.fn().mockResolvedValue('ok');

    await service.run(TENANT, WA_ID, fn);

    expect(locks.acquire).toHaveBeenCalledTimes(3);
    expect(fn).toHaveBeenCalledWith({ waited: true });
  });

  it('gives up after the wait window with ContactTurnBusyError — runs nothing and releases nothing', async () => {
    locks.acquire.mockResolvedValue(null);
    const fn = jest.fn();

    await expect(service.run(TENANT, WA_ID, fn)).rejects.toBeInstanceOf(
      ContactTurnBusyError,
    );

    expect(fn).not.toHaveBeenCalled();
    expect(locks.release).not.toHaveBeenCalled();
  });

  it('releases the lock even when the turn throws, and rethrows the original error', async () => {
    const boom = new Error('model exploded');

    await expect(
      service.run(TENANT, WA_ID, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(locks.release).toHaveBeenCalledTimes(1);
  });

  it('keeps renewing the lock while a slow turn runs, and stops once it is done', async () => {
    await service.run(
      TENANT,
      WA_ID,
      () => new Promise((r) => setTimeout(r, 80)),
    );
    const renewalsDuringTurn = locks.renew.mock.calls.length;

    expect(renewalsDuringTurn).toBeGreaterThanOrEqual(2);
    expect(locks.renew).toHaveBeenCalledWith(expect.any(String), 'tok', 1000);

    await new Promise((r) => setTimeout(r, 50));
    expect(locks.renew.mock.calls.length).toBe(renewalsDuringTurn);
  });

  it('warns once — and keeps going — when the lock is lost mid-turn', async () => {
    locks.renew.mockResolvedValue(false);
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const result = await service.run(TENANT, WA_ID, async () => {
      await new Promise((r) => setTimeout(r, 80));
      return 'finished';
    });

    expect(result).toBe('finished');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('lost');
  });

  describe('the key', () => {
    const keyOf = async (tenant: string, wa: string) => {
      await service.run(tenant, wa, async () => undefined);
      return locks.acquire.mock.calls[
        locks.acquire.mock.calls.length - 1
      ][0] as string;
    };

    it('never contains the phone number', async () => {
      expect(await keyOf(TENANT, WA_ID)).not.toContain(WA_ID);
    });

    it('is stable for a contact, and different per contact and per clinic', async () => {
      const a = await keyOf(TENANT, WA_ID);
      expect(await keyOf(TENANT, WA_ID)).toBe(a);
      expect(await keyOf(TENANT, '966500000001')).not.toBe(a);
      expect(await keyOf('t2', WA_ID)).not.toBe(a);
    });

    it('is scoped to the clinic — the same number at two clinics is two contacts', async () => {
      expect(await keyOf(TENANT, WA_ID)).toContain(`:${TENANT}:`);
    });
  });
});
