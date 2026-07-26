import { CONNECTION_AUTH_TYPE } from '../integration-platform.constants';
import {
  CredentialCheckResult,
  HealthCheckResult,
  IntegrationProviderAdapter,
  ProviderCapabilities,
  ProviderChangePage,
  ProviderContext,
  ProviderPushResult,
} from './provider.types';
import { GenericRestAdapter } from './generic-rest.adapter';

/**
 * Built-in provider adapters (Phase 4). Endpoints/flows are compiled here —
 * never tenant-supplied — so there is no SSRF/open-redirect surface.
 *
 * `generic_rest` has a REAL coded adapter (`GenericRestAdapter`): it talks to
 * a tenant-supplied, SSRF-guarded base URL using the connection's validated
 * `config` (endpoint paths, pagination, auth). `custom` has no real endpoint
 * wired at all, so it stays the honest `BuiltinRestAdapter` no-op — per the
 * architecture's own rule, an unsupported provider is left unavailable
 * (`requiresBaseUrl: false`, no real transport) rather than given an unsafe
 * pseudo-generic integration.
 */

const NO_ENDPOINT_CAPS: ProviderCapabilities = {
  apiKey: true,
  staticCredential: true,
  oauth2Pkce: false,
  tokenRefresh: false,
  pullChanges: false, // no real endpoint wired
  pushChanges: false,
  webhookVerification: true, // per-connection HMAC (see inbound webhooks)
};

/** Shared implementation for the compiled built-in providers with no live endpoint. */
class BuiltinRestAdapter implements IntegrationProviderAdapter {
  constructor(public readonly key: string) {}
  readonly capabilities = NO_ENDPOINT_CAPS;

  async validateCredential(ctx: ProviderContext): Promise<CredentialCheckResult> {
    const needsCredential =
      ctx.authType === CONNECTION_AUTH_TYPE.API_KEY || ctx.authType === CONNECTION_AUTH_TYPE.SECRET;
    if (needsCredential && (!ctx.credential || ctx.credential.trim() === '')) {
      return { valid: false, reason: 'Missing credential for the configured auth type' };
    }
    return { valid: true };
  }

  async healthCheck(ctx: ProviderContext): Promise<HealthCheckResult> {
    // No live endpoint to probe; report ok only if the credential shape is valid.
    const cred = await this.validateCredential(ctx);
    return cred.valid ? { ok: true } : { ok: false, reason: cred.reason };
  }

  async pullChanges(_ctx: ProviderContext, _resource: unknown, cursor: string | null): Promise<ProviderChangePage> {
    // Honest no-op: no external system is wired for a built-in provider, so there
    // is nothing to pull. The cursor is preserved unchanged.
    return { records: [], nextCursor: cursor, hasMore: false };
  }

  async pushChanges(): Promise<ProviderPushResult> {
    return { pushed: 0, failed: 0 };
  }
}

const BUILTIN_ADAPTERS: Record<string, IntegrationProviderAdapter> = {
  generic_rest: new GenericRestAdapter(),
  custom: new BuiltinRestAdapter('custom'),
};

/** Resolve a compiled adapter by provider key, or undefined if none is registered. */
export function resolveProviderAdapter(providerKey: string): IntegrationProviderAdapter | undefined {
  return BUILTIN_ADAPTERS[providerKey];
}

export const BUILTIN_PROVIDER_KEYS = Object.keys(BUILTIN_ADAPTERS);
