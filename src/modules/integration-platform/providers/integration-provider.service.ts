import { Injectable } from '@nestjs/common';

import { EncryptionService } from '../../../common/crypto/encryption.service';
import { IntegrationConnection } from '../../../entities/Integration/IntegrationConnection';
import { AppError, ErrorCode } from '../../../common/errors';

import { IntegrationResource } from '../integration-platform.constants';
import { resolveProviderAdapter } from './provider.registry';
import {
  CredentialCheckResult,
  HealthCheckResult,
  ProviderChangePage,
  ProviderContext,
  ProviderPushRecord,
  ProviderPushResult,
  ResourceCheckResult,
} from './provider.types';

/**
 * Thin Nest wrapper over the compiled provider registry (Phase 4). Builds the
 * per-operation ProviderContext — decrypting the connection credential ONLY here,
 * in memory, for the duration of the call — and delegates to the resolved
 * adapter. Callers (sync engine, health monitor) never touch decryption or
 * adapter selection directly.
 */
@Injectable()
export class IntegrationProviderService {

  constructor(private readonly encryption: EncryptionService) {}

  private contextOf(connection: IntegrationConnection): ProviderContext {
    let credential: string | null = null;
    if (connection.credentials_ciphertext) {
      try {
        credential = this.encryption.decrypt(connection.credentials_ciphertext);
      } catch {
        credential = null; // treated as an invalid credential by the adapter
      }
    }
    return {
      connectionId: connection.id,
      tenantId: (connection.tenant as { id: string })?.id,
      authType: connection.auth_type,
      credential,
      config: connection.config ?? null,
    };
  }

  private adapterOrThrow(providerKey: string) {
    const adapter = resolveProviderAdapter(providerKey);
    if (!adapter) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `No provider adapter is registered for "${providerKey}"`,
      });
    }
    return adapter;
  }

  capabilitiesOf(providerKey: string) {
    return resolveProviderAdapter(providerKey)?.capabilities ?? null;
  }

  async validateCredential(connection: IntegrationConnection): Promise<CredentialCheckResult> {
    return this.adapterOrThrow(connection.provider).validateCredential(this.contextOf(connection));
  }

  async healthCheck(connection: IntegrationConnection): Promise<HealthCheckResult> {
    const started = Date.now();
    const res = await this.adapterOrThrow(connection.provider).healthCheck(this.contextOf(connection));
    return { ...res, latencyMs: res.latencyMs ?? Date.now() - started };
  }

  async pullChanges(
    connection: IntegrationConnection,
    resource: IntegrationResource,
    cursor: string | null,
  ): Promise<ProviderChangePage> {
    return this.adapterOrThrow(connection.provider).pullChanges(this.contextOf(connection), resource, cursor);
  }

  /** Push a bounded batch of internal records to the external system (outbound sync). */
  async pushChanges(
    connection: IntegrationConnection,
    resource: IntegrationResource,
    records: ProviderPushRecord[],
  ): Promise<ProviderPushResult> {
    return this.adapterOrThrow(connection.provider).pushChanges(this.contextOf(connection), resource, records);
  }

  /** Verify ONE configured resource's endpoint (connection verification) — absent when the adapter has no such check. */
  async checkResource(connection: IntegrationConnection, resource: IntegrationResource): Promise<ResourceCheckResult | null> {
    const adapter = this.adapterOrThrow(connection.provider);
    if (!adapter.checkResource) return null;
    return adapter.checkResource(this.contextOf(connection), resource);
  }
}
