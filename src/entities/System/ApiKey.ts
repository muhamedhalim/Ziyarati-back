import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';

@Entity('api_keys')
export class ApiKey {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, { nullable: true })
  tenant?: Tenant; // NULL = platform-level key

  @Column({ type: 'varchar', length: 100, nullable: true })
  name?: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  key_hash!: string;

  /** First few characters of the plaintext (e.g. `zk_AbCdEfGh`) — safe to
   *  display so an owner can tell keys apart without ever storing/re-showing
   *  the full secret. Nullable: rows created before this column existed. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  key_prefix?: string;

  /**
   * Integration scopes granted to this key (see integration-scopes.constants
   * .ts) — NOT internal RBAC permission slugs. Free-form jsonb for schema
   * stability, but every write path validates values against the
   * INTEGRATION_SCOPES allowlist before saving.
   */
  @Column({ type: 'jsonb', nullable: true })
  permissions?: any;

  @Column({ type: 'timestamptz', nullable: true })
  last_used_at?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  expires_at?: Date;

  @Column({ default: true })
  is_active!: boolean;

  @CreateDateColumn()
  created_at!: Date;
}