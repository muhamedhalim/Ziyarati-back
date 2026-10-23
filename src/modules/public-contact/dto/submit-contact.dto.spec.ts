import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { SubmitContactDto } from './submit-contact.dto';

const valid = {
  fullName: '  Layla Hassan ',
  email: '  Layla@Clinic.TEST ',
  subject: 'pricing',
  message: '  I would like pricing for 3 branches.  ',
  locale: 'en',
};

async function check(body: Record<string, unknown>) {
  const dto = plainToInstance(SubmitContactDto, body);
  return { dto, errors: await validate(dto, { whitelist: true, forbidNonWhitelisted: true }) };
}

describe('SubmitContactDto (CR-05)', () => {
  it('accepts a valid enquiry and normalises whitespace / email case', async () => {
    const { dto, errors } = await check({ ...valid, phone: '', facilityName: '   ' });
    expect(errors).toHaveLength(0);
    expect(dto.fullName).toBe('Layla Hassan');
    expect(dto.email).toBe('layla@clinic.test');
    expect(dto.message).toBe('I would like pricing for 3 branches.');
    // Blank optionals are dropped, exactly as the web form's trimmed payload does.
    expect(dto.phone).toBeUndefined();
    expect(dto.facilityName).toBeUndefined();
  });

  it.each([
    ['empty name', { fullName: '   ' }],
    ['bad email', { email: 'not-an-email' }],
    ['unknown subject', { subject: 'spam' }],
    ['short message', { message: 'too short' }],
    ['huge message', { message: 'x'.repeat(2001) }],
    ['long phone', { phone: '1'.repeat(21) }],
    ['unsupported locale', { locale: 'fr' }],
    ['array injected as a field', { fullName: ['a'] }],
  ])('rejects %s', async (_name, patch) => {
    const { errors } = await check({ ...valid, ...patch });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects unknown properties (mass-assignment of e.g. status)', async () => {
    const { errors } = await check({ ...valid, status: 'handled' });
    expect(errors.length).toBeGreaterThan(0);
  });
});
