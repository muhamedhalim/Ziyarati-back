import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ReopenTicketDto } from './reopen-ticket.dto';

describe('ReopenTicketDto validation', () => {
  it('accepts an empty payload — note is optional', async () => {
    const dto = plainToInstance(ReopenTicketDto, {});
    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts a note', async () => {
    const dto = plainToInstance(ReopenTicketDto, {
      note: 'Still seeing the bug.',
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a note over 2000 characters', async () => {
    const dto = plainToInstance(ReopenTicketDto, { note: 'x'.repeat(2001) });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'note')).toBe(true);
  });

  // The reopen transition target is hardcoded server-side — this DTO must
  // never accept status/resolvedAt/closedAt from the client.
  it('strips a spoofed status/resolvedAt/closedAt under the app-wide whitelist config', async () => {
    const dto = plainToInstance(ReopenTicketDto, {
      status: 'open',
      resolvedAt: null,
      closedAt: null,
    });
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.some((e) => e.property === 'status')).toBe(true);
    expect(errors.some((e) => e.property === 'resolvedAt')).toBe(true);
    expect(errors.some((e) => e.property === 'closedAt')).toBe(true);
  });
});
