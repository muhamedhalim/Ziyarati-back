import type { GatewayPayer } from './payment-gateway.provider.interface';

/**
 * Internal placeholder addresses (e.g. `whatsapp+{tenant}-{waId}@bot.internal`)
 * exist only to satisfy `customers.email NOT NULL` for WhatsApp patients. They
 * are not real mailboxes and must never be presented to a gateway as one.
 */
const PLACEHOLDER_EMAIL = /@(bot\.internal|[^@]+\.invalid)$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function realEmail(
  email: string | null | undefined,
): string | undefined {
  const e = String(email ?? '').trim();
  return EMAIL.test(e) && !PLACEHOLDER_EMAIL.test(e) ? e : undefined;
}

/**
 * Splits a stored phone into `{countryCode, number}` ONLY when the country is
 * unambiguous: an international Saudi number (966…) or a Saudi national number
 * (05…). Anything else returns undefined — a guessed country-code split would
 * hand a gateway a wrong number, which is worse than sending none.
 */
export function parsePhone(
  raw: string | null | undefined,
): { countryCode: string; number: string } | undefined {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);

  if (digits.startsWith('966') && digits.length === 12) {
    return { countryCode: '966', number: digits.slice(3) };
  }
  if (digits.startsWith('0') && digits.length === 10) {
    return { countryCode: '966', number: digits.slice(1) };
  }
  return undefined;
}

/**
 * Builds the payer a gateway needs from what we hold. `fallbackFirstName` is a
 * neutral label for patients stored without a name — a gateway requires a
 * non-empty first name, but we never invent an identity beyond that label.
 */
export function buildPayer(input: {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  fallbackFirstName: string;
}): GatewayPayer {
  const parts = String(input.name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const [first, ...rest] = parts;
  return {
    firstName: first ?? input.fallbackFirstName,
    lastName: rest.length ? rest.join(' ') : undefined,
    email: realEmail(input.email),
    phone: parsePhone(input.phone),
  };
}
