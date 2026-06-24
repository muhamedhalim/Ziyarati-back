import {
  generateApiKey,
  hashApiKey,
  redactSecrets,
  API_KEY_PREFIX,
} from './platform.constants';

describe('platform.constants', () => {
  describe('generateApiKey / hashApiKey', () => {
    it('mints a prefixed plaintext and a matching sha-256 hash', () => {
      const { plaintext, hash } = generateApiKey();
      expect(plaintext.startsWith(`${API_KEY_PREFIX}_`)).toBe(true);
      expect(hash).toBe(hashApiKey(plaintext));
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('hashApiKey is deterministic', () => {
      expect(hashApiKey('abc')).toBe(hashApiKey('abc'));
      expect(hashApiKey('abc')).not.toBe(hashApiKey('abd'));
    });
  });

  describe('redactSecrets', () => {
    it('redacts sensitive keys deeply across objects and arrays', () => {
      const out = redactSecrets({
        access_token: 't',
        nested: { client_secret: 's', ok: 1 },
        list: [{ api_key: 'k' }],
        plain: 'visible',
      }) as any;
      expect(out.access_token).toBe('[REDACTED]');
      expect(out.nested.client_secret).toBe('[REDACTED]');
      expect(out.nested.ok).toBe(1);
      expect(out.list[0].api_key).toBe('[REDACTED]');
      expect(out.plain).toBe('visible');
    });

    it('passes through primitives and null', () => {
      expect(redactSecrets('x')).toBe('x');
      expect(redactSecrets(null)).toBeNull();
    });

    it('caps recursion depth', () => {
      let deep: any = { token: 'leaf' };
      for (let i = 0; i < 10; i += 1) deep = { nested: deep };
      expect(() => redactSecrets(deep)).not.toThrow();
    });
  });
});
