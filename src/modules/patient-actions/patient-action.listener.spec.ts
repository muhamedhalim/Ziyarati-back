import { Test, TestingModule } from '@nestjs/testing';

import { PatientActionListener } from './patient-action.listener';
import { PatientActionLinkService } from './patient-action-link.service';

describe('PatientActionListener (T033, S1, FR-C003)', () => {
  let listener: PatientActionListener;
  let links: { invalidateFor: jest.Mock };

  beforeEach(async () => {
    links = { invalidateFor: jest.fn().mockResolvedValue(undefined) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PatientActionListener,
        { provide: PatientActionLinkService, useValue: links },
      ],
    }).compile();
    listener = moduleRef.get(PatientActionListener);
  });

  afterEach(() => jest.clearAllMocks());

  it('invalidates links on AppointmentCancelledEvent', async () => {
    await listener.onAppointmentCancelled({ appointmentId: 'appt-1' } as never);
    expect(links.invalidateFor).toHaveBeenCalledWith('appt-1');
  });

  it('invalidates links on AppointmentCompletedEvent', async () => {
    await listener.onAppointmentCompleted({ appointmentId: 'appt-2' } as never);
    expect(links.invalidateFor).toHaveBeenCalledWith('appt-2');
  });

  it('invalidates links on AppointmentNoShowEvent', async () => {
    await listener.onAppointmentNoShow({ appointmentId: 'appt-3' } as never);
    expect(links.invalidateFor).toHaveBeenCalledWith('appt-3');
  });

  it('a replay (invalidateFor called twice for the same appointment) is safe — no throw', async () => {
    await listener.onAppointmentCancelled({ appointmentId: 'appt-1' } as never);
    await listener.onAppointmentCancelled({ appointmentId: 'appt-1' } as never);
    expect(links.invalidateFor).toHaveBeenCalledTimes(2);
  });

  it('a failure invalidating links is logged and swallowed, never thrown', async () => {
    links.invalidateFor.mockRejectedValueOnce(new Error('db down'));
    await expect(
      listener.onAppointmentCancelled({ appointmentId: 'appt-1' } as never),
    ).resolves.toBeUndefined();
  });
});
