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
    expect(resolveProviderAdapter('does-not-exist')).toBeUndefined();
  });

  it('validateCredential fails when a required credential is missing', async () => {
    const a = resolveProviderAdapter('generic_rest')!;
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
    const a = resolveProviderAdapter('generic_rest')!;
    await expect(a.healthCheck(ctx({ credential: 'ok' }))).resolves.toMatchObject({ ok: true });
    await expect(a.healthCheck(ctx({ credential: null }))).resolves.toMatchObject({ ok: false });
  });

  it('pullChanges is an honest no-op — never fabricates external records', async () => {
    const a = resolveProviderAdapter('generic_rest')!;
    const page = await a.pullChanges(ctx(), 'customer' as never, 'cursor-42');
    expect(page.records).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBe('cursor-42'); // cursor preserved, not advanced
  });

  it('declares capabilities and never claims a live endpoint it does not have', () => {
    const caps = resolveProviderAdapter('generic_rest')!.capabilities;
    expect(caps.apiKey).toBe(true);
    expect(caps.pullChanges).toBe(false); // no real endpoint wired
    expect(caps.oauth2Pkce).toBe(false);
  });
});
