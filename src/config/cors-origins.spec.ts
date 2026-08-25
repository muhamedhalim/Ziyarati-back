import { parseAllowedOrigins } from './cors-origins';

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
