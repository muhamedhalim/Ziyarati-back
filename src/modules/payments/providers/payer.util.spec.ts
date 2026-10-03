import { buildPayer, parsePhone, realEmail } from './payer.util';

describe('payer.util', () => {
  describe('realEmail', () => {
    it('keeps a real address', () => {
      expect(realEmail(' sara@example.com ')).toBe('sara@example.com');
    });
    it.each([
      ['whatsapp+t1-966501234567@bot.internal'], // WhatsApp placeholder (customers.email is NOT NULL)
      ['x@y.invalid'],
      ['not-an-email'],
      [''],
      [null],
      [undefined],
    ])('treats %p as "no real email"', (e) => {
      expect(realEmail(e as any)).toBeUndefined();
    });
  });

  describe('parsePhone — only when the country is unambiguous', () => {
    it.each([
      ['966501234567', '966', '501234567'],
      ['+966 50 123 4567', '966', '501234567'],
      ['00966501234567', '966', '501234567'],
      ['0501234567', '966', '501234567'], // Saudi national format
    ])('%s → +%s %s', (raw, cc, number) => {
      expect(parsePhone(raw)).toEqual({ countryCode: cc, number });
    });

    it.each([
      ['201001234567'], // Egypt: would need a real country-code table to split safely
      ['4915123456789'],
      ['12345'],
      [''],
      [null],
      [undefined],
    ])('refuses to guess for %p', (raw) => {
      expect(parsePhone(raw as any)).toBeUndefined();
    });
  });

  describe('buildPayer', () => {
    it('splits first / last name and normalises contact data', () => {
      expect(
        buildPayer({
          name: '  Amina  Hassan   Ali ',
          email: 'amina@example.com',
          phone: '0501234567',
          fallbackFirstName: 'Patient',
        }),
      ).toEqual({
        firstName: 'Amina',
        lastName: 'Hassan Ali',
        email: 'amina@example.com',
        phone: { countryCode: '966', number: '501234567' },
      });
    });

    it('uses a neutral label — not an invented identity — when no name is stored', () => {
      const p = buildPayer({
        name: null,
        email: null,
        phone: null,
        fallbackFirstName: 'Patient',
      });
      expect(p.firstName).toBe('Patient');
      expect(p.lastName).toBeUndefined();
      expect(p.email).toBeUndefined();
      expect(p.phone).toBeUndefined();
    });

    it('a single-word name has no last name', () => {
      expect(
        buildPayer({ name: 'Layla', fallbackFirstName: 'x' }).lastName,
      ).toBeUndefined();
    });
  });
});
