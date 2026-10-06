import cors from 'cors';
import express from 'express';
import request from 'supertest';

import {
  buildCorsOptions,
  CORS_PREFLIGHT_MAX_AGE_SECONDS,
  parseAllowedOrigins,
} from './cors-origins';

describe('parseAllowedOrigins', () => {
  it('splits and trims a comma-separated list', () => {
    expect(parseAllowedOrigins('https://a.example, https://b.example')).toEqual(
      ['https://a.example', 'https://b.example'],
    );
  });

  it('normalizes a trailing slash away — the regression this exists for', () => {
    // A browser `Origin` header is never `https://a.example/`, and the `cors`
    // package compares by exact string equality, so the un-normalized value
    // matched nothing and every cross-origin request was refused silently.
    expect(parseAllowedOrigins('https://a.example/')).toEqual([
      'https://a.example',
    ]);
  });

  it('normalizes a path away', () => {
    expect(parseAllowedOrigins('https://a.example/dashboard')).toEqual([
      'https://a.example',
    ]);
  });

  it('keeps the port, which is part of the origin', () => {
    expect(parseAllowedOrigins('http://localhost:3000')).toEqual([
      'http://localhost:3000',
    ]);
  });

  it('keeps `www.` and the apex distinct — they are different origins', () => {
    expect(
      parseAllowedOrigins('https://www.a.example,https://a.example'),
    ).toEqual(['https://www.a.example', 'https://a.example']);
  });

  it('drops empty entries left by a trailing or doubled comma', () => {
    expect(parseAllowedOrigins('https://a.example,,')).toEqual([
      'https://a.example',
    ]);
  });

  it('falls back to the dev SPA origin when unset', () => {
    expect(parseAllowedOrigins(undefined)).toEqual(['http://localhost:3000']);
  });

  it('keeps an unparseable entry verbatim rather than dropping it', () => {
    // Normalization must never make the allow-list narrower than the
    // hand-rolled split it replaced; production refuses to boot on these
    // anyway (env.validation.ts).
    expect(parseAllowedOrigins('not a url')).toEqual(['not a url']);
  });
});

/**
 * Residency plan P9: what a browser on the app origin actually gets back from
 * the API origin. Runs the real `cors` middleware (the one `app.enableCors`
 * installs) through a real HTTP stack, so a header that is configured but not
 * emitted — or emitted but not exposed — fails here rather than silently in
 * production.
 */
describe('buildCorsOptions — direct API routing', () => {
  const APP = 'https://app.clinic.example';

  const server = () => {
    const app = express();
    app.use(cors(buildCorsOptions(parseAllowedOrigins(APP))));
    app.get('/api/v1/ping', (_req, res) => {
      res.setHeader('X-Request-Id', 'req-1');
      res.setHeader('Content-Disposition', 'attachment; filename="r.csv"');
      res.json({ ok: true });
    });
    app.post('/api/v1/ping', (_req, res) => res.json({ ok: true }));
    return app;
  };

  it('allows credentialed requests from the app origin and exposes the headers the SPA reads', async () => {
    const res = await request(server())
      .get('/api/v1/ping')
      .set('Origin', APP)
      .expect(200);

    expect(res.headers['access-control-allow-origin']).toBe(APP);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    const exposed = String(res.headers['access-control-expose-headers'])
      .toLowerCase()
      .split(',')
      .map((h) => h.trim());
    expect(exposed).toEqual(
      expect.arrayContaining(['x-request-id', 'content-disposition']),
    );
  });

  it('answers the preflight for a CSRF-bearing POST and lets the browser cache it', async () => {
    const res = await request(server())
      .options('/api/v1/ping')
      .set('Origin', APP)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-csrf-token')
      .expect(204);

    expect(res.headers['access-control-allow-origin']).toBe(APP);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(
      String(res.headers['access-control-allow-headers']).toLowerCase(),
    ).toContain('x-csrf-token');
    expect(res.headers['access-control-max-age']).toBe(
      String(CORS_PREFLIGHT_MAX_AGE_SECONDS),
    );
  });

  it('never grants an origin outside the allow-list, and never a wildcard', async () => {
    for (const origin of [
      'https://evil.example',
      // Same registrable domain is NOT enough — the list is exact-match.
      'https://other.clinic.example',
      'https://app.clinic.example.evil.test',
    ]) {
      const res = await request(server())
        .get('/api/v1/ping')
        .set('Origin', origin);
      // No Allow-Origin is what makes the browser refuse to expose the
      // response; `cors` still emits Allow-Credentials, which is inert alone.
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
    expect(buildCorsOptions(['https://a.example']).origin).not.toContain('*');
  });
});
