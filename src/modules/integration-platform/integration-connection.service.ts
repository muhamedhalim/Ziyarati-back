import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, IsNull, Repository } from 'typeorm';

import { IntegrationConnection } from '../../entities/Integration/IntegrationConnection';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';
import { EncryptionService } from '../../common/crypto/encryption.service';

import { CreateConnectionDto } from './dto/create-connection.dto';
import { UpdateConnectionDto } from './dto/update-connection.dto';
import { QueryConnectionsDto } from './dto/query-connections.dto';
import {
  CONNECTION_AUTH_TYPE,
  CONNECTION_STATUS,
  ConflictPolicy,
  getProvider,
} from './integration-platform.constants';
import { IntegrationAuditService, INTEGRATION_AUDIT_ACTION } from './integration-audit.service';

/** Connection with the encrypted credential stripped — the shape returned to clients. */
export type SafeConnection = Omit<IntegrationConnection, 'credentials_ciphertext'> & {
  hasCredential: boolean;
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

  /** Lightweight health/status snapshot (no credential, no internal detail). */
  async health(tenantId: string, id: string) {
    const c = await this.findOneOrThrow(tenantId, id);
    return {
      id: c.id,
      status: c.status,
      healthy: c.status === CONNECTION_STATUS.ACTIVE && !c.last_error,
      lastSuccessAt: c.last_success_at ?? null,
      lastError: c.last_error ?? null,
      lastErrorAt: c.last_error_at ?? null,
      syncDirection: c.sync_direction,
    };
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

  async setActive(tenantId: string, id: string, active: boolean, actor: ConnectionActor): Promise<SafeConnection> {
    const c = await this.findOneOrThrow(tenantId, id);
    if (c.status === CONNECTION_STATUS.DISCONNECTED) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'A disconnected connection cannot be re-activated; create a new one',
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

  /** Record a successful sync/import checkpoint. Best-effort, never throws. */
  async markSuccess(id: string): Promise<void> {
    await this.connections
      .update({ id }, { last_success_at: new Date(), last_error: null, last_error_at: null })
      .catch(() => undefined);
  }

  /** Record a safe, truncated error summary. Best-effort, never throws. */
  async markError(id: string, message: string): Promise<void> {
    await this.connections
      .update({ id }, { status: CONNECTION_STATUS.ERROR, last_error: message.slice(0, 500), last_error_at: new Date() })
      .catch(() => undefined);
  }

  conflictPolicyOf(connection: IntegrationConnection): ConflictPolicy {
    return connection.default_conflict_policy as ConflictPolicy;
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
    return { ...rest, hasCredential: !!credentials_ciphertext } as SafeConnection;
  }
}
