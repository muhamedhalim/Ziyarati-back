/**
 * Shared harness for the authentication concurrency / garbage-collection audit
 * (`auth-concurrency.e2e-spec.ts`, `auth-token-gc.e2e-spec.ts`).
 *
 * AUDIT-ONLY. Nothing here changes production behaviour — it only drives the
 * real `AppModule` over real HTTP against the real Postgres + Redis that
 * `createE2eApp()` already boots, and reads back the server-side state
 * (`refresh_tokens` rows, Redis keys) the audit's verdicts depend on.
 *
 * Why a dedicated file rather than inlining in each spec: the concurrency
 * barrier below is the load-bearing part of the whole audit. `Promise.all` over
 * supertest builders is NOT a barrier — each builder does its own async setup
 * before a socket is opened, so "concurrent" requests can serialise by accident
 * and a race that genuinely exists in production silently fails to reproduce.
 * Every race test in this audit therefore goes through {@link fireTogether},
 * and that primitive is defined exactly once.
 */
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

import { type E2eApp } from './whatsapp-e2e-app';
import { Tenant } from '../../src/entities/SaaS-Core/Tenant';
import { User } from '../../src/entities/Auth&RBAC/User';
import { TenantApprovalStatus } from '../../src/entities/enums';
import { AppRedisService } from '../../src/queue/app-redis.service';
import { cacheKeyPrefix } from '../../src/queue/queue.constants';

export const API = '/api/v1';

/** Cost factor 4 — these fixtures exercise concurrency, not bcrypt's strength. */
const TEST_BCRYPT_ROUNDS = 4;

// ------------------------------ concurrency barrier ------------------------ //

/**
 * TRUE synchronisation barrier.
 *
 * Every task is parked on the same unresolved promise, the event loop is then
 * given full turns so each one has definitely reached that await, and only then
 * is the gate released — so all N requests leave the starting line inside the
 * same microtask drain rather than whenever their own setup happens to finish.
 *
 * Returns settled results (never rejects) because several audit scenarios
 * legitimately expect some participants to fail — the DISTRIBUTION of outcomes
 * is the measurement, so one rejection must not discard the others.
 */
export async function fireTogether<T>(
  tasks: Array<() => Promise<T>>,
): Promise<Array<PromiseSettledResult<T>>> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const runs = tasks.map(async (task) => {
    await gate;
    return task();
  });

  // Two macrotask turns: enough for every `runs` entry to have been scheduled
  // and to be sitting on `await gate` before anything is released.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  release();

  return Promise.allSettled(runs);
}

/** Unwraps `fireTogether` results, throwing on any unexpected rejection. */
export function settledValues<T>(results: Array<PromiseSettledResult<T>>): T[] {
  return results.map((r) => {
    if (r.status === 'rejected') {
      throw new Error(`concurrent request rejected: ${String(r.reason)}`);
    }
    return r.value;
  });
}

/**
 * Re-runs a race-sensitive scenario `times` times and returns every round's
 * result. A single round proves nothing about a race: one lucky interleaving
 * can look either safe or broken. The audit reports the distribution.
 */
export async function repeatRace<T>(
  times: number,
  round: (index: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < times; i += 1) {
    results.push(await round(i));
  }
  return results;
}

// --------------------------------- cookie jar ------------------------------ //

export interface AuthCookies {
  access_token?: string;
  refresh_token?: string;
  csrf_token?: string;
}

/** Parses supertest's `set-cookie` header array into name -> value. */
export function readCookies(res: {
  headers: Record<string, unknown>;
}): AuthCookies {
  const raw = res.headers['set-cookie'];
  const list: string[] = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const jar: AuthCookies = {};
  for (const entry of list) {
    const [pair] = entry.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (
      name === 'access_token' ||
      name === 'refresh_token' ||
      name === 'csrf_token'
    ) {
      // An empty value is a `clearCookie` — record it as absent, which is
      // exactly what it means to a browser.
      jar[name] = value === '' ? undefined : decodeURIComponent(value);
    }
  }
  return jar;
}

/** Serialises a jar into a `Cookie` request header. */
export function cookieHeader(jar: AuthCookies): string {
  return Object.entries(jar)
    .filter(([, v]) => typeof v === 'string' && v.length > 0)
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join('; ');
}

/**
 * `/auth/refresh` and `/auth/logout` are NOT `@SkipCsrf()`, and a browser does
 * attach the auth cookies to them — so `CsrfGuard` demands the double-submit
 * header. Every refresh/logout call in this audit must carry it, or it 403s
 * before reaching any of the logic under test.
 */
export function authHeaders(jar: AuthCookies): Record<string, string> {
  const headers: Record<string, string> = { Cookie: cookieHeader(jar) };
  if (jar.csrf_token) headers['X-CSRF-Token'] = jar.csrf_token;
  return headers;
}

// -------------------------------- HTTP actions ----------------------------- //

export interface AuthCall {
  status: number;
  body: Record<string, unknown>;
  cookies: AuthCookies;
}

export function loginRequest(
  e2e: E2eApp,
  email: string,
  password: string,
): () => Promise<AuthCall> {
  return async () => {
    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ email, password });
    return { status: res.status, body: res.body, cookies: readCookies(res) };
  };
}

export function refreshRequest(
  e2e: E2eApp,
  jar: AuthCookies,
): () => Promise<AuthCall> {
  return async () => {
    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/auth/refresh`)
      .set(authHeaders(jar));
    return { status: res.status, body: res.body, cookies: readCookies(res) };
  };
}

export function logoutRequest(
  e2e: E2eApp,
  jar: AuthCookies,
): () => Promise<AuthCall> {
  return async () => {
    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/auth/logout`)
      .set(authHeaders(jar));
    return { status: res.status, body: res.body, cookies: readCookies(res) };
  };
}

export function logoutAllRequest(
  e2e: E2eApp,
  jar: AuthCookies,
): () => Promise<AuthCall> {
  return async () => {
    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/auth/logout-all`)
      .set(authHeaders(jar));
    return { status: res.status, body: res.body, cookies: readCookies(res) };
  };
}

export function meRequest(
  e2e: E2eApp,
  jar: AuthCookies,
): () => Promise<AuthCall> {
  return async () => {
    const res = await request(e2e.app.getHttpServer())
      .get(`${API}/auth/me`)
      .set({ Cookie: cookieHeader(jar) });
    return { status: res.status, body: res.body, cookies: readCookies(res) };
  };
}

/** Convenience: log in and return the resulting cookie jar. Fails loudly. */
export async function loginAndGetJar(
  e2e: E2eApp,
  email: string,
  password: string,
): Promise<AuthCookies> {
  const res = await loginRequest(e2e, email, password)();
  if (res.status !== 200) {
    throw new Error(
      `fixture login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  return res.cookies;
}

// ---------------------------------- fixtures ------------------------------- //

export interface LoginableUser {
  tenantId: string;
  userId: string;
  email: string;
  password: string;
}

/**
 * An APPROVED, active tenant plus one active user with a real bcrypt password —
 * the minimum shape `POST /auth/login` accepts. Deliberately assigns NO role:
 * `AuthService.loadPrincipal` tolerates a role-less user, and none of the
 * endpoints this audit exercises (`login`, `refresh`, `logout`, `logout-all`,
 * `me`) is permission-gated, so this fixture does not depend on the RBAC seed
 * having been run against the target database.
 *
 * Mirrors `login-protection.e2e-spec.ts`'s `createLoginableUser` — the same
 * approach, extended with the ids the audit needs in order to read rows back.
 */
export async function createLoginableUser(
  e2e: E2eApp,
  label: string,
  password = 'Aud1t!Pass123',
): Promise<LoginableUser> {
  const suffix = `${label}-${randomUUID().slice(0, 8)}`;
  const tenants = e2e.dataSource.getRepository(Tenant);
  const users = e2e.dataSource.getRepository(User);

  const tenant = await tenants.save(
    tenants.create({
      name: `Auth Audit ${suffix}`,
      slug: `auth-audit-${suffix}`,
      contact_email: `auth-audit-${suffix}@example.test`,
      approval_status: TenantApprovalStatus.APPROVED,
      is_active: true,
    }),
  );

  const email = `auth-audit-${suffix}@example.test`;
  const user = await users.save(
    users.create({
      tenant: { id: tenant.id } as Tenant,
      email,
      full_name: `Auth Audit ${suffix}`,
      is_active: true,
      password_hash: await bcrypt.hash(password, TEST_BCRYPT_ROUNDS),
    }),
  );

  return { tenantId: tenant.id, userId: user.id, email, password };
}

// ------------------------- server-side state readers ----------------------- //

export interface TokenRow {
  id: string;
  revoked_at: Date | null;
  expires_at: Date;
  created_at: Date;
  ip_address: string | null;
  /** AUTH-002 rotation lineage — the scope reuse detection is allowed to revoke. */
  family_id: string;
  parent_id: string | null;
  replaced_by_id: string | null;
  rotated_at: Date | null;
  retry_count: number;
}

/** Every `refresh_tokens` row for a user, oldest first. The server-side truth. */
export async function snapshotTokens(
  e2e: E2eApp,
  userId: string,
): Promise<TokenRow[]> {
  return e2e.dataSource.query(
    `SELECT id, revoked_at, expires_at, created_at, ip_address,
            family_id, parent_id, replaced_by_id, rotated_at, retry_count
       FROM refresh_tokens
      WHERE "userId" = $1
      ORDER BY created_at ASC, id ASC`,
    [userId],
  ) as Promise<TokenRow[]>;
}

/** The rotation family a given token row belongs to. */
export async function familyOf(e2e: E2eApp, jti: string): Promise<string> {
  const [row] = (await e2e.dataSource.query(
    `SELECT family_id FROM refresh_tokens WHERE id = $1`,
    [jti],
  )) as Array<{ family_id: string }>;
  return row.family_id;
}

/** Rows that are neither revoked nor past expiry — i.e. still usable. */
export function liveTokens(rows: TokenRow[]): TokenRow[] {
  return rows.filter(
    (r) =>
      r.revoked_at === null && new Date(r.expires_at).getTime() > Date.now(),
  );
}

/** Decodes a refresh JWT's `jti` without verifying — the row id it points at. */
export function jtiOf(refreshToken: string): string {
  const [, payload] = refreshToken.split('.');
  return (
    JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      jti: string;
    }
  ).jti;
}

// -------------------------------- Redis readers ---------------------------- //

/** The rate-limiter connection the auth limiters actually write to. */
export function auditRedis(e2e: E2eApp): Redis {
  return e2e.app.get(AppRedisService).rateLimiter;
}

/**
 * Every key this test FILE's namespace owns, with its TTL.
 *
 * `jest-e2e.env.js` gives each test file its own `QUEUE_ENV_PREFIX`, so this
 * scan can never see another suite's keys — and, critically, this audit never
 * writes or deletes a key, so a shared or developer Redis cannot be damaged by
 * running it.
 */
export async function scanAuthKeys(
  e2e: E2eApp,
): Promise<Array<{ key: string; ttl: number }>> {
  const redis = auditRedis(e2e);
  const prefix = cacheKeyPrefix();
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(
      cursor,
      'MATCH',
      `${prefix}*`,
      'COUNT',
      500,
    );
    cursor = next;
    found.push(...batch);
  } while (cursor !== '0');

  const unique = [...new Set(found)];
  return Promise.all(
    unique.map(async (key) => ({ key, ttl: await redis.ttl(key) })),
  );
}
