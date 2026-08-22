import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { User } from '../Auth&RBAC/User';

@Entity('refresh_tokens')
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => User, {
    onDelete: 'CASCADE',
  })
  user!: User;

  @Column()
  token_hash!: string;

  /**
   * AUTH-002 — the rotation family this token belongs to. A fresh login starts
   * its own family (`family_id = id`); every rotation child inherits its
   * parent's value, so one family is exactly one device's session chain.
   *
   * This is what lets reuse detection revoke ONLY the compromised chain
   * (`revokeFamily`) instead of every session the user has anywhere, which is
   * what the pre-fix `revokeAllForUser` response did — see
   * docs/AUTH_CONCURRENCY_GC_AUDIT.md, AUTH-002/AUTH-003.
   */
  @Column({ type: 'uuid' })
  family_id!: string;

  /** The row this token was rotated FROM. NULL for a login (family root). Forensics only. */
  @Column({ type: 'uuid', nullable: true })
  parent_id?: string | null;

  /**
   * The row this token was rotated INTO. Written ATOMICALLY by the same
   * conditional UPDATE that revokes this row (AUTH-001), so a concurrent loser
   * can never observe "revoked but no successor yet" and misread it as reuse.
   * Also the anchor for the bounded retry window: a client whose response was
   * lost presents this (already-revoked) token again, and the successor is
   * where the retry resumes.
   */
  @Column({ type: 'uuid', nullable: true })
  replaced_by_id?: string | null;

  /** When this row was rotated away. NULL means it was never rotated (still live, logged out, or expired). */
  @Column({ type: 'timestamptz', nullable: true })
  rotated_at?: Date | null;

  /**
   * How many times the bounded retry window has been used against this row.
   * Capped by `AUTH_REFRESH_MAX_RETRIES` so a grace window can never become an
   * unlimited replay window.
   */
  @Column({ type: 'int', default: 0 })
  retry_count!: number;

  @Column({
    type: 'text',
    nullable: true,
  })
  device_info?: string;

  @Column({
    nullable: true,
  })
  ip_address?: string;

  @Column({
    type: 'timestamptz',
  })
  expires_at!: Date;

  @Column({
    type: 'timestamptz',
    nullable: true,
  })
  revoked_at?: Date;

  @CreateDateColumn()
  created_at!: Date;
}
