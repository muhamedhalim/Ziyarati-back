import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { IntegrationConnection } from '../../../entities/Integration/IntegrationConnection';
import { AppError, ErrorCode } from '../../../common/errors';
import { EncryptionService } from '../../../common/crypto/encryption.service';

import { TestConnectionDto } from '../dto/test-connection.dto';
import { ADMISSION_OP, CONNECTION_AUTH_TYPE, IntegrationResource, getProvider } from '../integration-platform.constants';
import { IntegrationAdmissionService } from '../admission/integration-admission.service';
import { IntegrationAuditService, INTEGRATION_AUDIT_ACTION } from '../integration-audit.service';
import { resolveProviderAdapter } from '../providers/provider.registry';
import { ProviderContext } from '../providers/provider.types';
import {
  ConnectionConfig,
  assertConfigMatchesAuthType,
  mergeConnectionConfig,
  parseConnectionConfig,
} from './connection-config';

export interface ConnectionActor {
  userId?: string;
  ip?: string;
}

export interface ResourceTestResult {
  resource: string;
  ok: boolean;
  message: string;
}

export interface TestConnectionResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
  /** Per-configured-resource reachability — present only when at least one resource endpoint is configured. */
  resources?: ResourceTestResult[];
}

const CREDENTIAL_AUTH_TYPES = new Set<string>([
  CONNECTION_AUTH_TYPE.API_KEY,
  CONNECTION_AUTH_TYPE.SECRET,
  CONNECTION_AUTH_TYPE.BASIC,
]);

/**
 * Tests an UNSAVED (or partially edited) connection draft against the real
 * provider adapter — the SAME adapter/healthCheck code path used post-save —
 * so test-time behaviour can never diverge from runtime behaviour. Nothing is
 * persisted: no connection row is created or modified, and only a best-effort
 * audit record (safe metadata — provider/authType/host/outcome, never the
 * credential or the full URL) is written.
 */
@Injectable()
export class IntegrationConnectionTestService {
  private readonly logger = new Logger(IntegrationConnectionTestService.name);

  constructor(
    @InjectRepository(IntegrationConnection)
    private readonly connections: Repository<IntegrationConnection>,
    private readonly encryption: EncryptionService,
    private readonly admission: IntegrationAdmissionService,
    private readonly audit: IntegrationAuditService,
  ) {}

  async test(tenantId: string, dto: TestConnectionDto, actor: ConnectionActor): Promise<TestConnectionResult> {
    const provider = getProvider(dto.provider);
    if (!provider) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Unknown integration provider' });
    }
    const authType = dto.authType ?? CONNECTION_AUTH_TYPE.NONE;
    if (!provider.authTypes.includes(authType as never)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: `Provider "${provider.key}" does not support auth type "${authType}"`,
      });
    }
    if (authType === CONNECTION_AUTH_TYPE.OAUTH2) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'OAuth 2.0 connections are verified by completing the connect flow, not this test',
      });
    }

    // Real outbound I/O — admission-gated exactly like a live health probe.
    await this.admission.admit(ADMISSION_OP.CONNECTION_TEST, { tenantId, connectionId: dto.connectionId ?? null });

    let existing: IntegrationConnection | null = null;
    if (dto.connectionId) {
      existing = await this.connections.findOne({ where: { id: dto.connectionId, tenant: { id: tenantId } } });
      if (!existing) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Integration connection not found' });
    }

    const patch = parseConnectionConfig(dto.config, {
      providerRequiresBaseUrl: provider.requiresBaseUrl,
      // Editing an existing connection may test a baseUrl-only (or headers-only)
      // change without repeating the rest — an omitted baseUrl there falls back
      // to the stored one. A brand-new draft must supply its own.
      baseUrlRequiredIfOmitted: !existing,
    });
    const config: ConnectionConfig = existing
      ? mergeConnectionConfig(existing.config as ConnectionConfig | null, patch)
      : patch;
    if (!existing) {
      assertConfigMatchesAuthType(config, authType);
    }

    let credential = dto.credential;
    if (credential === undefined) {
      if (existing) {
        credential = existing.credentials_ciphertext ? this.encryption.decrypt(existing.credentials_ciphertext) : undefined;
      } else if (CREDENTIAL_AUTH_TYPES.has(authType)) {
        return { ok: false, message: 'A credential is required to test this connection' };
      }
    }

    const adapter = resolveProviderAdapter(provider.key);
    if (!adapter) {
      return { ok: false, message: `No provider adapter is registered for "${provider.key}"` };
    }

    const ctx: ProviderContext = {
      connectionId: dto.connectionId ?? 'draft',
      tenantId,
      authType,
      credential: credential ?? null,
      config: config as unknown as Record<string, unknown>,
    };

    const started = Date.now();
    let result: { ok: boolean; latencyMs?: number; reason?: string };
    try {
      result = await adapter.healthCheck(ctx);
    } catch (err) {
      this.logger.warn(`connection test threw for provider ${provider.key}: ${(err as Error)?.message}`);
      result = { ok: false, reason: 'Unexpected error while testing the connection' };
    }
    const latencyMs = result.latencyMs ?? Date.now() - started;

    // Verify each CONFIGURED resource endpoint individually — connectivity
    // alone doesn't prove e.g. the "appointment" list path is right, only that
    // the base URL answers. Bounded to the resources the tenant actually
    // configured (at most the 4 known resource types) and never run for a
    // provider with no such check (`checkResource` is optional).
    let resources: ResourceTestResult[] | undefined;
    const configuredResources = Object.keys(config.advanced?.endpoints ?? {}) as IntegrationResource[];
    if (adapter.checkResource && configuredResources.length > 0) {
      resources = [];
      for (const resource of configuredResources) {
        try {
          const r = await adapter.checkResource(ctx, resource);
          resources.push({ resource, ok: r.ok, message: r.message });
        } catch (err) {
          resources.push({
            resource,
            ok: false,
            message: `Unexpected error while checking this resource: ${(err as Error)?.message ?? 'unknown'}`,
          });
        }
      }
    }

    await this.audit
      .record(INTEGRATION_AUDIT_ACTION.CONNECTION_TEST, tenantId, 'IntegrationConnection', dto.connectionId, actor, {
        provider: provider.key,
        authType,
        ok: result.ok,
        host: this.safeHost(config.baseUrl),
        resources: resources?.map((r) => ({ resource: r.resource, ok: r.ok })),
      })
      .catch(() => undefined);

    return {
      ok: result.ok,
      message: result.ok
        ? `Connected successfully (${Math.max(0, Math.round(latencyMs))}ms)`
        : (result.reason ?? 'Could not connect'),
      latencyMs: Math.max(0, Math.round(latencyMs)),
      ...(resources ? { resources } : {}),
    };
  }

  /** Host only — never logs/audits a full URL (query strings some tenants embed secrets in). */
  private safeHost(baseUrl: string | undefined): string | null {
    if (!baseUrl) return null;
    try {
      return new URL(baseUrl).host;
    } catch {
      return null;
    }
  }
}
