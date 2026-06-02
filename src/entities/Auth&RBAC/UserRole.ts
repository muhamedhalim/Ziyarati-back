import {
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  CreateDateColumn,
  Unique,
} from 'typeorm';

import { User } from '../Auth&RBAC/User';
import { Role } from '../Auth&RBAC/Role';

@Entity('user_roles')
@Unique(['user', 'role'])
export class UserRole {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => User, {
    onDelete: 'CASCADE',
  })
  user!: User;

  @ManyToOne(() => Role, {
    onDelete: 'CASCADE',
  })
  role!: Role;

  @CreateDateColumn()
  assigned_at!: Date;
}