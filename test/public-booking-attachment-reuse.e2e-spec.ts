/**
 * T070 (US4, FR-P012) — proves the deterministic public-booking flow reuses
 * the EXISTING `POST /public/guest/attachments` endpoint unchanged, rather
 * than a second upload implementation.
 *
 * `PublicBookingController.resolve()` mints its `guest_token` cookie through
 * the SAME `GuestSessionService` (`resolveSession()` → `verifyGuest()`) the
 * AI chat widget uses — same secret, same claims shape, same discovery
 * tenant (`guest-session.service.ts`). This suite proves that equivalence
 * end-to-end: a visitor who only ever called `/public/booking/*` routes can
 * still upload through the untouched attachment controller.
 *
 * What this suite deliberately does NOT claim: that the stored file ends up
 * under the SELECTED CLINIC's tenant prefix, or that only that clinic's
 * staff can reach it. Today `verifyGuest()` always resolves the shared
 * discovery tenant, for both this flow and the AI chat — a pre-existing gap
 * in FR-P012's literal wording, tracked separately rather than fixed here
 * (out of scope for "verify reuse, no new upload path"). Guest-vs-guest
 * isolation of an uploaded file is already proven at the service level by
 * `test/security/ai-w6-guest-attachments.spec.ts`; this suite does not
 * duplicate it.
 *
 * Environment note: `AiAttachmentStagingService.assertUploadAllowed()` fails
 * closed (503) when Redis is unreachable — by design (it gates a paid vision
 * call behind no login at all), and Redis is not running in this sandbox
 * (the same constraint T061 already documented for the reminder worker
 * recovery suite). That gate runs strictly AFTER `verifyGuest()` succeeds,
 * so a 503 here (vs. the 404 an invalid/foreign cookie gets) already proves
 * what this suite exists to prove: the deterministic flow's guest_token was
 * accepted as authentic by the untouched attachment controller. A real
 * environment with Redis reachable would see 200 on that same request.
 */
import request from 'supertest';

import { createE2eApp, type E2eApp } from './utils/whatsapp-e2e-app';

const API = '/api/v1';
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)]);

function extractCookie(setCookie: string[] | undefined, name: string): string {
  const raw = (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
  if (!raw) throw new Error(`Expected a Set-Cookie for "${name}"`);
  return raw.split(';')[0];
}

describe('Public booking — attachment reuse (T070, US4)', () => {
  let e2e: E2eApp;

  beforeAll(async () => {
    e2e = await createE2eApp();
  });

  afterAll(async () => {
    await e2e.app.close();
  });

  it('accepts the guest_token minted by the deterministic booking flow as a valid upload identity', async () => {
    const sessionRes = await request(e2e.app.getHttpServer())
      .post(`${API}/public/booking/session`)
      .expect(200);

    const guestTokenCookie = extractCookie(
      sessionRes.headers['set-cookie'] as unknown as string[],
      'guest_token',
    );
    expect(guestTokenCookie).toBeTruthy();

    const uploadRes = await request(e2e.app.getHttpServer())
      .post(`${API}/public/guest/attachments`)
      .set('Cookie', guestTokenCookie)
      .attach('file', PDF, {
        filename: 'report.pdf',
        contentType: 'application/pdf',
      });

    // Never the uniform 404 an invalid/foreign guest_token would get —
    // `verifyGuest()` accepted this identity. 200 in an environment with
    // Redis reachable; 503 here, per the docblock's environment note.
    expect(uploadRes.status).not.toBe(404);
    expect([200, 503]).toContain(uploadRes.status);

    if (uploadRes.status === 200) {
      expect(uploadRes.body).toMatchObject({
        name: 'report.pdf',
        mimeType: 'application/pdf',
      });
      expect(typeof uploadRes.body.id).toBe('string');
    }
  });

  it('refuses an upload with no session at all — no new, looser upload path was created', async () => {
    await request(e2e.app.getHttpServer())
      .post(`${API}/public/guest/attachments`)
      .attach('file', PDF, {
        filename: 'report.pdf',
        contentType: 'application/pdf',
      })
      .expect(404);
  });
});
