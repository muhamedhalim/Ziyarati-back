import { CANARY } from '../../test/utils/log-canaries';
import { seedAdminUser } from './admin.seed';
import { logger } from './seed.logger';

jest.mock('bcrypt', () => ({ hash: jest.fn().mockResolvedValue('hash') }));

/**
 * LSA-12: CLI/seed output (the migrate task runs without the structured
 * logger) must not carry the super-admin address or other shaped identifiers.
 * Synthetic values only.
 */
describe('seed / CLI logging (LSA-12)', () => {
  const printed: string[] = [];
  const env = { ...process.env };

  beforeEach(() => {
    printed.length = 0;
    for (const m of ['log', 'warn', 'error'] as const) {
      jest
        .spyOn(console, m)
        .mockImplementation(
          (...a: unknown[]) => void printed.push(a.map(String).join(' ')),
        );
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...env };
  });

  function manager(existing: boolean) {
    const repo = {
      findOne: jest
        .fn()
        .mockImplementation(({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(
            where.slug ? { id: 'role-1' } : existing ? { id: 'u-1' } : null,
          ),
        ),
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: object) => Promise.resolve({ id: 'u-1', ...x })),
    };
    return { getRepository: () => repo } as never;
  }

  it.each([false, true])(
    'never prints the admin e-mail (existing=%p)',
    async (existing) => {
      process.env.NODE_ENV = 'production';
      process.env.ADMIN_EMAIL = CANARY.email;
      process.env.ADMIN_PASSWORD = 'synthetic-password-1';
      await seedAdminUser(manager(existing));
      const out = printed.join('\n');
      expect(out).toMatch(/Super admin (created successfully|already exists)/);
      expect(out).not.toContain(CANARY.email);
      expect(out).not.toContain('synthetic-password-1');
    },
  );

  it('the console fallback is shape-scrubbed, and a raw error object is never dumped', () => {
    logger.info(`contact ${CANARY.email} / ${CANARY.phoneIntl}`);
    logger.error('failed', {
      to: CANARY.phoneAscii,
      body: CANARY.clinicalNote,
    });
    logger.error('failed again', new Error(`dup key ${CANARY.nationalId}`));
    const out = printed.join('\n');
    for (const v of [
      CANARY.email,
      CANARY.phoneIntl,
      CANARY.phoneAscii,
      CANARY.nationalId,
      CANARY.clinicalNote,
    ]) {
      expect(out).not.toContain(v);
    }
  });
});
