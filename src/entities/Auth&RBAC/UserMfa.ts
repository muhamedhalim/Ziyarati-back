import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from './User';

/**
 * TOTP second factor for one user (P0.5 / TSF-03). The seed is stored
 * AES-256-GCM encrypted (`EncryptionService`), never plaintext. `enabled`
 * flips true only after the user proves possession with a first valid code.
 * `last_used_step` is the RFC 6238 time-step of the last accepted code, so a
 * captured code cannot be replayed inside its validity window.
 */
@Entity('user_mfa')
export class UserMfa {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'uuid', name: 'user_id', unique: true })
  user_id!: string;

  @Column({ type: 'text' })
  secret_enc!: string;

  @Column({ type: 'boolean', default: false })
  enabled!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  enrolled_at!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  last_used_step!: string | null;

  @Column({ type: 'int', default: 0 })
  failed_attempts!: number;

  @Column({ type: 'timestamptz', nullable: true })
  locked_until!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
