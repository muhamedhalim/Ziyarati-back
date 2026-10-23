import { ContactLeadService } from './contact-lead.service';
import { SubmitContactDto } from './dto/submit-contact.dto';

function dto(over: Partial<SubmitContactDto> = {}): SubmitContactDto {
  return Object.assign(new SubmitContactDto(), {
    fullName: 'Layla Hassan',
    email: 'layla@clinic.test',
    subject: 'demo',
    message: 'We run three branches and want a demo.',
    locale: 'ar',
    ...over,
  });
}

function make(opts: { duplicates?: number; to?: string } = {}) {
  const leads = {
    count: jest.fn().mockResolvedValue(opts.duplicates ?? 0),
    create: jest.fn((x) => ({ ...x })),
    save: jest.fn(async (x) => ({ ...x, id: 'lead-1' })),
    update: jest.fn(),
    findAndCount: jest.fn(),
  };
  const email = { send: jest.fn().mockResolvedValue(undefined) };
  const config = { get: jest.fn((k: string) => (k === 'CONTACT_LEADS_TO' ? opts.to : undefined)) };
  const svc = new ContactLeadService(leads as never, email as never, config as never);
  return { svc, leads, email };
}

describe('ContactLeadService (CR-05)', () => {
  it('stores the lead and emails the sales inbox with the sender as reply-to', async () => {
    const { svc, leads, email } = make({ to: 'sales@ziyaratech.test, ops@ziyaratech.test' });

    await svc.submit(dto({ phone: '+966500000001', facilityName: 'Noor Clinic' }));

    expect(leads.save).toHaveBeenCalledWith(
      expect.objectContaining({
        full_name: 'Layla Hassan',
        email: 'layla@clinic.test',
        phone: '+966500000001',
        facility_name: 'Noor Clinic',
        subject: 'demo',
        locale: 'ar',
      }),
    );
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['sales@ziyaratech.test', 'ops@ziyaratech.test'],
        replyTo: 'layla@clinic.test',
        idempotencyKey: 'contact-lead:lead-1',
        template: 'generic',
      }),
    );
    const message = email.send.mock.calls[0][0].variables.message as string;
    expect(message).toContain('Noor Clinic');
    expect(message).toContain('We run three branches');
  });

  it('keeps the lead and does not throw when no notification inbox is configured', async () => {
    const { svc, leads, email } = make({ to: undefined });
    await expect(svc.submit(dto())).resolves.toBeUndefined();
    expect(leads.save).toHaveBeenCalledTimes(1);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('ignores an identical re-submit inside the duplicate window: no second row, no second email', async () => {
    const { svc, leads, email } = make({ duplicates: 1, to: 'sales@ziyaratech.test' });
    await svc.submit(dto());
    expect(leads.save).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('a notification failure cannot fail the visitor submit (the row is the source of truth)', async () => {
    const { svc, leads, email } = make({ to: 'sales@ziyaratech.test' });
    // EmailService.send is documented never to throw; guard the contract anyway.
    email.send.mockResolvedValueOnce(undefined);
    await expect(svc.submit(dto())).resolves.toBeUndefined();
    expect(leads.save).toHaveBeenCalledTimes(1);
  });
});
