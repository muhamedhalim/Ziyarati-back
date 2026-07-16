import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';

import { EncryptionService } from './encryption.service';
import { AppError } from '../errors';

/** Builds a service bound to a specific key (or none). */
function makeService(key?: string): EncryptionService {
  const config = {
    get: (name: string) => (name === 'CREDENTIALS_ENCRYPTION_KEY' ? key : undefined),
  } as unknown as ConfigService;
  const service = new EncryptionService(config);
  service.onModuleInit();
  return service;
}

const KEY_B64 = randomBytes(32).toString('base64');
const OTHER_KEY_B64 = randomBytes(32).toString('base64');

describe('EncryptionService', () => {
  describe('round-trip', () => {
    it('decrypts what it encrypts', () => {
      const service = makeService(KEY_B64);
      const token = 'EAAG-a-very-secret-meta-token';

      const encrypted = service.encrypt(token);

      expect(encrypted).not.toBe(token);
      expect(service.decrypt(encrypted)).toBe(token);
    });

    it('accepts a hex key as well as base64', () => {
      const service = makeService(randomBytes(32).toString('hex'));
      expect(service.decrypt(service.encrypt('secret'))).toBe('secret');
    });

    it('never emits the plaintext inside the envelope', () => {
      const service = makeService(KEY_B64);
      expect(service.encrypt('super-secret-value')).not.toContain('super-secret-value');
    });

    it('produces different ciphertext each call (fresh IV per encrypt)', () => {
      const service = makeService(KEY_B64);

      const a = service.encrypt('same-token');
      const b = service.encrypt('same-token');

      // Equal ciphertexts would mean a reused IV — catastrophic for GCM.
      expect(a).not.toBe(b);
      expect(service.decrypt(a)).toBe(service.decrypt(b));
    });
  });

  describe('legacy plaintext tolerance', () => {
    it('returns an unprefixed (pre-encryption) value unchanged', () => {
      const service = makeService(KEY_B64);
      // This is what a not-yet-backfilled row looks like.
      expect(service.decrypt('EAAG-legacy-plaintext')).toBe('EAAG-legacy-plaintext');
    });

    it('reports whether a value is already encrypted', () => {
      const service = makeService(KEY_B64);

      expect(service.isEncrypted(service.encrypt('x'))).toBe(true);
      expect(service.isEncrypted('plaintext')).toBe(false);
      expect(service.isEncrypted(undefined)).toBe(false);
    });
  });

  describe('empty/nullish passthrough', () => {
    it('passes undefined through both directions', () => {
      const service = makeService(KEY_B64);
      expect(service.encrypt(undefined)).toBeUndefined();
      expect(service.decrypt(undefined)).toBeUndefined();
    });

    it('passes null through both directions', () => {
      const service = makeService(KEY_B64);
      expect(service.encrypt(null)).toBeNull();
      expect(service.decrypt(null)).toBeNull();
    });

    it('passes an empty string through both directions', () => {
      const service = makeService(KEY_B64);
      expect(service.encrypt('')).toBe('');
      expect(service.decrypt('')).toBe('');
    });
  });

  describe('tamper + wrong-key detection', () => {
    it('throws when the ciphertext has been tampered with', () => {
      const service = makeService(KEY_B64);
      const encrypted = service.encrypt('sensitive');

      // Flip the last character of the ciphertext segment.
      const tampered = encrypted.slice(0, -1) + (encrypted.endsWith('A') ? 'B' : 'A');

      expect(() => service.decrypt(tampered)).toThrow(AppError);
    });

    it('throws when decrypting under a different key', () => {
      const encrypted = makeService(KEY_B64).encrypt('sensitive');

      expect(() => makeService(OTHER_KEY_B64).decrypt(encrypted)).toThrow(AppError);
    });

    it('throws on a malformed envelope', () => {
      const service = makeService(KEY_B64);
      expect(() => service.decrypt('enc:v1:only-one-segment')).toThrow(AppError);
    });

    it('does not leak the secret or the key in the thrown message', () => {
      const encrypted = makeService(KEY_B64).encrypt('the-secret-token');

      expect(() => makeService(OTHER_KEY_B64).decrypt(encrypted)).toThrow(
        /could not be decrypted/i,
      );
      try {
        makeService(OTHER_KEY_B64).decrypt(encrypted);
      } catch (err) {
        const message = (err as AppError).message;
        expect(message).not.toContain('the-secret-token');
        expect(message).not.toContain(KEY_B64);
      }
    });
  });

  describe('key configuration', () => {
    it('reports unconfigured when no key is set', () => {
      expect(makeService(undefined).configured).toBe(false);
    });

    it('reports configured when a valid key is set', () => {
      expect(makeService(KEY_B64).configured).toBe(true);
    });

    it('throws (rather than storing plaintext) when encrypting with no key', () => {
      expect(() => makeService(undefined).encrypt('secret')).toThrow(AppError);
    });

    it('still passes legacy plaintext through when no key is set', () => {
      // Reading must not hard-fail before the key is rolled out.
      expect(makeService(undefined).decrypt('legacy')).toBe('legacy');
    });

    it('rejects a key of the wrong length at boot', () => {
      expect(() => makeService(Buffer.from('too-short').toString('base64'))).toThrow(
        /32 bytes/i,
      );
    });
  });

  describe('secretEquals', () => {
    it('compares equal secrets as equal', () => {
      expect(EncryptionService.secretEquals('abc123', 'abc123')).toBe(true);
    });

    it('compares differing secrets as unequal', () => {
      expect(EncryptionService.secretEquals('abc123', 'abc124')).toBe(false);
      expect(EncryptionService.secretEquals('abc', 'abcdef')).toBe(false);
    });
  });
});
