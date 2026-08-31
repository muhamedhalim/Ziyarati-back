import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';

import { ApiKey } from '../../entities/System/ApiKey';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { QueryApiKeysDto } from './dto/query-api-keys.dto';
import { generateApiKey, hashApiKey, keyPrefix } from './platform.constants';
import { assertScopesGrantable, normalizeScopes } from './integration-scopes.constants';
import { ApiKeyAuditService, API_KEY_AUDIT_ACTION } from './api-key-audit.service';

/** API key with the secret hash stripped — the shape returned to clients. */
export type SafeApiKey = Omit<ApiKey, 'key_hash'>;

/** The principal an authenticated API key resolves to. */
export interface AuthenticatedApiKey {
  keyId: string;
  tenantId: string | null;
  permissions: string[];
}

/** The acting user's identity + privilege, for scope-grant checks and audit metadata. */
export interface ApiKeyActor {
  userId?: string;
  /** Internal RBAC permission slugs the caller currently holds. */
  permissions: string[];
  isSuperAdmin: boolean;
  ip?: string;
}

/** Only refresh last_used_at at most this often (avoid a write per request). */
const LAST_USED_THROTTLE_MS = 60_000;

/**
 * API keys for external (machine-to-machine) integrations — tenant-owned.
 *
 * Tenant isolation: `api_keys` is tenant-scoped via the `tenant` relation; every
 * query filters `where: { tenant: { id: tenantId } }`. Secrets are stored HASHED
 * (`key_hash`, unique); the plaintext is returned ONCE on create/rotate and
 * never persisted or echoed again. `key_hash` is never serialized to clients.
 *
 * Lifecycle (schema has only `is_active` + `expires_at`, no status/revoked
 * column): deactivate → is_active=false (reversible); activate → is_active=true;
 * revoke → is_active=false AND expires_at=now (permanent — an activate cannot
 * resurrect an expired key).
 *
 * Scopes: `permissions` holds `integration.*` scope slugs (never internal RBAC
 * permissions — see integration-scopes.constants.ts). `create` rejects any
 * scope the caller doesn't themselves hold the underlying permission for, so a
 * key can never exceed its issuer's own access.
 *
 * Every mutating method records a best-effort audit row (ApiKeyAuditService).
 */
@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger('ApiKeyService');

  constructor(
    @InjectRepository(ApiKey)
    private readonly keys: Repository<ApiKey>,
    private readonly audit: ApiKeyAuditService,
  ) {}

  async create(
    tenantId: string,
    dto: CreateApiKeyDto,
    actor: ApiKeyActor,
  ): Promise<SafeApiKey & { apiKey: string }> {
    assertScopesGrantable(dto.permissions, actor.permissions, actor.isSuperAdmin);

    const { plaintext, hash } = generateApiKey();
    const scopes = normalizeScopes(dto.permissions);
    const saved = await this.keys.save(
      this.keys.create({
        tenant: { id: tenantId } as Tenant,
        name: dto.name,
        key_hash: hash,
        key_prefix: keyPrefix(plaintext),
        permissions: scopes,
        expires_at: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
        is_active: true,
      }),
    );
    this.logger.log(`API key ${saved.id} created for tenant ${tenantId}`);
    await this.audit.record(API_KEY_AUDIT_ACTION.CREATE, tenantId, actor.userId, saved.id, actor.ip, {
      name: dto.name ?? null,
      scopes,
      expiresAt: dto.expiresAt ?? null,
    });
    // Plaintext returned exactly once — it is never stored or retrievable later.
    return { ...this.toSafe(saved), apiKey: plaintext };
  }

  /** Issue a new secret for an existing key (same id/name/permissions). */
  async rotate(
    tenantId: string,
    id: string,
    actor: Pick<ApiKeyActor, 'userId' | 'ip'>,
  ): Promise<SafeApiKey & { apiKey: string }> {
    const key = await this.findOneOrThrow(tenantId, id);
    const { plaintext, hash } = generateApiKey();
    key.key_hash = hash;
    key.key_prefix = keyPrefix(plaintext);
    const saved = await this.keys.save(key);
    await this.audit.record(API_KEY_AUDIT_ACTION.ROTATE, tenantId, actor.userId, id, actor.ip);
    return { ...this.toSafe(saved), apiKey: plaintext };
  }

  /** Permanent disable: inactive + immediately expired. */
  async revoke(
    tenantId: string,
    id: string,
    actor: Pick<ApiKeyActor, 'userId' | 'ip'>,
  ): Promise<SafeApiKey> {
    const key = await this.findOneOrThrow(tenantId, id);
    key.is_active = false;
    key.expires_at = new Date();
    const saved = await this.keys.save(key);
    await this.audit.record(API_KEY_AUDIT_ACTION.REVOKE, tenantId, actor.userId, id, actor.ip);
    return this.toSafe(saved);
  }

  async activate(
    tenantId: string,
    id: string,
    actor: Pick<ApiKeyActor, 'userId' | 'ip'>,
  ): Promise<SafeApiKey> {
    const key = await this.findOneOrThrow(tenantId, id);
    key.is_active = true;
    const saved = await this.keys.save(key);
    await this.audit.record(API_KEY_AUDIT_ACTION.ACTIVATE, tenantId, actor.userId, id, actor.ip);
    return this.toSafe(saved);
  }

  async deactivate(
    tenantId: string,
    id: string,
    actor: Pick<ApiKeyActor, 'userId' | 'ip'>,
  ): Promise<SafeApiKey> {
    const key = await this.findOneOrThrow(tenantId, id);
    key.is_active = false;
    const saved = await this.keys.save(key);
    await this.audit.record(API_KEY_AUDIT_ACTION.DEACTIVATE, tenantId, actor.userId, id, actor.ip);
    return this.toSafe(saved);
  }

  async get(tenantId: string, id: string): Promise<SafeApiKey> {
    return this.toSafe(await this.findOneOrThrow(tenantId, id));
  }

  async list(tenantId: string, query: QueryApiKeysDto) {
    const where: FindOptionsWhere<ApiKey> = { tenant: { id: tenantId } };
    if (query.isActive !== undefined) where.is_active = query.isActive;

    const [rows, total] = await this.keys.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return {
      data: rows.map((k) => this.toSafe(k)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /**
   * Verify a PRESENTED plaintext key (the runtime auth path used by
   * ApiKeyAuthGuard). Constant-work hash lookup → active → not expired. Updates
   * `last_used_at` at most once per minute (throttled, fire-and-forget). Throws
   * UNAUTHORIZED for any failure so callers can't distinguish reasons.
   */
  async authenticate(plaintext: string | undefined): Promise<AuthenticatedApiKey> {
    if (!plaintext || typeof plaintext !== 'string') {
      throw new AppError(ErrorCode.UNAUTHORIZED, { message: 'API key required' });
    }
    // P5-2 (015-db-api-efficiency-audit, AUTH-006): the guard's synthetic
    // principal only ever reads `key.tenant?.id`, so loading the full Tenant
    // relation cost a second round trip for one column. No entity exposes the
    // FK as a plain property (research.md R-11), so the id is read via the
    // quoted join-column name resolved from entity metadata — the same
    // pattern DashboardSummaryService.fk() uses. No joins at all here, so
    // this was already a single query without `relations`; dropping it just
    // removes the one it no longer needs.
    const tenantFk = this.fk(this.keys, 'tenant');
    const { entities, raw } = await this.keys
      .createQueryBuilder('k')
      .addSelect(`k."${tenantFk}"`, 'tenant_fk')
      .where('k.key_hash = :hash', { hash: hashApiKey(plaintext) })
      .getRawAndEntities();
    const key = entities[0];
    if (!key || !key.is_active) {
      throw new AppError(ErrorCode.UNAUTHORIZED, { message: 'Invalid or inactive API key' });
    }
    if (key.expires_at && key.expires_at.getTime() <= Date.now()) {
      throw new AppError(ErrorCode.UNAUTHORIZED, { message: 'API key has expired' });
    }

    const now = Date.now();
    if (!key.last_used_at || now - key.last_used_at.getTime() > LAST_USED_THROTTLE_MS) {
      void this.keys.update({ id: key.id }, { last_used_at: new Date() }).catch(() => undefined);
    }

    return {
      keyId: key.id,
      tenantId: (raw[0]?.tenant_fk as string | null) ?? null,
      // Legacy/junk-safe: only recognised scope strings ever reach the principal.
      permissions: normalizeScopes(key.permissions),
    };
  }

  /** Resolves `property`'s join-column database name from entity metadata — no
   *  entity exposes a relation's FK as a plain property (research.md R-11). */
  private fk(repo: Repository<ApiKey>, property: string): string {
    const relation = repo.metadata.findRelationWithPropertyPath(property);
    const column = relation?.joinColumns[0]?.databaseName;
    if (!column) {
      throw new Error(
        `${repo.metadata.name}.${property} has no join column`,
      );
    }
    return column;
  }

  private async findOneOrThrow(tenantId: string, id: string): Promise<ApiKey> {
    const key = await this.keys.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!key) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'API key not found' });
    }
    return key;
  }

  /** Strip the secret hash before returning a key to any client; normalize legacy/junk scopes. */
  private toSafe(key: ApiKey): SafeApiKey {
    const { key_hash, ...safe } = key;
    void key_hash;
    return { ...safe, permissions: normalizeScopes(safe.permissions) };
  }
}
