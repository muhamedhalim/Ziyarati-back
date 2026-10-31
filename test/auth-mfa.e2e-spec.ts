/**
 * P0.5 / TSF-03 — TOTP second factor, end to end (real Postgres + Redis, real AppModule).
 *
 * Proves: a password alone issues NO session for an enrolled user; a wrong code
 * fails; a right code issues cookies; a spent code cannot be replayed; and a
 * verify-challenge cannot be used where an enrolment challenge is required.
 */
import './utils/auth-refresh-env.setup';

import request from 'supertest';

import {
  createE2eApp,
  cleanupTenant,
  type E2eApp,
} from './utils/whatsapp-e2e-app';
import {
  API,
  createLoginableUser,
  type LoginableUser,
} from './utils/auth-concurrency-fixtures';
import { MfaService } from '../src/modules/auth/mfa/mfa.service';
import { currentStep, totpAt } from '../src/modules/auth/mfa/totp';

describe('MFA login (P0.5)', () => {
  let e2e: E2eApp;
  let user: LoginableUser;
  let plain: LoginableUser;
  let secret: string;
  let mfa: MfaService;

  const hasAuthCookie = (res: request.Response) =>
    (res.headers['set-cookie'] as unknown as string[] | undefined)?.some((c) =>
      /access|refresh/i.test(c),
    ) ?? false;

  beforeAll(async () => {
    e2e = await createE2eApp();
    mfa = e2e.app.get(MfaService);
    user = await createLoginableUser(e2e, 'mfa');
    plain = await createLoginableUser(e2e, 'nomfa');
    const s = await mfa.startSetup(user.userId, user.email);
    secret = s.secret;
    await mfa.confirmSetup(user.userId, totpAt(secret, currentStep()));
  }, 120_000);

  afterAll(async () => {
    await cleanupTenant(e2e, user.tenantId).catch(() => undefined);
    await cleanupTenant(e2e, plain.tenantId).catch(() => undefined);
    await e2e.app.close();
  }, 120_000);

  const login = (u: LoginableUser) =>
    request(e2e.app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ email: u.email, password: u.password });

  it('a user WITHOUT MFA still logs in normally', async () => {
    const res = await login(plain);
    expect(res.status).toBe(200);
    expect(res.body.user?.id).toBe(plain.userId);
    expect(hasAuthCookie(res)).toBe(true);
  });

  it('password alone for an enrolled user returns a challenge and NO session', async () => {
    const res = await login(user);
    expect(res.status).toBe(200);
    expect(res.body.mfaRequired).toBe(true);
    expect(typeof res.body.challengeToken).toBe('string');
    expect(res.body.user).toBeUndefined();
    expect(hasAuthCookie(res)).toBe(false);
  });

  it('wrong code is refused with no cookies; correct NEXT-step code logs in; replay is refused', async () => {
    const { body } = await login(user);
    const bad = await request(e2e.app.getHttpServer())
      .post(`${API}/auth/mfa/verify`)
      .send({ challengeToken: body.challengeToken, code: '000000' });
    expect(bad.status).toBe(401);
    expect(hasAuthCookie(bad)).toBe(false);

    const code = totpAt(secret, currentStep() + 1);
    const ok = await request(e2e.app.getHttpServer())
      .post(`${API}/auth/mfa/verify`)
      .send({ challengeToken: body.challengeToken, code });
    expect(ok.status).toBe(200);
    expect(ok.body.user?.id).toBe(user.userId);
    expect(hasAuthCookie(ok)).toBe(true);

    const replay = await request(e2e.app.getHttpServer())
      .post(`${API}/auth/mfa/verify`)
      .send({ challengeToken: body.challengeToken, code });
    expect(replay.status).toBe(401);
  });

  it('a verify challenge is useless at the enrolment endpoints, and garbage is refused', async () => {
    const { body } = await login(user);
    const wrongPurpose = await request(e2e.app.getHttpServer())
      .post(`${API}/auth/mfa/enroll/start`)
      .send({ challengeToken: body.challengeToken });
    expect(wrongPurpose.status).toBe(401);
    const garbage = await request(e2e.app.getHttpServer())
      .post(`${API}/auth/mfa/verify`)
      .send({ challengeToken: 'not-a-token', code: '123456' });
    expect(garbage.status).toBe(401);
  });

  it('the challenge token is not accepted as an access token', async () => {
    const { body } = await login(user);
    const me = await request(e2e.app.getHttpServer())
      .get(`${API}/auth/me`)
      .set('Authorization', `Bearer ${body.challengeToken}`);
    expect(me.status).toBe(401);
  });
});
