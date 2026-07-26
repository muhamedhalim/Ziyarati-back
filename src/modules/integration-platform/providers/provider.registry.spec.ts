import { resolveProviderAdapter, BUILTIN_PROVIDER_KEYS } from './provider.registry';
import { CONNECTION_AUTH_TYPE } from '../integration-platform.constants';
import { ProviderContext } from './provider.types';

const ctx = (over: Partial<ProviderContext> = {}): ProviderContext => ({
  connectionId: 'c1',
  tenantId: 't1',
  authType: CONNECTION_AUTH_TYPE.API_KEY,
  credential: 'secret-abc',
  config: null,
  ...over,
});

describe('provider.registry (built-in adapters)', () => {
  it('resolves the compiled built-in providers', () => {
    expect(BUILTIN_PROVIDER_KEYS).toEqual(expect.arrayContaining(['generic_rest', 'custom']));
    expect(resolveProviderAdapter('generic_rest')).toBeDefined();
    expect(resolveProviderAdapter('custom')).toBeDefined();
    expect(resolveProviderAdapter('does-not-exist')).toBeUndefined();
  });

  describe('"custom" — no coded adapter, honest no-op (per the architecture: unsupported providers stay unavailable)', () => {
    it('validateCredential fails when a required credential is missing', async () => {
      const a = resolveProviderAdapter('custom')!;
      await expect(a.validateCredential(ctx({ credential: null }))).resolves.toMatchObject({ valid: false });
      await expect(a.validateCredential(ctx({ credential: '  ' }))).resolves.toMatchObject({ valid: false });
      await expect(a.validateCredential(ctx({ credential: 'ok' }))).resolves.toMatchObject({ valid: true });
    });

    it('validateCredential passes for auth_type none regardless of credential', async () => {
      const a = resolveProviderAdapter('custom')!;
      await expect(
        a.validateCredential(ctx({ authType: CONNECTION_AUTH_TYPE.NONE, credential: null })),
      ).resolves.toMatchObject({ valid: true });
    });

    it('healthCheck reflects credential validity, never row existence', async () => {
      const a = resolveProviderAdapter('custom')!;
      await expect(a.healthCheck(ctx({ credential: 'ok' }))).resolves.toMatchObject({ ok: true });
      await expect(a.healthCheck(ctx({ credential: null }))).resolves.toMatchObject({ ok: false });
    });

    it('pullChanges is an honest no-op — never fabricates external records', async () => {
      const a = resolveProviderAdapter('custom')!;
      const page = await a.pullChanges(ctx(), 'customer' as never, 'cursor-42');
      expect(page.records).toEqual([]);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBe('cursor-42'); // cursor preserved, not advanced
    });

    it('declares capabilities and never claims a live endpoint it does not have', () => {
      const caps = resolveProviderAdapter('custom')!.capabilities;
      expect(caps.apiKey).toBe(true);
      expect(caps.pullChanges).toBe(false); // no real endpoint wired
      expect(caps.oauth2Pkce).toBe(false);
    });
  });

  describe('"generic_rest" — real coded HTTP adapter (see generic-rest.adapter.spec.ts for request-level behaviour)', () => {
    it('declares real transport capabilities', () => {
      const caps = resolveProviderAdapter('generic_rest')!.capabilities;
      expect(caps.apiKey).toBe(true);
      expect(caps.pullChanges).toBe(true);
      expect(caps.pushChanges).toBe(true);
      expect(caps.oauth2Pkce).toBe(false); // no provider declares oauth:true yet
    });

    it('validateCredential requires a base URL regardless of auth type', async () => {
      const a = resolveProviderAdapter('generic_rest')!;
      await expect(
        a.validateCredential(ctx({ authType: CONNECTION_AUTH_TYPE.NONE, credential: null, config: null })),
      ).resolves.toMatchObject({ valid: false, reason: expect.stringContaining('base URL') });
    });

    it('validateCredential passes for auth_type none once a base URL is configured', async () => {
      const a = resolveProviderAdapter('generic_rest')!;
      await expect(
        a.validateCredential(
          ctx({ authType: CONNECTION_AUTH_TYPE.NONE, credential: null, config: { baseUrl: 'https://api.example.com' } }),
        ),
      ).resolves.toMatchObject({ valid: true });
    });

    it('validateCredential requires the api_key sub-config, not just a credential', async () => {
      const a = resolveProviderAdapter('generic_rest')!;
      await expect(
        a.validateCredential(
          ctx({ authType: CONNECTION_AUTH_TYPE.API_KEY, credential: 'k', config: { baseUrl: 'https://api.example.com' } }),
        ),
      ).resolves.toMatchObject({ valid: false, reason: expect.stringContaining('API key') });
    });
  });
});
