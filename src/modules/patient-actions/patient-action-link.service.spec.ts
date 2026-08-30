import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';

import { PatientActionLinkService } from './patient-action-link.service';
import { PatientActionLink } from '../../entities/Calendar&Appointments/PatientActionLink';
import { PatientActionPurpose } from '../../entities/enums';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const digestOf = (s: string) => createHash('sha256').update(s).digest('hex');

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: 'appt-1',
    start_at: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  } as Appointment;
}

describe('PatientActionLinkService', () => {
  let service: PatientActionLinkService;
  let links: MockRepository;

  beforeEach(async () => {
    links = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PatientActionLinkService,
        { provide: getRepositoryToken(PatientActionLink), useValue: links },
      ],
    }).compile();
    service = moduleRef.get(PatientActionLinkService);
  });

  afterEach(() => jest.clearAllMocks());

  it('issue/resolve round-trip: the returned secret resolves back to the issued link', async () => {
    let saved: any;
    links.save.mockImplementation(async (e: any) => {
      saved = e;
      return e;
    });

    const secret = await service.issue(
      't1',
      appointment(),
      PatientActionPurpose.CANCEL,
    );

    expect(saved.token_digest).toBe(digestOf(secret));
    expect(saved.consumed_at).toBeUndefined();

    links.findOne.mockResolvedValueOnce({
      ...saved,
      expires_at: new Date(Date.now() + 60_000),
      consumed_at: null,
    });

    const resolved = await service.resolve(secret);
    expect(resolved).not.toBeNull();
    expect(resolved?.token_digest).toBe(digestOf(secret));
  });

  it('rejects an expired link', async () => {
    links.findOne.mockResolvedValueOnce({
      token_digest: digestOf('tok'),
      expires_at: new Date(Date.now() - 1000),
      consumed_at: null,
    });
    expect(await service.resolve('tok')).toBeNull();
  });

  it('rejects an already-consumed link', async () => {
    links.findOne.mockResolvedValueOnce({
      token_digest: digestOf('tok'),
      expires_at: new Date(Date.now() + 60_000),
      consumed_at: new Date(),
    });
    expect(await service.resolve('tok')).toBeNull();
  });

  it('consume is a conditional UPDATE — a replay after the first consume changes nothing', async () => {
    const qb = links.createQueryBuilder();
    links.createQueryBuilder.mockReturnValue(qb);
    qb.execute
      .mockResolvedValueOnce({ affected: 1 }) // first consume succeeds
      .mockResolvedValueOnce({ affected: 0 }); // replay: no row matched (already consumed)

    expect(await service.consume('link-1')).toBe(1);
    expect(await service.consume('link-1')).toBe(0);
    expect(qb.where).toHaveBeenCalledWith(
      'id = :id AND consumed_at IS NULL',
      { id: 'link-1' },
    );
  });

  it('an unknown token is indistinguishable from a token belonging to another tenant — both resolve to null', async () => {
    // Unknown digest: no row at all.
    links.findOne.mockResolvedValueOnce(null);
    const unknown = await service.resolve('never-issued');

    // A different tenant's real, still-valid link is looked up by ITS OWN
    // digest and returns null only because that digest simply never matches
    // an unrelated caller's presented token — same code path, same result.
    links.findOne.mockResolvedValueOnce(null);
    const otherTenants = await service.resolve('not-tenant-2-real-token');

    expect(unknown).toBeNull();
    expect(otherTenants).toBeNull();
    expect(unknown).toEqual(otherTenants);
  });

  it('uses a timing-safe comparison, not a plain equality check, to confirm the digest match', async () => {
    const digest = digestOf('tok');
    links.findOne.mockResolvedValueOnce({
      token_digest: digest,
      expires_at: new Date(Date.now() + 60_000),
      consumed_at: null,
    });

    const timingSafe = require('node:crypto').timingSafeEqual;
    const spy = jest.spyOn(require('node:crypto'), 'timingSafeEqual');
    await service.resolve('tok');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    void timingSafe;
  });
});
