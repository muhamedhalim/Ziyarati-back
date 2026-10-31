import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from './User';

/** Single-use recovery code for a user's MFA. Only a hash is stored. */
@Entity('user_mfa_recovery_codes')
export class UserMfaRecoveryCode {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Mirrors FK_user_mfa_recovery_user (migration 1730140000000). Declared on the
  // entity so the tenant-offboarding planner reaches this table through users.
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Index()
  @Column({ type: 'uuid', name: 'user_id' })
  user_id!: string;

  @Column({ type: 'text' })
  code_hash!: string;

  @Column({ type: 'timestamptz', nullable: true })
  used_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
