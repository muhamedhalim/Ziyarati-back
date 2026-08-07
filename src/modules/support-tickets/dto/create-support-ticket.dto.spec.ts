import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateSupportTicketDto } from './create-support-ticket.dto';

const VALID = {
  subject: 'Cannot load appointment calendar',
  category: 'technical',
  priority: 'medium',
  description: 'The calendar view has been blank since this morning.',
};

async function errorsFor(overrides: Record<string, unknown>) {
  const dto = plainToInstance(CreateSupportTicketDto, { ...VALID, ...overrides });
  return validate(dto);
}

describe('CreateSupportTicketDto validation', () => {
  it('accepts a fully valid payload', async () => {
    const errors = await errorsFor({});
    expect(errors).toHaveLength(0);
  });

  it('rejects an invalid category', async () => {
    const errors = await errorsFor({ category: 'billing' });
    expect(errors.some((e) => e.property === 'category')).toBe(true);
  });

  it('rejects an invalid priority', async () => {
    const errors = await errorsFor({ priority: 'critical' });
    expect(errors.some((e) => e.property === 'priority')).toBe(true);
  });

  it('rejects a subject over 200 characters', async () => {
    const errors = await errorsFor({ subject: 'x'.repeat(201) });
    expect(errors.some((e) => e.property === 'subject')).toBe(true);
  });

  it('rejects a description under the minimum length', async () => {
    const errors = await errorsFor({ description: 'too short' });
    expect(errors.some((e) => e.property === 'description')).toBe(true);
  });

  it('rejects a missing subject', async () => {
    const dto = plainToInstance(CreateSupportTicketDto, { ...VALID, subject: undefined });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'subject')).toBe(true);
  });

  it('rejects a spoofed tenantId under the app-wide whitelist/forbidNonWhitelisted config (main.ts)', async () => {
    // The DTO itself has no `tenantId` property — this asserts the global
    // ValidationPipe (whitelist: true, forbidNonWhitelisted: true) would reject
    // any request body that tries to smuggle one in, which is the actual
    // enforcement boundary for "tenant never comes from the request".
    const dto = plainToInstance(CreateSupportTicketDto, { ...VALID, tenantId: 'spoofed' });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.some((e) => e.property === 'tenantId')).toBe(true);
  });

  it('accepts a payload without preferredContactTime — it is optional', async () => {
    const errors = await errorsFor({});
    expect(errors.some((e) => e.property === 'preferredContactTime')).toBe(false);
  });

  it('accepts a valid ISO-8601 preferredContactTime', async () => {
    const errors = await errorsFor({ preferredContactTime: '2026-08-10T09:30:00.000Z' });
    expect(errors.some((e) => e.property === 'preferredContactTime')).toBe(false);
  });

  it('rejects a preferredContactTime that is not a valid ISO-8601 string', async () => {
    const errors = await errorsFor({ preferredContactTime: 'next Tuesday afternoon' });
    expect(errors.some((e) => e.property === 'preferredContactTime')).toBe(true);
  });

  it('rejects a spoofed status/resolvedAt/closedAt under the app-wide whitelist config — lifecycle timestamps are never client-settable', async () => {
    const dto = plainToInstance(CreateSupportTicketDto, {
      ...VALID,
      status: 'resolved',
      resolvedAt: '2026-01-01T00:00:00.000Z',
      closedAt: '2026-01-01T00:00:00.000Z',
    });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.some((e) => e.property === 'status')).toBe(true);
    expect(errors.some((e) => e.property === 'resolvedAt')).toBe(true);
    expect(errors.some((e) => e.property === 'closedAt')).toBe(true);
  });
});
