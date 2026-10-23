/**
 * A malformed appointment identifier (`apt-edit-1`) must be refused by request validation, before the
 * service runs and before PostgreSQL sees it.
 *
 * Why this exists: PostgreSQL answered `invalid input syntax for type uuid: "apt-edit-1"` in an e2e run.
 * That turned out to be a test fixture (an event emitted with a made-up appointment id), not a route —
 * every appointment route already declares `ParseUUIDPipe`. This pins that, per route, so a route added
 * without the pipe fails here instead of leaning on the 22P02 → 400 backstop in `mapTypeOrmError`.
 *
 * How it tells the two apart: the pipe's rejection says "uuid is expected"; the DB backstop says
 * "One or more values have an invalid format" (typeorm-error.mapper.ts). Either is a 400, but only the
 * first means the id never reached the database.
 */
import request from 'supertest';

import {
  createE2eApp,
  createOwnerFixture,
  cleanupTenant,
  authHeader,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

const API = '/api/v1';
const BAD_ID = 'apt-edit-1';
const DB_BACKSTOP_MESSAGE = 'One or more values have an invalid format';

type Verb = 'get' | 'post' | 'patch' | 'put' | 'delete';
// Every body is VALID for its DTO, so the only thing wrong with each request is the id: body
// validation otherwise answers first (also a 400) and the route would never reach its uuid pipe.
const ROUTES: Array<[Verb, string, object]> = [
  ['get', '', {}],
  ['patch', '', {}],
  ['delete', '', {}],
  [
    'put',
    '/services',
    { serviceIds: ['3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f'] },
  ],
  ['post', '/status', { status: 'CONFIRMED' }],
  ['post', '/cancel', {}],
  ['post', '/reschedule', { newStartAt: '2032-06-16T10:00:00+00:00' }],
  ['post', '/notes', { content: 'note' }],
  ['get', '/notes', {}],
  ['get', '/timeline', {}],
  ['get', '/reminders', {}],
  // POST /review is patient-only: for a staff token the guard answers 403 before the id pipe runs.
  ['get', '/review', {}],
];

describe('malformed appointment id is rejected before the database', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'aptbadid');
  }, 120_000);

  afterAll(async () => {
    try {
      if (owner) await cleanupTenant(e2e, owner.tenantId);
    } finally {
      await e2e?.app.close();
    }
  }, 60_000);

  it.each(ROUTES)(
    '%s /appointments/:id%s → 400 from the uuid pipe',
    async (verb, suffix, body) => {
      const res = await request(e2e.app.getHttpServer())
        [verb](`${API}/appointments/${BAD_ID}${suffix}`)
        .set(...authHeader(owner.token))
        .send(body);

      expect(res.status).toBe(400);
      const message = JSON.stringify(res.body);
      expect(message).toMatch(/uuid is expected/i);
      expect(message).not.toContain(DB_BACKSTOP_MESSAGE);
      expect(message).not.toMatch(/invalid input syntax|22P02/);
    },
  );

  it('a well-formed id that belongs to nobody is a 404, not a 400 (the pipe does not swallow real lookups)', async () => {
    const res = await request(e2e.app.getHttpServer())
      .get(`${API}/appointments/00000000-0000-4000-8000-000000000000`)
      .set(...authHeader(owner.token));
    expect(res.status).toBe(404);
  });
});
