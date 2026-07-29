import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { IntegrationOAuthState } from '../../../entities/Integration/IntegrationOAuthState';
import { IntegrationConnection } from '../../../entities/Integration/IntegrationConnection';
import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { User } from '../../../entities/Auth&RBAC/User';
import { AppError, ErrorCode } from '../../../common/errors';
import { EncryptionService } from '../../../common/crypto/encryption.service';
import { DistributedLockService } from '../../../queue/distributed-lock.service';

import { CONNECTION_STATUS } from '../integration-platform.constants';
import {
  IntegrationAuditService,
  INTEGRATION_AUDIT_ACTION,
} from '../integration-audit.service';
import {
  isTestOAuthEnabled,
  oauthProviderKeys,
  resolveOAuthAdapter,
} from './oauth.registry';
import {
  OAuthInvalidGrantError,
  OAuthTokenSet,
  codeChallengeS256,
  generateCodeVerifier,
  generateState,
} from './oauth.types';

interface Actor {
  userId?: string;
  ip?: string;
}

/** How long an authorization handshake may stay open. */
const STATE_TTL_MS = 10 * 60 * 1000;
/** Refresh this long before actual expiry, so a request never races the clock. */
const REFRESH_SKEW_MS = 60 * 1000;
/**
 * How long one worker may hold the refresh lock before it must renew — sized
 * well above a normal provider round trip; the lock is renewed on a timer
 * while the critical section runs (see `withRefreshLock`), so this bounds
 * "how long a crashed holder blocks everyone else," not "how long a refresh
 * may take."
 */
const REFRESH_LOCK_TTL_SECONDS = 30;
const REFRESH_LOCK_TTL_MS = REFRESH_LOCK_TTL_SECONDS * 1000;

/**
 * OAuth2 Authorization-Code + PKCE CLIENT (Phase 4).
 *
 * NOT an authorization server: nothing here issues codes or tokens for the
 * platform itself. It drives the handshake against a provider whose endpoints
 * come exclusively from compiled/backend configuration.
 *
 * Security properties, and where each is enforced:
 *
 *  - PKCE          verifier generated per handshake, stored server-side, only
 *                  its S256 challenge leaves the process.
 *  - CSRF          `state` is server-generated, DB-UNIQUE, and consumed exactly
 *                  once — a replayed callback finds it used and is refused.
 *  - Expiry        a handshake older than STATE_TTL_MS is refused and swept.
 *  - Redirect URI  matched EXACTLY against the provider's compiled allowlist.
 *                  Never taken from the request, so there is no open redirect.
 *  - Ownership     the state row carries tenant + connection; the callback is
 *                  re-validated against both, so one tenant's callback can never
 *                  complete another tenant's connection.
 *  - Storage       access/refresh tokens are encrypted at rest and never
 *                  serialized — the API exposes presence and expiry only.
 *  - Rotation      a refresh replaces the stored refresh token with the newly
 *                  issued one; the old value is discarded.
 *  - Locking       a real Redis lock (`SET NX PX` + ownership token + renewal,
 *                  via `DistributedLockService`) serialises concurrent
 *                  refreshes, so two workers cannot both redeem the same
 *                  (single-use) refresh token and invalidate each other's
 *                  grant — see docs/CACHING_QUEUES_AUDIT.md H11 (previously a
 *                  rate-limiter-as-mutex with no ownership or renewal).
 *  - invalid_grant treated as terminal: stored tokens are cleared and the
 *                  connection is marked as needing reconnection, instead of
 *                  retrying a grant the provider has already killed.
 */
@Injectable()
export class IntegrationOAuthService {
  private readonly logger = new Logger(IntegrationOAuthService.name);

  constructor(
    @InjectRepository(IntegrationOAuthState)
    private readonly states: Repository<IntegrationOAuthState>,
    @InjectRepository(IntegrationConnection)
    private readonly connections: Repository<IntegrationConnection>,
    private readonly encryption: EncryptionService,
    private readonly audit: IntegrationAuditService,
    private readonly locks: DistributedLockService,
  ) {}

  /** Providers currently offering OAuth. Empty in production until one is configured. */
  listProviders() {
    return {
      enabled: isTestOAuthEnabled(),
      providers: oauthProviderKeys().map((key) => {
        const adapter = resolveOAuthAdapter(key);
        return {
          key,
          label: adapter?.config.label ?? key,
          scopes: adapter?.config.scopes ?? [],
          supportsRefresh: adapter?.config.supportsRefresh ?? false,
          supportsRevocation: adapter?.config.supportsRevocation ?? false,
          isTestProvider: adapter?.config.isTestProvider ?? false,
        };
      }),
    };
  }

  /**
   * Begin a handshake: returns the provider authorization URL to send the admin
   * to. The verifier stays here; only the challenge travels.
   */
  async authorize(tenantId: string, connectionId: string, actor: Actor) {
    const connection = await this.ownedConnection(tenantId, connectionId);
    const adapter = this.adapterOrThrow(connection.provider);

    // Redirect URI comes from the compiled allowlist — never from the request.
    const redirectUri = adapter.config.redirectUris[0];
    if (!redirectUri) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'No redirect URI is configured for this provider',
      });
    }

    const verifier = generateCodeVerifier();
    const state = generateState();
    await this.states.save(
      this.states.create({
        tenant: { id: tenantId } as Tenant,
        connection: { id: connectionId } as IntegrationConnection,
        state,
        code_verifier: verifier,
        provider: connection.provider,
        redirect_uri: redirectUri,
        expires_at: new Date(Date.now() + STATE_TTL_MS),
        initiated_by: actor.userId ? ({ id: actor.userId } as User) : null,
      }),
    );

    const url = new URL(adapter.config.authorizationUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.clientId(connection.provider));
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', adapter.config.scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallengeS256(verifier));
    url.searchParams.set('code_challenge_method', 'S256');

    await this.audit.record(
      INTEGRATION_AUDIT_ACTION.OAUTH_AUTHORIZE,
      tenantId,
      'IntegrationConnection',
      connectionId,
      actor,
      { provider: connection.provider },
    );
    return {
      authorizationUrl: url.toString(),
      state,
      expiresInSeconds: STATE_TTL_MS / 1000,
    };
  }

  /**
   * Complete the handshake. Validates state (existence, ownership, expiry,
   * single use), then exchanges the code with the PKCE verifier and stores the
   * encrypted tokens.
   */
  async callback(
    tenantId: string,
    params: { state: string; code?: string; error?: string },
    actor: Actor,
  ) {
    const row = await this.states.findOne({
      where: { state: params.state },
      relations: { tenant: true, connection: true },
    });
    if (!row) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: 'Unknown or already-used authorization state',
      });
    }
    // OWNERSHIP: the state must belong to the tenant completing it.
    if ((row.tenant as Tenant)?.id !== tenantId) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: 'This authorization does not belong to your clinic',
      });
    }
    if (row.consumed_at) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: 'This authorization state has already been used',
      });
    }
    if (row.expires_at.getTime() < Date.now()) {
      await this.states.delete({ id: row.id });
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'This authorization expired — start the connection again',
      });
    }

    // SINGLE USE, atomically: only the caller whose UPDATE matches proceeds, so
    // two concurrent callbacks with the same state cannot both redeem the code.
    const claim = await this.states
      .createQueryBuilder()
      .update(IntegrationOAuthState)
      .set({ consumed_at: new Date() })
      .where('id = :id', { id: row.id })
      .andWhere('consumed_at IS NULL')
      .execute();
    if ((claim.affected ?? 0) === 0) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: 'This authorization state has already been used',
      });
    }

    const connectionId = row.connection?.id as string;

    // The user declined, or the provider refused. Not an error state to retry.
    if (params.error || !params.code) {
      await this.audit.record(
        INTEGRATION_AUDIT_ACTION.OAUTH_CALLBACK_FAILED,
        tenantId,
        'IntegrationConnection',
        connectionId,
        actor,
        { provider: row.provider, reason: params.error ?? 'missing_code' },
      );
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Authorization was not completed',
        publicContext: { reason: params.error ?? 'missing_code' },
      });
    }

    const connection = await this.ownedConnection(tenantId, connectionId);
    const adapter = this.adapterOrThrow(row.provider);

    let tokens: OAuthTokenSet;
    try {
      tokens = await adapter.exchangeCode({
        code: params.code,
        codeVerifier: row.code_verifier,
        redirectUri: row.redirect_uri,
      });
    } catch {
      await this.audit.record(
        INTEGRATION_AUDIT_ACTION.OAUTH_CALLBACK_FAILED,
        tenantId,
        'IntegrationConnection',
        connectionId,
        actor,
        { provider: row.provider, reason: 'token_exchange_failed' },
      );
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'The provider rejected this authorization — start the connection again',
      });
    } finally {
      // The verifier is single-use; do not keep it around after redemption.
      await this.states.delete({ id: row.id }).catch(() => undefined);
    }

    await this.storeTokens(connection, tokens);
    await this.audit.record(
      INTEGRATION_AUDIT_ACTION.OAUTH_CONNECTED,
      tenantId,
      'IntegrationConnection',
      connectionId,
      actor,
      { provider: row.provider, scope: tokens.scope ?? null },
    );
    return this.tokenView(await this.reload(connection.id));
  }

  /**
   * A valid access token, refreshing first when it is expired or about to be.
   * Concurrency-locked so two callers cannot both redeem the same single-use
   * refresh token and kill each other's grant.
   */
  async getAccessToken(
    tenantId: string,
    connectionId: string,
  ): Promise<string> {
    const connection = await this.ownedConnection(tenantId, connectionId);
    if (!connection.oauth_access_token_ciphertext) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'This connection is not connected to the provider yet',
      });
    }
    const expiresAt = connection.oauth_expires_at?.getTime() ?? null;
    if (expiresAt === null || expiresAt - REFRESH_SKEW_MS > Date.now()) {
      return this.decrypt(connection.oauth_access_token_ciphertext);
    }
    const refreshed = await this.refresh(tenantId, connectionId, {
      userId: undefined,
    });
    return refreshed.accessToken;
  }

  /**
   * Refresh the access token, ROTATING the refresh token. Serialised by a real
   * Redis lock (ownership token + renewal — see `runUnderRefreshLock`); a
   * caller that loses the lock re-reads the token the winner just stored
   * rather than redeeming the (now dead) refresh token a second time.
   */
  async refresh(
    tenantId: string,
    connectionId: string,
    actor: Actor,
  ): Promise<{ accessToken: string }> {
    const connection = await this.ownedConnection(tenantId, connectionId);
    const adapter = this.adapterOrThrow(connection.provider);
    if (
      !adapter.config.supportsRefresh ||
      !connection.oauth_refresh_token_ciphertext
    ) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'This connection has no refresh token — reconnect to the provider',
      });
    }

    const lockKey = `oauth:refresh:${tenantId}:${connectionId}`;
    const locked = await this.runUnderRefreshLock(lockKey, async () => {
      // Re-read under the lock: the winner may have refreshed while we queued.
      const current = await this.reload(connectionId);
      const expiresAt = current.oauth_expires_at?.getTime() ?? 0;
      if (
        current.oauth_access_token_ciphertext &&
        expiresAt - REFRESH_SKEW_MS > Date.now()
      ) {
        return {
          accessToken: this.decrypt(current.oauth_access_token_ciphertext),
        };
      }

      const refreshToken = this.decrypt(
        current.oauth_refresh_token_ciphertext as string,
      );
      let tokens: OAuthTokenSet;
      try {
        tokens = await adapter.refresh({ refreshToken });
      } catch (err) {
        if (err instanceof OAuthInvalidGrantError) {
          // TERMINAL: the provider killed this grant. Clear the dead tokens so
          // nothing retries them, and surface "reconnect" rather than a retry.
          await this.clearTokens(current);
          await this.audit.record(
            INTEGRATION_AUDIT_ACTION.OAUTH_REFRESH_FAILED,
            tenantId,
            'IntegrationConnection',
            connectionId,
            actor,
            {
              provider: current.provider,
              reason: 'invalid_grant',
              tokensCleared: true,
            },
          );
          throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
            message:
              'The provider revoked this connection — reconnect to restore it',
          });
        }
        throw err;
      }

      await this.storeTokens(current, tokens, { refreshed: true });
      await this.audit.record(
        INTEGRATION_AUDIT_ACTION.OAUTH_REFRESHED,
        tenantId,
        'IntegrationConnection',
        connectionId,
        actor,
        { provider: current.provider, rotated: !!tokens.refreshToken },
      );
      return { accessToken: tokens.accessToken };
    });

    if (locked.acquired) return locked.value;

    // Someone else is refreshing. Wait briefly, then use whatever they stored.
    await sleep(750);
    const fresh = await this.reload(connectionId);
    if (fresh.oauth_access_token_ciphertext) {
      return { accessToken: this.decrypt(fresh.oauth_access_token_ciphertext) };
    }
    throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, {
      message: 'A token refresh is already in progress — retry shortly',
    });
  }

  /**
   * Disconnect: revoke at the provider when supported, then clear local tokens.
   * Revocation is BEST-EFFORT — a provider outage must never leave a tenant
   * unable to disconnect, and the local tokens are destroyed regardless.
   */
  async disconnect(tenantId: string, connectionId: string, actor: Actor) {
    const connection = await this.ownedConnection(tenantId, connectionId);
    const adapter = resolveOAuthAdapter(connection.provider);
    let revoked = false;

    if (adapter?.revoke && adapter.config.supportsRevocation) {
      const token =
        connection.oauth_refresh_token_ciphertext ??
        connection.oauth_access_token_ciphertext;
      if (token) {
        try {
          await adapter.revoke({ token: this.decrypt(token) });
          revoked = true;
        } catch (e) {
          this.logger.warn(
            `oauth revoke failed for ${connectionId}: ${(e as Error)?.message}`,
          );
        }
      }
    }

    await this.clearTokens(connection);
    await this.states
      .delete({ connection: { id: connectionId } })
      .catch(() => undefined);
    await this.audit.record(
      INTEGRATION_AUDIT_ACTION.OAUTH_DISCONNECTED,
      tenantId,
      'IntegrationConnection',
      connectionId,
      actor,
      { provider: connection.provider, revokedAtProvider: revoked },
    );
    return { disconnected: true, revokedAtProvider: revoked };
  }

  /** Token STATUS — presence and expiry only. Never a token value. */
  async status(tenantId: string, connectionId: string) {
    return this.tokenView(await this.ownedConnection(tenantId, connectionId));
  }

  /** Sweep expired/consumed handshakes so verifiers never linger. */
  async purgeExpiredStates(now: Date = new Date()): Promise<number> {
    const res = await this.states
      .createQueryBuilder()
      .delete()
      .from(IntegrationOAuthState)
      .where('expires_at < :now', { now })
      .execute()
      .catch(() => ({ affected: 0 }) as { affected?: number | null });
    return res.affected ?? 0;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Tenant-scoped connection lookup — the cross-tenant guard for every method. */
  private async ownedConnection(
    tenantId: string,
    id: string,
  ): Promise<IntegrationConnection> {
    const c = await this.connections.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!c)
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Integration connection not found',
      });
    if (c.status === CONNECTION_STATUS.DISCONNECTED) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'This connection is disconnected',
      });
    }
    return c;
  }

  private reload(id: string): Promise<IntegrationConnection> {
    return this.connections.findOneOrFail({ where: { id } });
  }

  private adapterOrThrow(providerKey: string) {
    const adapter = resolveOAuthAdapter(providerKey);
    if (!adapter) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `OAuth is not available for provider "${providerKey}"`,
      });
    }
    return adapter;
  }

  /** Client id from trusted backend config only — never tenant input. */
  private clientId(providerKey: string): string {
    const key = `INTEGRATION_OAUTH_${providerKey.toUpperCase()}_CLIENT_ID`;
    return process.env[key] ?? 'test-client-id';
  }

  private async storeTokens(
    connection: IntegrationConnection,
    tokens: OAuthTokenSet,
    opts: { refreshed?: boolean } = {},
  ): Promise<void> {
    // Typed loosely on purpose: TypeORM's QueryDeepPartialEntity rejects the
    // entity's `jsonb` index-signature column, which this patch never touches.
    const patch: Record<string, unknown> = {
      oauth_access_token_ciphertext: this.encryption.encrypt(
        tokens.accessToken,
      ),
      oauth_expires_at: tokens.expiresIn
        ? new Date(Date.now() + tokens.expiresIn * 1000)
        : null,
      oauth_scope: tokens.scope ?? null,
    };
    // ROTATION: replace the stored refresh token whenever the provider issues a
    // new one. A provider that omits it keeps the existing token (per RFC 6749).
    if (tokens.refreshToken) {
      patch.oauth_refresh_token_ciphertext = this.encryption.encrypt(
        tokens.refreshToken,
      );
    }
    if (opts.refreshed) patch.oauth_refreshed_at = new Date();
    else patch.oauth_connected_at = new Date();
    await this.connections.update({ id: connection.id }, patch as never);
  }

  private async clearTokens(connection: IntegrationConnection): Promise<void> {
    await this.connections.update(
      { id: connection.id },
      {
        oauth_access_token_ciphertext: null,
        oauth_refresh_token_ciphertext: null,
        oauth_expires_at: null,
        oauth_scope: null,
        oauth_connected_at: null,
        oauth_refreshed_at: null,
      },
    );
  }

  private decrypt(ciphertext: string): string {
    try {
      return this.encryption.decrypt(ciphertext);
    } catch {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'Stored provider tokens could not be read — reconnect to the provider',
      });
    }
  }

  /**
   * Runs `fn` under a real distributed lock (`SET NX PX` + ownership token,
   * via `DistributedLockService` — see docs/CACHING_QUEUES_AUDIT.md H11).
   * Replaces the previous rate-limiter-as-mutex, which had no ownership token
   * and a no-op release: a refresh taking longer than its fixed window let the
   * bucket refill and a second worker "acquire" the lock while the first was
   * still in flight, which could redeem the same single-use refresh token
   * twice and invalidate the grant.
   *
   * The lock is renewed on a timer (half the TTL) for the duration of `fn`, so
   * a refresh that runs long does not lose the lock out from under it, and is
   * always released (or left to self-expire on a crash) in a `finally`.
   *
   * Failing to acquire (Redis unavailable, or genuinely held by another
   * worker) returns `{ acquired: false }` — never fabricates success. Guessing
   * "proceed" is what would let two workers redeem the same single-use
   * refresh token and invalidate each other's grant.
   */
  private async runUnderRefreshLock<T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<{ acquired: true; value: T } | { acquired: false }> {
    const token = await this.locks.acquire(key, REFRESH_LOCK_TTL_MS);
    if (!token) return { acquired: false };

    const renewTimer = setInterval(() => {
      this.locks.renew(key, token, REFRESH_LOCK_TTL_MS).catch(() => undefined);
    }, REFRESH_LOCK_TTL_MS / 2);
    // Never let the renewal timer itself keep the process alive.
    renewTimer.unref?.();

    try {
      const value = await fn();
      return { acquired: true, value };
    } finally {
      clearInterval(renewTimer);
      await this.locks.release(key, token);
    }
  }

  /** Safe projection — presence and expiry only. NEVER a token value. */
  private tokenView(c: IntegrationConnection) {
    const expiresAt = c.oauth_expires_at ?? null;
    return {
      connectionId: c.id,
      provider: c.provider,
      connected: !!c.oauth_access_token_ciphertext,
      hasRefreshToken: !!c.oauth_refresh_token_ciphertext,
      expiresAt,
      expired: expiresAt ? expiresAt.getTime() <= Date.now() : false,
      scope: c.oauth_scope ?? null,
      connectedAt: c.oauth_connected_at ?? null,
      refreshedAt: c.oauth_refreshed_at ?? null,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
