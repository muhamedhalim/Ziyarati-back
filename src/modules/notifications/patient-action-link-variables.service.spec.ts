import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { PatientActionLinkVariablesService } from './patient-action-link-variables.service';
import { PatientActionLinkService } from '../patient-actions/patient-action-link.service';

const TENANT = 't1';
const appointment = {
  id: 'appt-1',
  start_at: new Date(Date.now() + 48 * 3600_000),
} as never;

describe('PatientActionLinkVariablesService', () => {
  let service: PatientActionLinkVariablesService;
  let links: { issue: jest.Mock };
  let config: { get: jest.Mock };

  beforeEach(async () => {
    links = { issue: jest.fn() };
    config = { get: jest.fn(() => 'https://app.example.test') };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PatientActionLinkVariablesService,
        { provide: PatientActionLinkService, useValue: links },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    service = moduleRef.get(PatientActionLinkVariablesService);
  });

  afterEach(() => jest.clearAllMocks());

  it('issues both a CANCEL and a RESCHEDULE link and builds their URLs', async () => {
    links.issue.mockImplementation((_t, _a, purpose) =>
      Promise.resolve(
        purpose === 'CANCEL' ? 'cancel-secret' : 'reschedule-secret',
      ),
    );
    const vars = await service.buildLinkVariables(TENANT, appointment);
    expect(vars).toEqual({
      cancelUrl: 'https://app.example.test/appointment-action/cancel-secret',
      rescheduleUrl:
        'https://app.example.test/appointment-action/reschedule-secret',
    });
    expect(links.issue).toHaveBeenCalledWith(TENANT, appointment, 'CANCEL');
    expect(links.issue).toHaveBeenCalledWith(TENANT, appointment, 'RESCHEDULE');
  });

  it('a failure issuing ONE link is swallowed — the other still comes through', async () => {
    links.issue.mockImplementation((_t, _a, purpose) =>
      purpose === 'CANCEL'
        ? Promise.reject(new Error('db down'))
        : Promise.resolve('reschedule-secret'),
    );
    const vars = await service.buildLinkVariables(TENANT, appointment);
    expect(vars).toEqual({
      rescheduleUrl:
        'https://app.example.test/appointment-action/reschedule-secret',
    });
  });

  it('a failure issuing BOTH links resolves to an empty object, never throws', async () => {
    links.issue.mockRejectedValue(new Error('db down'));
    await expect(
      service.buildLinkVariables(TENANT, appointment),
    ).resolves.toEqual({});
  });
});
