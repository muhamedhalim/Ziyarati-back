import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Unique,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { UserRole } from '../Auth&RBAC/UserRole';
import { RefreshToken } from '../Auth&RBAC/RefreshToken';

@Entity('users')
@Unique(['tenant', 'email'])
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, { nullable: true })
  tenant?: Tenant;

  @Column({ nullable: true })
  email?: string;

  @Column({ nullable: true })
  phone?: string;

  // Never included in a default SELECT (`findOne`/`find` without an explicit
  // `select` naming it) — callers that legitimately need it for a bcrypt
  // compare must opt in explicitly (see AuthService.validateCredentials /
  // changePassword). Prevents it leaking into any response that serializes a
  // loaded User, directly or via a relation (e.g. HandoverRequest.assigned_to).
  @Column({ nullable: true, select: false })
  password_hash?: string;

  @Column({ nullable: true })
  full_name?: string;

  @Column({ type: 'text', nullable: true })
  avatar_url?: string;

  @Column({ default: true })
  is_active!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  last_login_at?: Date;

  @OneToMany(() => UserRole, (userRole) => userRole.user)
  userRoles!: UserRole[];

  @OneToMany(() => RefreshToken, (token) => token.user)
  refreshTokens!: RefreshToken[];

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at?: Date;

  @DeleteDateColumn()
  deleted_at?: Date;
}