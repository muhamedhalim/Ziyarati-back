import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { NotificationVariableResolver } from './notification-variable-resolver.service';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const CUSTOMER = { id: 'cust-1', full_name: 'Sara  Al-Harbi' };

const template = (over: Record<string, unknown> = {}) => ({
  language: 'en_US',
  components: {
    components: [
      {
        type: 'BODY',
        text: 'Hello {{1}}, your visit with {{2}} is on {{3}} at {{4}}.',
      },
    ],
  },
  variable_mapping: {
    '1': 'patient_name',
    '2': 'doctor_name',
    '3': 'appointment_date',
    '4': 'appointment_time',
  } as Record<string, string> | null,
  ...over,
});

describe('NotificationVariableResolver', () => {
  let resolver: NotificationVariableResolver;
  let appointments: MockRepository;
  let tenants: MockRepository;

  // 2026-10-11 14:30 UTC == 17:30 Riyadh (UTC+3, no DST)
  const appointment = (over: Record<string, unknown> = {}) => ({
    id: 'appt-1',
    start_at: new Date('2026-10-11T14:30:00Z'),
    booked_timezone: 'Asia/Riyadh',
    branch: { name: 'Olaya Branch', timezone: 'Asia/Riyadh' },
    staff: { user: { full_name: 'Dr. Ahmed' } },
    customer: { id: 'cust-1' },
    ...over,
  });

  beforeEach(async () => {
    appointments = createMockRepository();
    tenants = createMockRepository();
    tenants.findOne.mockResolvedValue({ id: TENANT, name: 'Noor Clinic' });
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationVariableResolver,
        { provide: getRepositoryToken(Appointment), useValue: appointments },
        { provide: getRepositoryToken(Tenant), useValue: tenants },
      ],
    }).compile();
    resolver = moduleRef.get(NotificationVariableResolver);
  });

  it('maps each placeholder to its trusted source, in the template’s own numbering', async () => {
    appointments.findOne.mockResolvedValueOnce(appointment());

    const res = await resolver.resolve(TENANT, template() as any, {
      customer: CUSTOMER as any,
      appointmentId: 'appt-1',
      supplied: {},
    });

    expect(res.unresolved).toEqual([]);
    expect(res.variables['1']).toBe('Sara Al-Harbi'); // whitespace normalised
    expect(res.variables['2']).toBe('Dr. Ahmed');
    expect(res.variables['3']).toMatch(/Sunday/);
    expect(res.variables['3']).toMatch(/11 October 2026/);
    // 17:30 local, not 14:30 UTC.
    expect(String(res.variables['4'])).toMatch(/5:30/);
    expect(String(res.variables['4']).toLowerCase()).toContain('pm');
  });

  it('loads the appointment tenant-scoped', async () => {
    appointments.findOne.mockResolvedValueOnce(appointment());
    await resolver.resolve(TENANT, template() as any, {
      customer: CUSTOMER as any,
      appointmentId: 'appt-1',
      supplied: {},
    });
    expect(appointments.findOne.mock.calls[0][0].where).toEqual({
      id: 'appt-1',
      tenant: { id: TENANT },
    });
    expect(tenants.findOne).not.toHaveBeenCalled(); // not needed → not loaded
  });

  it('uses the Gregorian calendar and Latin digits for an Arabic template', async () => {
    appointments.findOne.mockResolvedValueOnce(appointment());
    const res = await resolver.resolve(
      TENANT,
      template({ language: 'ar' }) as any,
      {
        customer: CUSTOMER as any,
        appointmentId: 'appt-1',
        supplied: {},
      },
    );
    const date = String(res.variables['3']);
    expect(date).toMatch(/2026/); // Gregorian year, not 1448 (Hijri)
    expect(date).not.toMatch(/[٠-٩]/);
  });

  it('REFUSES to expose another patient’s appointment through this recipient', async () => {
    appointments.findOne.mockResolvedValueOnce(
      appointment({ customer: { id: 'someone-else' } }),
    );

    const res = await resolver.resolve(TENANT, template() as any, {
      customer: CUSTOMER as any,
      appointmentId: 'appt-1',
      supplied: {},
    });

    // Name is still resolvable (it is the recipient's own); booking data is not.
    expect(res.variables['1']).toBe('Sara Al-Harbi');
    expect(res.unresolved.map((u) => u.placeholder).sort()).toEqual([
      '2',
      '3',
      '4',
    ]);
    expect(JSON.stringify(res.variables)).not.toContain('Dr. Ahmed');
  });

  it('reports a placeholder as unresolved instead of sending a blank', async () => {
    appointments.findOne.mockResolvedValueOnce(
      appointment({ staff: { user: { full_name: '  ' } } }),
    );
    const res = await resolver.resolve(TENANT, template() as any, {
      customer: CUSTOMER as any,
      appointmentId: 'appt-1',
      supplied: {},
    });
    expect(res.unresolved).toEqual([
      { placeholder: '2', source: 'doctor_name' },
    ]);
  });

  it('with no appointment, appointment-bound placeholders are unresolved', async () => {
    const res = await resolver.resolve(TENANT, template() as any, {
      customer: CUSTOMER as any,
      supplied: {},
    });
    expect(appointments.findOne).not.toHaveBeenCalled();
    expect(res.unresolved.map((u) => u.placeholder)).toEqual(['2', '3', '4']);
  });

  it('fills the clinic name from the tenant row and the links from the per-message variables', async () => {
    const res = await resolver.resolve(
      TENANT,
      template({
        components: {
          components: [
            {
              type: 'BODY',
              text: 'From {{1}}: cancel {{2}} or move {{3}} please.',
            },
          ],
        },
        variable_mapping: {
          '1': 'clinic_name',
          '2': 'cancel_url',
          '3': 'reschedule_url',
        },
      }) as any,
      {
        customer: CUSTOMER as any,
        supplied: {
          cancelUrl: 'https://app/appointment-action/AAA',
          rescheduleUrl: 'https://app/appointment-action/BBB',
        },
      },
    );
    expect(res.unresolved).toEqual([]);
    expect(res.variables).toMatchObject({
      '1': 'Noor Clinic',
      '2': 'https://app/appointment-action/AAA',
      '3': 'https://app/appointment-action/BBB',
    });
    expect(tenants.findOne.mock.calls[0][0].where).toEqual({ id: TENANT });
  });

  it('a placeholder with no binding may only be filled by a value already supplied', async () => {
    const res = await resolver.resolve(
      TENANT,
      template({
        components: {
          components: [
            { type: 'BODY', text: 'Code {{1}} for {{2}} at the clinic.' },
          ],
        },
        variable_mapping: null,
      }) as any,
      { customer: CUSTOMER as any, supplied: { '1': 'ABC' } },
    );
    expect(res.variables['1']).toBe('ABC');
    expect(res.unresolved).toEqual([{ placeholder: '2' }]);
  });

  it('ignores a mapping to an unknown source (never reads arbitrary fields)', async () => {
    const res = await resolver.resolve(
      TENANT,
      template({
        components: {
          components: [
            { type: 'BODY', text: 'ID {{1}} is on file with the clinic.' },
          ],
        },
        variable_mapping: { '1': 'customer.national_id' },
      }) as any,
      {
        customer: { ...CUSTOMER, national_id: '1234567890' } as any,
        supplied: {},
      },
    );
    expect(res.unresolved).toEqual([
      { placeholder: '1', source: 'customer.national_id' },
    ]);
    expect(JSON.stringify(res.variables)).not.toContain('1234567890');
  });

  it('a template with no placeholders needs nothing', async () => {
    const res = await resolver.resolve(
      TENANT,
      template({
        components: {
          components: [
            { type: 'BODY', text: 'Your appointment is confirmed.' },
          ],
        },
        variable_mapping: null,
      }) as any,
      { customer: CUSTOMER as any, supplied: {} },
    );
    expect(res).toEqual({ variables: {}, unresolved: [] });
  });

  describe('library template sources', () => {
    // Synthetic sentinel (not a credential): the spec asserts it never leaks into resolved variables.
    const SECRET = 'Ab3dEfGh1jKlMnOpQrStUvWxYz0123456789_-aBcD'; // gitleaks:allow
    const confirmation = (over: Record<string, unknown> = {}) =>
      ({
        language: 'ar',
        components: {
          components: [
            {
              type: 'BODY',
              text: 'مرحباً {{1}}، تم تأكيد موعدك في {{2}} يوم {{3}}.',
            },
            {
              type: 'BUTTONS',
              buttons: [
                {
                  type: 'URL',
                  text: 'تغيير الموعد',
                  url: 'https://app.test/appointment-action/{{1}}',
                },
              ],
            },
          ],
        },
        variable_mapping: {
          '1': 'patient_first_name',
          '2': 'clinic_name',
          '3': 'fixed:الأحد',
          button_0: 'reschedule_token',
        } as Record<string, string>,
        ...over,
      }) as any;

    it('greets by FIRST name only', async () => {
      const res = await resolver.resolve(TENANT, confirmation(), {
        customer: CUSTOMER as any,
        supplied: {
          rescheduleUrl: `https://app.test/appointment-action/${SECRET}`,
        },
      });
      expect(res.variables['1']).toBe('Sara');
      expect(res.variables['2']).toBe('Noor Clinic');
    });

    it('fills a typed constant for a placeholder bound as fixed text', async () => {
      const res = await resolver.resolve(TENANT, confirmation(), {
        customer: CUSTOMER as any,
        supplied: {
          rescheduleUrl: `https://app.test/appointment-action/${SECRET}`,
        },
      });
      expect(res.variables['3']).toBe('الأحد');
      expect(res.unresolved).toEqual([]);
    });

    it('gives the link button ONLY the secret at the end of the issued link', async () => {
      const res = await resolver.resolve(TENANT, confirmation(), {
        customer: CUSTOMER as any,
        supplied: {
          rescheduleUrl: `https://app.test/appointment-action/${SECRET}`,
        },
      });
      expect(res.variables['button_0']).toBe(SECRET);
    });

    it('blocks the send when no link was issued (never a blank or a guessed token)', async () => {
      const res = await resolver.resolve(TENANT, confirmation(), {
        customer: CUSTOMER as any,
        supplied: {},
      });
      expect(res.unresolved).toEqual([
        { placeholder: 'button_0', source: 'reschedule_token' },
      ]);
    });

    it.each([
      ['a different path', 'https://evil.test/other/' + 'a'.repeat(43)],
      ['a too-short token', 'https://app.test/appointment-action/short'],
      [
        'a token followed by a query',
        `https://app.test/appointment-action/${'a'.repeat(43)}?x=1`,
      ],
      ['not a string', 12345],
    ])('refuses to derive a token from %s', async (_label, bad) => {
      const res = await resolver.resolve(TENANT, confirmation(), {
        customer: CUSTOMER as any,
        supplied: { rescheduleUrl: bad },
      });
      expect(res.unresolved.map((u) => u.placeholder)).toContain('button_0');
    });

    it('treats an empty fixed binding as unresolved', async () => {
      const res = await resolver.resolve(
        TENANT,
        confirmation({
          variable_mapping: {
            '1': 'patient_first_name',
            '2': 'clinic_name',
            '3': 'fixed:  ',
            button_0: 'reschedule_token',
          },
        }),
        {
          customer: CUSTOMER as any,
          supplied: {
            rescheduleUrl: `https://app.test/appointment-action/${SECRET}`,
          },
        },
      );
      expect(res.unresolved.map((u) => u.placeholder)).toEqual(['3']);
    });
  });
});
