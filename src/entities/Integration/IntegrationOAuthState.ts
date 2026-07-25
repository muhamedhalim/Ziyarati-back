import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { User } from '../Auth&RBAC/User';
import { IntegrationConnection } from './IntegrationConnection';

/**
 * One in-flight OAuth2 Authorization-Code + PKCE handshake (Phase 4).
 *
 * The platform is the OAuth CLIENT here — it is not, and must not become, an
 * authorization server. This row exists so the callback can be validated against
 * something the platform itself created:
 *
 *  - `state` is the CSRF token. It is generated server-side, stored UNIQUE, and
 *    consumed exactly once (`consumed_at`) — a replayed callback finds it
 *    already used and is refused.
 *  - `code_verifier` is the PKCE secret. It never leaves the backend; only its
 *    S256 challenge is sent to the provider, so intercepting the redirect is not
 *    enough to redeem the code.
 *  - `expires_at` bounds the handshake, so a state token cannot be banked and
 *    replayed weeks later.
 *  - `redirect_uri` is recorded as issued and re-sent verbatim at token
 *    exchange. It always comes from trusted backend configuration, never from
 *    tenant input, so there is no open-redirect surface.
 *
 * The verifier is a short-lived, single-use secret rather than a stored
 * credential; the row is deleted once consumed or expired.
 */
@Entity('integration_oauth_states')
@Index('IX_integration_oauth_states_tenant', ['tenant'])
export class IntegrationOAuthState {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, { nullable: false, onDelete: 'CASCADE' })
  tenant!: Tenant;

  @ManyToOne(() => IntegrationConnection, { nullable: false, onDelete: 'CASCADE' })
  connection!: IntegrationConnection;

  /** CSRF token — UNIQUE, single-use (see the migration). */
  @Column({ type: 'varchar', length: 128 })
  state!: string;

  /** PKCE verifier. Backend-only; never sent to the provider or any client. */
  @Column({ type: 'varchar', length: 128 })
  code_verifier!: string;

  /** Provider key from the trusted compiled registry. */
  @Column({ type: 'varchar', length: 60 })
  provider!: string;

  /** Redirect URI as issued — re-sent verbatim at token exchange. */
  @Column({ type: 'text' })
  redirect_uri!: string;

  /** Set when redeemed. A second callback with the same state is refused. */
  @Column({ type: 'timestamptz', nullable: true })
  consumed_at?: Date | null;

  @Column({ type: 'timestamptz' })
  expires_at!: Date;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  initiated_by?: User | null;

  @CreateDateColumn()
  created_at!: Date;
}
