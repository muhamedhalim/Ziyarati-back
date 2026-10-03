import { sanitizeTapCharge, sanitizeTapRefund } from './tap-redaction';
import type { TapCharge, TapRefund } from './tap.types';

const richCharge = (): TapCharge => ({
  id: 'chg_1',
  object: 'charge',
  live_mode: false,
  status: 'CAPTURED',
  amount: 49.99,
  currency: 'SAR',
  customer_initiated: true,
  threeDSecure: true,
  save_card: false,
  description: 'Consultation',
  metadata: { udf1: 'pay-1', udf2: 'payment', udf3: 't1' },
  reference: {
    transaction: 'pay-1',
    order: 'appt-1',
    gateway: 'GW',
    payment: 'PAY',
  },
  response: { code: '000', message: 'Captured' },
  security: { threeDSecure: { id: '3ds_1', status: 'Y' } },
  transaction: {
    created: '1744036133441',
    url: 'https://checkout.payments.tap.company?mode=page&token=SESSIONTOKEN',
    timezone: 'UTC+03:00',
    expiry: { period: 30, type: 'MINUTE' },
    amount: 49.99,
    currency: 'SAR',
  },
  source: {
    id: 'src_sa.mada',
    object: 'source',
    type: 'CARD_NOT_PRESENT',
    payment_method: 'MADA',
    channel: 'INTERNET',
    payment_type: 'DEBIT',
  },
  card: {
    id: 'card_SAVED1',
    first_six: '446404',
    first_eight: '44640400',
    last_four: '0007',
    scheme: 'MADA',
    brand: 'MADA',
  },
  customer: {
    id: 'cus_1',
    first_name: 'Amina',
    email: 'amina@example.test',
    phone: { country_code: 966, number: 501234567 },
  },
  receipt: { email: true, sms: true, id: 'rcpt_1' },
  merchant: { id: 'merchant_1' },
  post: { status: 'SUCCESS', url: 'https://api.test/hook', attempt: 1 },
  redirect: { status: 'PENDING', url: 'https://app.test/pay/return' },
  activities: [{ id: 'act_1', status: 'INITIATED' }],
  payment_agreement: {
    id: 'payment_agreement_1',
    type: 'UNSCHEDULED',
    contract: { customer_id: 'cus_1' },
  },
});

describe('sanitizeTapCharge (allow-list before persisting to the tenant-readable ledger)', () => {
  const out = sanitizeTapCharge(richCharge());
  const text = JSON.stringify(out);

  it('keeps what reconciliation and support need', () => {
    expect(out).toMatchObject({
      id: 'chg_1',
      status: 'CAPTURED',
      amount: 49.99,
      currency: 'SAR',
      reference: {
        transaction: 'pay-1',
        order: 'appt-1',
        gateway: 'GW',
        payment: 'PAY',
      },
      response: { code: '000', message: 'Captured' },
      metadata: { udf1: 'pay-1' },
      source: { payment_method: 'MADA' },
      card: { last_four: '0007', scheme: 'MADA', brand: 'MADA' },
      merchant: { id: 'merchant_1' },
      customer: { id: 'cus_1' },
      security: { threeDSecure: { status: 'Y' } },
      transaction: { created: '1744036133441' },
    });
  });

  it('drops card BIN digits and the saved-card id', () => {
    expect(text).not.toContain('446404');
    expect(text).not.toContain('first_six');
    expect(text).not.toContain('first_eight');
    expect(text).not.toContain('card_SAVED1');
  });

  it('drops payer PII (name, email, phone) — only the customer id survives', () => {
    expect(out.customer).toEqual({ id: 'cus_1' });
    expect(text).not.toContain('amina@example.test');
    expect(text).not.toContain('501234567');
    expect(text).not.toContain('Amina');
  });

  it('drops the hosted-checkout URL (it carries a session token), receipts and activities', () => {
    expect(text).not.toContain('SESSIONTOKEN');
    expect(out.transaction).not.toHaveProperty('url');
    expect(out).not.toHaveProperty('receipt');
    expect(out).not.toHaveProperty('activities');
    expect(text).not.toContain('rcpt_1');
  });

  it('a field Tap adds tomorrow is excluded by default, not leaked by default', () => {
    const o = sanitizeTapCharge({
      ...richCharge(),
      brand_new_secret_field: 'leak-me',
    } as any);
    expect(JSON.stringify(o)).not.toContain('leak-me');
  });

  it('does not mutate its input', () => {
    const c = richCharge();
    sanitizeTapCharge(c);
    expect(c.card?.first_six).toBe('446404');
    expect(c.customer?.email).toBe('amina@example.test');
  });

  it('omits absent fields instead of emitting undefined keys', () => {
    const o = sanitizeTapCharge({ id: 'chg_2', status: 'FAILED' });
    expect(Object.keys(o).sort()).toEqual(['id', 'status']);
  });
});

describe('sanitizeTapRefund', () => {
  it('keeps the refund facts and nothing else', () => {
    const refund: TapRefund = {
      id: 're_1',
      object: 'refund',
      status: 'REFUNDED',
      amount: 10,
      currency: 'SAR',
      charge_id: 'chg_1',
      created: '1744040000000',
      reference: { gateway: 'RGW', payment: 'RPAY' },
      response: { code: '000', message: 'Refunded' },
      wallet: { debit: 'secret-wallet-detail' },
    };
    const out = sanitizeTapRefund(refund);
    expect(out).toMatchObject({
      id: 're_1',
      status: 'REFUNDED',
      charge_id: 'chg_1',
      amount: 10,
    });
    expect(JSON.stringify(out)).not.toContain('secret-wallet-detail');
  });
});
