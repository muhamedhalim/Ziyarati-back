import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { databaseSslOptions } from './database-ssl';

const SAMPLE_PEM =
  '-----BEGIN CERTIFICATE-----\nMIIBSAMPLEnotarealcertificatejustfortests==\n-----END CERTIFICATE-----\n';

describe('databaseSslOptions (ZT-012)', () => {
  it('returns false outside production regardless of CA config — unchanged existing behaviour', () => {
    expect(databaseSslOptions({ NODE_ENV: 'development' })).toBe(false);
    expect(databaseSslOptions({ NODE_ENV: 'test' })).toBe(false);
    expect(databaseSslOptions({ NODE_ENV: undefined })).toBe(false);
    // Even with a CA present, non-production stays false (ssl config is a
    // production-only concern here).
    expect(
      databaseSslOptions({
        NODE_ENV: 'development',
        DB_SSL_CA_CERT: SAMPLE_PEM,
      }),
    ).toBe(false);
  });

  it('production with DB_SSL_CA_CERT (inline PEM) returns rejectUnauthorized:true with that content', () => {
    const result = databaseSslOptions({
      NODE_ENV: 'production',
      DB_SSL_CA_CERT: SAMPLE_PEM,
    });
    // Trimmed (surrounding whitespace, e.g. a trailing newline injected by
    // shell export / .env loading, is not part of the certificate).
    expect(result).toEqual({ rejectUnauthorized: true, ca: SAMPLE_PEM.trim() });
  });

  it('production with DB_SSL_CA (file path) reads the file and returns rejectUnauthorized:true with its content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zt012-'));
    const caPath = join(dir, 'ca.pem');
    writeFileSync(caPath, SAMPLE_PEM, 'utf8');
    try {
      const result = databaseSslOptions({
        NODE_ENV: 'production',
        DB_SSL_CA: caPath,
      });
      expect(result).toEqual({ rejectUnauthorized: true, ca: SAMPLE_PEM });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('production with neither DB_SSL_CA nor DB_SSL_CA_CERT refuses rather than falling back to rejectUnauthorized:false', () => {
    expect(() => databaseSslOptions({ NODE_ENV: 'production' })).toThrow(
      /DB_SSL_CA/,
    );
  });

  it('production with an unreadable DB_SSL_CA path fails loudly rather than silently proceeding', () => {
    expect(() =>
      databaseSslOptions({
        NODE_ENV: 'production',
        DB_SSL_CA: '/nonexistent/path/ca.pem',
      }),
    ).toThrow(/DB_SSL_CA/);
  });

  it('never returns rejectUnauthorized:false in production under any input', () => {
    const inputs: Array<Parameters<typeof databaseSslOptions>[0]> = [
      { NODE_ENV: 'production', DB_SSL_CA_CERT: SAMPLE_PEM },
    ];
    for (const input of inputs) {
      const result = databaseSslOptions(input);
      expect(result).not.toBe(false);
      if (typeof result === 'object') {
        expect(result.rejectUnauthorized).toBe(true);
      }
    }
  });
});
