import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { PHONE_PATTERN, phoneDigits } from './phone.util';
import { CreateCustomerDto } from '../../modules/crm/dto/create-customer.dto';
import { UpdateCustomerDto } from '../../modules/crm/dto/update-customer.dto';
import { CreateStaffWithNewUserDto } from '../../modules/staff/dto/create-staff-with-new-user.dto';
import { ConfirmBookingDto } from '../../modules/public-booking/dto/public-booking.dto';

/** CRM-PHONE-01 — the formats real records already use pass; non-numbers do not. */
const ACCEPTED = [
  '0500000000', // national, Saudi front desk
  '+966500000000', // E.164
  '+966 50 000 0000',
  '00966500000000',
  '966500000000', // WhatsApp id: digits only
  '050-000-0000',
  '(050) 000.0000',
  '+44 20 7946 0958',
  '1234567', // 7 digits — short national numbers exist
];
const REFUSED = [
  'not-a-phone',
  'abc0500000000',
  '05000000xx',
  '123456', // too few digits
  '1234567890123456', // 16 digits — above E.164's 15
  '+',
  '50+0000000',
  '',
  '   ',
  '<script>alert(1)</script>',
];

describe('PHONE_PATTERN (CRM-PHONE-01)', () => {
  it.each(ACCEPTED)('accepts %p', (phone) => {
    expect(PHONE_PATTERN.test(phone)).toBe(true);
  });

  it.each(REFUSED)('refuses %p', (phone) => {
    expect(PHONE_PATTERN.test(phone)).toBe(false);
  });

  it('reduces any spelling of a number to its digits for comparison', () => {
    expect(phoneDigits('+966 (50) 000-0000')).toBe('966500000000');
    expect(phoneDigits(null)).toBe('');
  });
});

describe('the rule is enforced on every person-phone the API accepts', () => {
  const phoneErrors = async (
    cls: new () => object,
    body: Record<string, unknown>,
  ) => {
    const errors = await validate(plainToInstance(cls, body));
    return errors.filter((e) => e.property === 'phone');
  };

  it('patient create (staff "Add patient" and Excel import) and patient edit', async () => {
    expect(
      await phoneErrors(CreateCustomerDto, { phone: 'not-a-phone' }),
    ).toHaveLength(1);
    expect(
      await phoneErrors(CreateCustomerDto, { phone: '+966 50 000 0000' }),
    ).toHaveLength(0);
    expect(
      await phoneErrors(UpdateCustomerDto, { phone: 'not-a-phone' }),
    ).toHaveLength(1);
    // Partial update: leaving the phone out is still fine.
    expect(await phoneErrors(UpdateCustomerDto, {})).toHaveLength(0);
  });

  it('staff provisioning (phone optional, but a number when given)', async () => {
    expect(
      await phoneErrors(CreateStaffWithNewUserDto, { phone: 'call me' }),
    ).toHaveLength(1);
    expect(await phoneErrors(CreateStaffWithNewUserDto, {})).toHaveLength(0);
  });

  it('public booking confirmation', async () => {
    expect(
      await phoneErrors(ConfirmBookingDto, { phone: 'abcd' }),
    ).toHaveLength(1);
    expect(
      await phoneErrors(ConfirmBookingDto, { phone: '0500000000' }),
    ).toHaveLength(0);
  });
});
