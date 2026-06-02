import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';
import { UserRole } from '../Auth&RBAC/UserRole';
import { RefreshToken } from '../Auth&RBAC/RefreshToken';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, { nullable: true })
  tenant?: Tenant;

  @Column({ nullable: true })
  email?: string;

  @Column({ nullable: true })
  phone?: string;

  @Column({ nullable: true })
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