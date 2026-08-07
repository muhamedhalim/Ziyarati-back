import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AddTicketReplyDto } from './add-ticket-reply.dto';

describe('AddTicketReplyDto validation', () => {
  it('accepts a valid note', async () => {
    const dto = plainToInstance(AddTicketReplyDto, {
      note: 'Thanks for the report.',
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a missing note', async () => {
    const dto = plainToInstance(AddTicketReplyDto, {});
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'note')).toBe(true);
  });

  it('rejects a note over 2000 characters', async () => {
    const dto = plainToInstance(AddTicketReplyDto, { note: 'x'.repeat(2001) });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'note')).toBe(true);
  });

  // §7.7 — a clinic caller must not be able to forge internal_only/type/actorRole
  // through this DTO; the app-wide whitelist config (main.ts) is the enforcement
  // boundary, this proves the DTO itself declares no such property to smuggle.
  it('strips a spoofed internalOnly/type/actorRole under the app-wide whitelist config', async () => {
    const dto = plainToInstance(AddTicketReplyDto, {
      note: 'Looks fine',
      internalOnly: true,
      type: 'NOTE_ADDED',
      actorRole: 'super_admin',
    });
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.some((e) => e.property === 'internalOnly')).toBe(true);
    expect(errors.some((e) => e.property === 'type')).toBe(true);
    expect(errors.some((e) => e.property === 'actorRole')).toBe(true);
  });
});
