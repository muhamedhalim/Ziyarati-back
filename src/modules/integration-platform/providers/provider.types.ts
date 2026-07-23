import { IntegrationResource } from '../integration-platform.constants';

/**
 * Provider abstraction for external PMS/EMR/ERP/CRM adapters (Phase 4).
 *
 * This is NOT a generic OAuth server and NOT a place tenants can inject URLs.
 * Every adapter's endpoints/flows come from COMPILED provider definitions or
 * trusted backend configuration only. An adapter declares its capabilities and
 * implements the subset it supports; the sync engine and health monitor call
 * through this interface so a real adapter can be dropped in without touching the
 * pipeline.
 */

export interface ProviderCapabilities {
  apiKey: boolean;
  staticCredential: boolean;
  oauth2Pkce: boolean;
  tokenRefresh: boolean;
  pullChanges: boolean;
  pushChanges: boolean;
  webhookVerification: boolean;
}

/** Non-secret context handed to an adapter for one operation. */
export interface ProviderContext {
  connectionId: string;
  tenantId: string;
  authType: string;
  /** Decrypted credential — present only when the connection stores one. */
  credential?: string | null;
  /** Non-secret connection settings. */
  config?: Record<string, unknown> | null;
}

export interface CredentialCheckResult {
  valid: boolean;
  reason?: string;
}

export interface HealthCheckResult {
  ok: boolean;
  latencyMs?: number;
  reason?: string;
}

/** One page of external changes to pull inbound. */
export interface ProviderChangePage {
  records: Array<{ externalId: string; data: Record<string, unknown> }>;
  /** Watermark to resume from; null when the provider has no further pages. */
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ProviderPushResult {
  pushed: number;
  failed: number;
}

export interface IntegrationProviderAdapter {
  readonly key: string;
  readonly capabilities: ProviderCapabilities;

  /** Validate that the stored credential is well-formed for this provider. */
  validateCredential(ctx: ProviderContext): Promise<CredentialCheckResult>;

  /** Liveness/latency probe. Must reflect real communication, never row existence. */
  healthCheck(ctx: ProviderContext): Promise<HealthCheckResult>;

  /** Pull a bounded page of external changes since `cursor` (inbound sync). */
  pullChanges(
    ctx: ProviderContext,
    resource: IntegrationResource,
    cursor: string | null,
  ): Promise<ProviderChangePage>;

  /** Push internal records to the external system (outbound sync). */
  pushChanges(
    ctx: ProviderContext,
    resource: IntegrationResource,
    records: Array<{ externalId: string | null; data: Record<string, unknown> }>,
  ): Promise<ProviderPushResult>;

  /** Optional: verify an inbound webhook signature for this provider. */
  verifyWebhook?(headers: Record<string, string | undefined>, rawBody: string, secret: string): boolean;
}
