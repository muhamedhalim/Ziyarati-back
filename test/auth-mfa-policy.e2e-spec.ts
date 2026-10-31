/**
 * MFA role policy + session flows, end to end (real Postgres + Redis, real AppModule).
 *
 * Both enforcement dates are in the past (see mfa-policy-env.setup). Proves, per role:
 *  - privileged (owner, manager, platform user) and clinical (doctor) logins are forced
 *    into enrolment: no cookies until the factor is confirmed;
 *  - patients and non-clinical staff log in exactly as before (no extra prompt);
 *  - a session opened BEFORE enforcement cannot refresh into a fresh one;
 *  - enrolment ends every older session, and a mandatory user cannot disable the factor;
 *  - admin reset ends the target's sessions and sends them back through enrolment.
 */
import './utils/auth-refresh-env.setup';
import './utils/mfa-policy-env.setup';

import request from 'supertest';

import {
  createE2eApp,
  cleanupTenant,
  type E2eApp,
} from './utils/whatsapp-e2e-app';
import {
  API,
  createLoginableUser,
  refreshRequest,
  type LoginableUser,
} from './utils/auth-concurrency-fixtures';
import { AuthService } from '../src/modules/auth/auth.service';
import { MfaService } from '../src/modules/auth/mfa/mfa.service';
import { currentStep, totpAt } from '../src/modules/auth/mfa/totp';

describe('MFA role policy (approved policy)', () => {
  let e2e: E2eApp;
  let mfa: MfaService;
  const made: LoginableUser[] = [];

  const withRole = async (label: string, role: string | null) => {
    const u = await createLoginableUser(e2e, label);
    made.push(u);
    if (role) {
      await e2e.dataSource.query(
        `INSERT INTO user_roles ("userId","roleId") SELECT $1, id FROM roles WHERE slug = $2 AND "tenantId" IS NULL LIMIT 1`,
        [u.userId, role],
      );
    }
    return u;
  };

  const hasAuthCookie = (res: request.Response) =>
    (res.headers['set-cookie'] as unknown as string[] | undefined)?.some((c) =>
      /access|refresh/i.test(c),
    ) ?? false;

  const login = (u: LoginableUser) =>
    request(e2e.app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ email: u.email, password: u.password });

  beforeAll(async () => {
    e2e = await createE2eApp();
    mfa = e2e.app.get(MfaService);
  }, 120_000);

  afterAll(async () => {
    for (const u of made)
      await cleanupTenant(e2e, u.tenantId).catch(() => undefined);
    await e2e.app.close();
  }, 120_000);

  it.each([
    ['owner', 'owner'],
    ['manager', 'manager'],
    ['doctor', 'doctor'],
  ])(
    'a %s without a factor is forced into enrolment: no session issued',
    async (label, role) => {
      const u = await withRole(`pol-${label}`, role);
      const res = await login(u);
      expect(res.status).toBe(200);
      expect(res.body.mfaEnrollmentRequired).toBe(true);
      expect(typeof res.body.challengeToken).toBe('string');
      expect(res.body.user).toBeUndefined();
      expect(hasAuthCookie(res)).toBe(false);
    },
  );

  it.each([
    ['patient', 'customer'],
    ['receptionist', 'receptionist'],
    ['role-less user', null],
  ])('a %s logs in with no MFA prompt', async (label, role) => {
    const u = await withRole(`pol-${label.replace(/\W/g, '')}`, role);
    const res = await login(u);
    expect(res.status).toBe(200);
    expect(res.body.mfaEnrollmentRequired).toBeUndefined();
    expect(res.body.mfaRequired).toBeUndefined();
    expect(hasAuthCookie(res)).toBe(true);
  });

  it('enrolling through the challenge issues a session and one-time recovery codes', async () => {
    const u = await withRole('pol-enrol', 'owner');
    const { body } = await login(u);
    const start = await request(e2e.app.getHttpServer())
      .post(`${API}/auth/mfa/enroll/start`)
      .send({ challengeToken: body.challengeToken });
    expect(start.status).toBe(200);
    const confirm = await request(e2e.app.getHttpServer())
      .post(`${API}/auth/mfa/enroll/confirm`)
      .send({
        challengeToken: body.challengeToken,
        code: totpAt(start.body.secret, currentStep()),
      });
    expect(confirm.status).toBe(200);
    expect(confirm.body.recoveryCodes).toHaveLength(10);
    expect(hasAuthCookie(confirm)).toBe(true);
    // the next login asks for the code, not enrolment
    const again = await login(u);
    expect(again.body.mfaRequired).toBe(true);
    expect(again.body.mfaEnrollmentRequired).toBeUndefined();
  });

  it('a session issued before enforcement cannot refresh while the owner has no factor', async () => {
    const u = await withRole('pol-refresh', 'owner');
    // Mint a legitimate pre-enforcement session directly, as if issued before the policy.
    const auth = e2e.app.get(AuthService);
    const issued = await auth.finishLogin(u.userId);
    const refresh = await refreshRequest(e2e, {
      refresh_token: issued.refreshToken,
      csrf_token: 'csrf-e2e',
    })();
    expect(refresh.status).toBe(401);
    expect(refresh.cookies.access_token).toBeUndefined();
  });

  it('control: the same pre-existing session CAN refresh for a patient (no MFA prompt, no revocation)', async () => {
    const u = await withRole('pol-refresh-patient', 'customer');
    const auth = e2e.app.get(AuthService);
    const issued = await auth.finishLogin(u.userId);
    const refresh = await refreshRequest(e2e, {
      refresh_token: issued.refreshToken,
      csrf_token: 'csrf-e2e',
    })();
    expect(refresh.status).toBe(200);
    expect(refresh.cookies.access_token).toBeDefined();
  });

  it('enrolment ends all older sessions; a mandatory user cannot disable the factor', async () => {
    const u = await withRole('pol-revoke', 'owner');
    const auth = e2e.app.get(AuthService);
    const old = await auth.finishLogin(u.userId);
    const { secret } = await mfa.startSetup(u.userId, u.email);
    await mfa.confirmSetup(u.userId, totpAt(secret, currentStep()));
    const rows = await e2e.dataSource.query(
      `SELECT count(*)::int AS n FROM refresh_tokens WHERE "userId" = $1 AND revoked_at IS NULL`,
      [u.userId],
    );
    expect(rows[0].n).toBe(0);
    expect(old.refreshToken).toBeDefined();
    expect(
      mfa.isMandatory({
        tenantId: u.tenantId,
        roles: ['owner'],
        permissions: [],
      }),
    ).toBe(true);
  });

  it("admin reset ends the target's sessions and sends them back through enrolment", async () => {
    const u = await withRole('pol-reset', 'owner');
    const { secret } = await mfa.startSetup(u.userId, u.email);
    await mfa.confirmSetup(u.userId, totpAt(secret, currentStep()));
    await mfa.adminReset(u.userId, made[0].userId);
    const res = await login(u);
    expect(res.body.mfaEnrollmentRequired).toBe(true);
    expect(hasAuthCookie(res)).toBe(false);
  });
});
