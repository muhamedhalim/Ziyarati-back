import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreatePaymentDto } from './create-payment.dto';
import { GenerateSettlementDto } from './generate-settlement.dto';

/** FIN-007 — currency is an allow-listed, normalised ISO code. */
describe('payment currency validation (FIN-007)', () => {
  const check = async (cls: any, currency: unknown, extra = {}) => {
    const dto = plainToInstance(cls, { amount: 10, currency, ...extra });
    const errors = await validate(dto as object);
    return { dto: dto as { currency?: string }, errors };
  };

  it('rejects an unknown code', async () => {
    const { errors } = await check(CreatePaymentDto, 'XYZ');
    expect(errors.some((e) => e.property === 'currency')).toBe(true);
  });

  it('normalises lower-case to upper-case and accepts it', async () => {
    const { dto, errors } = await check(CreatePaymentDto, ' usd ');
    expect(errors.filter((e) => e.property === 'currency')).toHaveLength(0);
    expect(dto.currency).toBe('USD');
  });

  it('applies to settlement generation too', async () => {
    const { errors } = await check(GenerateSettlementDto, 'ZZZ', {
      from: '2026-01-01',
      to: '2026-01-31',
    });
    expect(errors.some((e) => e.property === 'currency')).toBe(true);
  });
});
