import * as bcrypt from 'bcrypt';

import { MfaService } from './mfa.service';
import { currentStep, totpAt } from './totp';

/** In-memory fakes: the logic under test is replay, lockout, recovery and the challenge boundary. */
function build() {
  const rows: any[] = [];
  const recov: any[] = [];
  const mfaRepo: any = {
    findOne: jest.fn(async ({ where }: any) => rows.find((r) => r.user_id === where.user_id) ?? null),
    create: (x: any) => ({ id: `m${rows.length + 1}`, failed_attempts: 0, locked_until: null, last_used_step: null, enabled: false, ...x }),
    save: jest.fn(async (x: any) => { rows.push(x); return x; }),
    update: jest.fn(async (w: any, v: any) => { Object.assign(rows.find((r) => r.id === w.id) ?? {}, v); }),
    delete: jest.fn(async (w: any) => { const i = rows.findIndex((r) => r.user_id === w.user_id); if (i >= 0) rows.splice(i, 1); }),
    createQueryBuilder: () => {
      let set: any; let params: any;
      const qb: any = {
        update: () => qb, set: (s: any) => { set = s; return qb; },
        where: (_: string, p: any) => { params = p; return qb; },
        execute: async () => {
          const r = rows.find((x) => x.id === params.id);
          if (r && (r.last_used_step === null || Number(r.last_used_step) < params.step)) { Object.assign(r, set); return { affected: 1 }; }
          return { affected: 0 };
        },
      };
      return qb;
    },
  };
  const recovRepo: any = {
    find: jest.fn(async ({ where }: any) => recov.filter((r) => r.user_id === where.user_id)),
    create: (x: any) => ({ id: `r${recov.length + 1}`, used_at: null, ...x }),
    save: jest.fn(async (x: any) => { recov.push(x); return x; }),
    delete: jest.fn(async (w: any) => { for (let i = recov.length - 1; i >= 0; i--) if (recov[i].user_id === w.user_id) recov.splice(i, 1); }),
    createQueryBuilder: () => {
      let params: any;
      const qb: any = { update: () => qb, set: () => qb, where: (_: string, p: any) => { params = p; return qb; },
        execute: async () => { const r = recov.find((x) => x.id === params.id && !x.used_at); if (r) { r.used_at = new Date(); return { affected: 1 }; } return { affected: 0 }; } };
      return qb;
    },
  };
  const audit: any = { create: (x: any) => x, save: jest.fn() };
  const crypto: any = { encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.replace(/^enc:/, '') };
  const jwtStore = new Map<string, any>();
  const jwt: any = {
    signAsync: jest.fn(async (p: any) => { const t = `tok${jwtStore.size}`; jwtStore.set(t, p); return t; }),
    verifyAsync: jest.fn(async (t: string) => { if (!jwtStore.has(t)) throw new Error('bad'); return jwtStore.get(t); }),
  };
  const config: any = { get: jest.fn(), getOrThrow: () => 'secret' };
  const svc = new MfaService(mfaRepo, recovRepo, audit, crypto, jwt, config);
  return { svc, rows, recov, audit, config };
}

describe('MfaService', () => {
  it('enrols, rejects replay of the same code, and locks after 5 failures', async () => {
    const { svc, rows } = build();
    const { secret } = await svc.startSetup('u1', 'a@b.c');
    const step = currentStep();
    const codes = await svc.confirmSetup('u1', totpAt(secret, step));
    expect(codes).toHaveLength(10);
    expect(rows[0].enabled).toBe(true);
    // the enrolment code's step is spent: replay refused
    await expect(svc.verify('u1', { code: totpAt(secret, step) })).rejects.toThrow();
    // a later step is accepted
    await svc.verify('u1', { code: totpAt(secret, step + 1) });
    for (let i = 0; i < 5; i++) await expect(svc.verify('u1', { code: '000000' })).rejects.toThrow();
    await expect(svc.verify('u1', { code: totpAt(secret, step + 1) })).rejects.toThrow(/Too many/);
  });

  it('recovery codes work once and are stored hashed', async () => {
    const { svc, recov } = build();
    const { secret } = await svc.startSetup('u2', 'a@b.c');
    const codes = await svc.confirmSetup('u2', totpAt(secret, currentStep()));
    expect(recov.every((r) => r.code_hash.startsWith('$2'))).toBe(true);
    expect(JSON.stringify(recov)).not.toContain(codes[0]);
    await svc.verify('u2', { recoveryCode: codes[0] });
    await expect(svc.verify('u2', { recoveryCode: codes[0] })).rejects.toThrow();
  });

  it('a verify challenge cannot be used as an enrolment challenge', async () => {
    const { svc } = build();
    const t = await svc.issueChallenge('u3', 'mfa_verify');
    await expect(svc.parseChallenge(t, 'mfa_enroll')).rejects.toThrow();
    await expect(svc.parseChallenge(t, 'mfa_verify')).resolves.toBe('u3');
    await expect(svc.parseChallenge('garbage', 'mfa_verify')).rejects.toThrow();
  });

  it('enforcement only applies to platform users after MFA_ENFORCE_FROM', async () => {
    const { svc, config } = build();
    expect(await svc.enrolmentRequired('p1', null)).toBe(false); // unset
    config.get.mockReturnValue('2000-01-01');
    expect(await svc.enrolmentRequired('p1', null)).toBe(true);
    expect(await svc.enrolmentRequired('c1', 'tenant-1')).toBe(false); // clinic user
    config.get.mockReturnValue('2999-01-01');
    expect(await svc.enrolmentRequired('p1', null)).toBe(false);
  });

  it('admin cannot reset their own factor; a reset is audited', async () => {
    const { svc, audit } = build();
    await expect(svc.adminReset('a', 'a')).rejects.toThrow();
    await svc.adminReset('t', 'actor');
    expect(audit.save).toHaveBeenCalled();
  });

  it('unused import guard', () => { expect(bcrypt).toBeDefined(); });
});
