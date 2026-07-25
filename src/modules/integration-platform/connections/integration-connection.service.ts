import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, IsNull, Repository } from 'typeorm';

import { IntegrationConnection } from '../../../entities/Integration/IntegrationConnection';
import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../../common/errors';
import { EncryptionService } from '../../../common/crypto/encryption.service';

import { CreateConnectionDto } from '../dto/create-connection.dto';
import { UpdateConnectionDto } from '../dto/update-connection.dto';
import { QueryConnectionsDto } from '../dto/query-connections.dto';
import {
  ADMISSION_OP,
  CONNECTION_AUTH_TYPE,
  CONNECTION_STATUS,
  ConflictPolicy,
  HEALTH_DEGRADED_AT,
  HEALTH_OFFLINE_AT,
  HEALTH_STATE,
  HealthState,
  INTEGRATION_PROVIDERS,
  getProvider,
} from '../integration-platform.constants';
import { IntegrationAuditService, INTEGRATION_AUDIT_ACTION } from '../integration-audit.service';
import { IntegrationProviderService } from '../providers/integration-provider.service';
import { IntegrationAdmissionService } from '../admission/integration-admission.service';
import { IntegrationIdMapService } from '../mappings/integration-id-map.service';

/** Age after which a connection with no fresh success is considered stale/offline. */
const HEALTH_STALE_SUCCESS_MS = 24 * 3600 * 1000;

/** Connection with the encrypted credential stripped — the shape returned to clients. */
export type SafeConnection = Omit<IntegrationConnection, 'credentials_ciphertext'> & {
  hasCredential: boolean;
  /** Derived health state (healthy|degraded|offline|disabled) — never row existence. */
  healthState: HealthState;
};

export interface ConnectionActor {
  userId?: string;
  ip?: string;
}

/**
 * Tenant-owned external-system connections (Phase 3). A tenant may hold many
 * connections; every query filters `where: { tenant: { id }, deleted_at IS NULL }`.
 * The provider credential is stored ENCRYPTED and NEVER serialized — only
 * `hasCredential` is exposed. Provider + auth-type are validated against the
 * trusted registry, so arbitrary provider URLs/flows can never be introduced.
 */
@Injectable()
export class IntegrationConnectionService {
  private readonly logger = new Logger(IntegrationConnectionService.name);

  constructor(
    @InjectRepository(IntegrationConnection)
    private readonly connections: Repository<IntegrationConnection>,
    private readonly encryption: EncryptionService,
    private readonly audit: IntegrationAuditService,
    private readonly providers: IntegrationProviderService,
    private readonly admission: IntegrationAdmissionService,
    private readonly idMap: IntegrationIdMapService,
  ) {}

  async create(tenantId: string, dto: CreateConnectionDto, actor: ConnectionActor): Promise<SafeConnection> {
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
    this.assertCredentialConsistency(authType, dto.credential);

    const saved = await this.connections.save(
      this.connections.create({
        tenant: { id: tenantId } as Tenant,
        name: dto.name,
        provider: provider.key,
        auth_type: authType,
        credentials_ciphertext: dto.credential ? this.encryption.encrypt(dto.credential) : null,
        status: CONNECTION_STATUS.ACTIVE,
        sync_direction: dto.syncDirection ?? 'bidirectional',
        default_conflict_policy: dto.defaultConflictPolicy ?? 'reject_and_report',
      }),
    );
    this.logger.log(`Integration connection ${saved.id} created for tenant ${tenantId}`);
    await this.audit.record(INTEGRATION_AUDIT_ACTION.CONNECTION_CREATE, tenantId, 'IntegrationConnection', saved.id, actor, {
      name: dto.name,
      provider: provider.key,
      authType,
      syncDirection: saved.sync_direction,
      defaultConflictPolicy: saved.default_conflict_policy,
    });
    return this.toSafe(saved);
  }

  async list(tenantId: string, query: QueryConnectionsDto) {
    const where: FindOptionsWhere<IntegrationConnection> = { tenant: { id: tenantId }, deleted_at: IsNull() };
    if (query.status) where.status = query.status;

    const [rows, total] = await this.connections.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data: rows.map((c) => this.toSafe(c)), total, page: query.page, limit: query.limit };
  }

  async get(tenantId: string, id: string): Promise<SafeConnection> {
    return this.toSafe(await this.findOneOrThrow(tenantId, id));
  }

  /**
   * Derived health/status snapshot (no credential). The `state` is computed from
   * real signals — status, consecutive failures, and last-success staleness —
   * NEVER from row existence alone.
   */
  async health(tenantId: string, id: string) {
    const c = await this.findOneOrThrow(tenantId, id);
    return this.healthView(c);
  }

  /**
   * LIVE health probe — actually calls the provider adapter's healthCheck (real
   * communication, not row existence), records latency + success/failure, and
   * returns the refreshed health view.
   */
  async checkHealth(tenantId: string, id: string, actor: ConnectionActor) {
    const c = await this.findOneOrThrow(tenantId, id);
    if (c.status !== CONNECTION_STATUS.ACTIVE) {
      return this.healthView(c);
    }
    // A probe makes an OUTBOUND call — admission-controlled so it cannot be used
    // to hammer a provider (or us) from the dashboard.
    await this.admission.admit(ADMISSION_OP.HEALTH_PROBE, { tenantId, connectionId: id });
    const started = Date.now();
    try {
      const res = await this.providers.healthCheck(c);
      if (res.ok) {
        await this.markSuccess(c.id, res.latencyMs ?? Date.now() - started);
      } else {
        await this.markError(c.id, res.reason ?? 'Provider health check failed');
      }
    } catch (err) {
      await this.markError(c.id, (err as Error)?.message ?? 'Provider health check error');
    }
    await this.audit.record(INTEGRATION_AUDIT_ACTION.CONNECTION_UPDATE, tenantId, 'IntegrationConnection', id, actor, {
      action: 'healthCheck',
    });
    return this.healthView(await this.findOneOrThrow(tenantId, id));
  }

  private healthView(c: IntegrationConnection) {
    return {
      id: c.id,
      status: c.status,
      state: this.deriveHealthState(c),
      /** Retained boolean for back-compat; true only when state === healthy. */
      healthy: this.deriveHealthState(c) === HEALTH_STATE.HEALTHY,
      lastSuccessAt: c.last_success_at ?? null,
      lastError: c.last_error ?? null,
      lastErrorAt: c.last_error_at ?? null,
      consecutiveFailures: c.consecutive_failures ?? 0,
      latencyMs: c.last_latency_ms ?? null,
      /** Credential presence + shape only — never the secret itself. */
      credential: { present: !!c.credentials_ciphertext, authType: c.auth_type },
      syncDirection: c.sync_direction,
    };
  }

  /**
   * healthy → degraded → offline → disabled, from real signals only:
   *  - disabled: connection is not active.
   *  - offline : too many consecutive failures, or no fresh success in a day.
   *  - degraded: some recent failures, or active-but-never-yet-succeeded.
   *  - healthy : active, a recent success, and zero consecutive failures.
   */
  private deriveHealthState(c: IntegrationConnection): HealthState {
    if (c.status !== CONNECTION_STATUS.ACTIVE) return HEALTH_STATE.DISABLED;
    const failures = c.consecutive_failures ?? 0;
    const lastSuccessMs = c.last_success_at ? c.last_success_at.getTime() : null;
    const stale = lastSuccessMs !== null && Date.now() - lastSuccessMs > HEALTH_STALE_SUCCESS_MS;

    if (failures >= HEALTH_OFFLINE_AT) return HEALTH_STATE.OFFLINE;
    if (failures >= HEALTH_DEGRADED_AT) return HEALTH_STATE.DEGRADED;
    if (lastSuccessMs === null) return HEALTH_STATE.DEGRADED; // never proven → not "healthy"
    if (stale) return HEALTH_STATE.OFFLINE;
    return HEALTH_STATE.HEALTHY;
  }

  async update(tenantId: string, id: string, dto: UpdateConnectionDto, actor: ConnectionActor): Promise<SafeConnection> {
    const c = await this.findOneOrThrow(tenantId, id);
    if (dto.name !== undefined) c.name = dto.name;
    if (dto.syncDirection !== undefined) c.sync_direction = dto.syncDirection;
    if (dto.defaultConflictPolicy !== undefined) c.default_conflict_policy = dto.defaultConflictPolicy;
    if (dto.credential !== undefined) {
      this.assertCredentialConsistency(c.auth_type, dto.credential);
      c.credentials_ciphertext = dto.credential ? this.encryption.encrypt(dto.credential) : null;
    }
    const saved = await this.connections.save(c);
    await this.audit.record(INTEGRATION_AUDIT_ACTION.CONNECTION_UPDATE, tenantId, 'IntegrationConnection', id, actor, {
      name: dto.name ?? null,
      syncDirection: dto.syncDirection ?? null,
      defaultConflictPolicy: dto.defaultConflictPolicy ?? null,
      credentialRotated: dto.credential !== undefined,
    });
    return this.toSafe(saved);
  }

  /**
   * Deactivate/reactivate. Deactivation is fully REVERSIBLE and destroys
   * nothing: mappings, import/sync history, conflicts and audit all remain, and
   * the connection simply stops being writable (`requireActive` rejects it), so
   * writes, sync runs and inbound webhooks are all refused while it is off.
   */
  async setActive(tenantId: string, id: string, active: boolean, actor: ConnectionActor): Promise<SafeConnection> {
    const c = await this.findOneOrThrow(tenantId, id);
    if (c.status === CONNECTION_STATUS.DISCONNECTED) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'This connection is disconnected — use reconnect to bring it back',
      });
    }
    c.status = active ? CONNECTION_STATUS.ACTIVE : CONNECTION_STATUS.INACTIVE;
    const saved = await this.connections.save(c);
    await this.audit.record(
      active ? INTEGRATION_AUDIT_ACTION.CONNECTION_ACTIVATE : INTEGRATION_AUDIT_ACTION.CONNECTION_DEACTIVATE,
      tenantId,
      'IntegrationConnection',
      id,
      actor,
    );
    return this.toSafe(saved);
  }

  /**
   * Disconnect + soft-delete: clears stored credentials, marks the connection
   * disconnected, and hides it from tenant reads — but preserves the row so its
   * mappings and history survive for audit.
   */
  async disconnect(tenantId: string, id: string, actor: ConnectionActor): Promise<{ disconnected: true }> {
    const c = await this.findOneOrThrow(tenantId, id);
    c.status = CONNECTION_STATUS.DISCONNECTED;
    c.credentials_ciphertext = null;
    c.deleted_at = new Date();
    await this.connections.save(c);
    await this.audit.record(INTEGRATION_AUDIT_ACTION.CONNECTION_DISCONNECT, tenantId, 'IntegrationConnection', id, actor);
    return { disconnected: true };
  }

  /**
   * RECONNECT a disconnected connection. Ordinary disconnect is a soft-delete
   * that keeps every mapping and all history, so reconnecting is a genuine
   * restore rather than a fresh start.
   *
   * Two shapes, both non-destructive:
   *  - same connection (no `replacementConnectionId`): clear the soft-delete and
   *    reactivate. Its mappings are still attached, so nothing has to move.
   *  - replacement connection: carry the ACTIVE mappings over to the replacement
   *    (see `transferMappings`), leaving the originals as unlinked historical
   *    rows. Nothing is deleted on either side.
   *
   * A credential must be supplied again when the auth type needs one, because
   * disconnect deliberately destroys the stored secret.
   */
  async reconnect(
    tenantId: string,
    id: string,
    opts: { replacementConnectionId?: string; credential?: string },
    actor: ConnectionActor,
  ) {
    const c = await this.connections.findOne({ where: { id, tenant: { id: tenantId } } });
    if (!c) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Integration connection not found' });

    if (opts.replacementConnectionId) {
      // Cross-tenant safety: the replacement is resolved tenant-scoped, so a
      // connection from another tenant can never be named here.
      const replacement = await this.findOneOrThrow(tenantId, opts.replacementConnectionId);
      if (replacement.id === c.id) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, {
          message: 'The replacement connection must be a different connection',
        });
      }
      if (replacement.status !== CONNECTION_STATUS.ACTIVE) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'The replacement connection must be active',
        });
      }
      const moved = await this.idMap.transferMappings(tenantId, c.id, replacement.id);
      await this.audit.record(INTEGRATION_AUDIT_ACTION.MAPPING_TRANSFER, tenantId, 'IntegrationConnection', c.id, actor, {
        fromConnectionId: c.id,
        toConnectionId: replacement.id,
        ...moved,
      });
      return { reconnected: true, connectionId: replacement.id, mappings: moved };
    }

    if (c.status === CONNECTION_STATUS.ACTIVE && !c.deleted_at) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'This connection is already active' });
    }
    this.assertCredentialConsistency(c.auth_type, opts.credential);
    const needsCredential =
      c.auth_type === CONNECTION_AUTH_TYPE.API_KEY || c.auth_type === CONNECTION_AUTH_TYPE.SECRET;
    if (needsCredential && !opts.credential) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'A credential is required to reconnect — disconnect deliberately destroys the stored secret',
      });
    }
    if (opts.credential) c.credentials_ciphertext = this.encryption.encrypt(opts.credential);
    c.status = CONNECTION_STATUS.ACTIVE;
    c.deleted_at = null;
    c.consecutive_failures = 0;
    c.last_error = null;
    c.last_error_at = null;
    await this.connections.save(c);
    await this.audit.record(INTEGRATION_AUDIT_ACTION.CONNECTION_RECONNECT, tenantId, 'IntegrationConnection', id, actor, {
      credentialProvided: !!opts.credential,
    });
    const mappings = await this.idMap.retentionImpact(tenantId, c.id);
    return { reconnected: true, connectionId: c.id, mappings };
  }

  /**
   * What a HARD delete would destroy. Shown before confirming so the consequence
   * is explicit rather than discovered afterwards.
   */
  async purgeImpact(tenantId: string, id: string) {
    const c = await this.connections.findOne({ where: { id, tenant: { id: tenantId } } });
    if (!c) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Integration connection not found' });
    const mappings = await this.idMap.retentionImpact(tenantId, id);
    return {
      connectionId: id,
      status: c.status,
      /** Hard delete is only offered once the connection is already disconnected. */
      eligible: c.status === CONNECTION_STATUS.DISCONNECTED,
      ...mappings,
      /**
       * Import/sync/conflict/inbound history SURVIVES: those FKs are ON DELETE
       * SET NULL, so the runs remain readable with a null connection reference.
       * Mappings are ON DELETE CASCADE and are the real loss.
       */
      retains: ['import history', 'sync history', 'conflicts', 'inbound delivery history', 'audit log'],
      destroys: ['external-id mappings (active and historical)'],
    };
  }

  /**
   * HARD delete — permanently removes the connection row and CASCADES its
   * mappings. Deliberately gated: only a connection that is already
   * DISCONNECTED can be purged, so this can never be reached by a single
   * mis-click on a live integration. Requires the manage permission (enforced at
   * the controller) and is audited with its retention impact.
   */
  async purge(tenantId: string, id: string, actor: ConnectionActor): Promise<{ purged: true }> {
    const c = await this.connections.findOne({ where: { id, tenant: { id: tenantId } } });
    if (!c) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Integration connection not found' });
    if (c.status !== CONNECTION_STATUS.DISCONNECTED) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Only a disconnected connection can be permanently deleted — disconnect it first',
      });
    }
    const impact = await this.idMap.retentionImpact(tenantId, id);
    // Audit BEFORE the delete: afterwards the connection id no longer resolves.
    await this.audit.record(INTEGRATION_AUDIT_ACTION.CONNECTION_PURGE, tenantId, 'IntegrationConnection', id, actor, {
      ...impact,
      name: c.name,
      provider: c.provider,
    });
    await this.idMap.purgeForConnection(tenantId, id);
    await this.connections.delete({ id });
    this.logger.warn(`Integration connection ${id} PURGED for tenant ${tenantId}`);
    return { purged: true };
  }

  /**
   * Resolve an ACTIVE connection for the write/import pipeline. Rejects a
   * missing, deactivated, or disconnected connection so writes can never target
   * a dormant integration. Returns the entity (not a safe view) so the pipeline
   * can read its conflict policy.
   */
  async requireActive(tenantId: string, id: string): Promise<IntegrationConnection> {
    const c = await this.findOneOrThrow(tenantId, id);
    if (c.status !== CONNECTION_STATUS.ACTIVE) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'The integration connection is not active',
      });
    }
    return c;
  }

  /**
   * Record a successful communication checkpoint: resets the consecutive-failure
   * counter and clears the last error. Best-effort, never throws.
   */
  async markSuccess(id: string, latencyMs?: number): Promise<void> {
    await this.connections
      .update(
        { id },
        {
          last_success_at: new Date(),
          last_error: null,
          last_error_at: null,
          consecutive_failures: 0,
          ...(latencyMs !== undefined ? { last_latency_ms: Math.max(0, Math.round(latencyMs)) } : {}),
        },
      )
      .catch(() => undefined);
  }

  /**
   * Record a safe, truncated error summary and INCREMENT the consecutive-failure
   * counter (drives the degraded → offline transition). Deliberately does NOT
   * flip the connection status: a transient failure must degrade health, not
   * silently disable an active integration. Best-effort, never throws.
   */
  async markError(id: string, message: string): Promise<void> {
    await this.connections
      .createQueryBuilder()
      .update(IntegrationConnection)
      .set({
        last_error: message.slice(0, 500),
        last_error_at: new Date(),
        consecutive_failures: () => '"consecutive_failures" + 1',
      })
      .where('id = :id', { id })
      .execute()
      .catch(() => undefined);
  }

  conflictPolicyOf(connection: IntegrationConnection): ConflictPolicy {
    return connection.default_conflict_policy as ConflictPolicy;
  }

  /** Trusted provider registry + capabilities for the connection UI (no secrets). */
  listProviders() {
    return Object.values(INTEGRATION_PROVIDERS).map((p) => ({
      key: p.key,
      label: p.label,
      authTypes: p.authTypes,
      oauth: p.oauth,
      capabilities: this.providers.capabilitiesOf(p.key),
    }));
  }

  private async findOneOrThrow(tenantId: string, id: string): Promise<IntegrationConnection> {
    const c = await this.connections.findOne({ where: { id, tenant: { id: tenantId }, deleted_at: IsNull() } });
    if (!c) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Integration connection not found' });
    return c;
  }

  private assertCredentialConsistency(authType: string, credential?: string): void {
    const needsCredential = authType === CONNECTION_AUTH_TYPE.API_KEY || authType === CONNECTION_AUTH_TYPE.SECRET;
    if (needsCredential && credential !== undefined && credential.trim() === '') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'A credential is required for this authentication type',
      });
    }
  }

  private toSafe(c: IntegrationConnection): SafeConnection {
    const { credentials_ciphertext, ...rest } = c;
    return {
      ...rest,
      hasCredential: !!credentials_ciphertext,
      healthState: this.deriveHealthState(c),
    } as SafeConnection;
  }
}
