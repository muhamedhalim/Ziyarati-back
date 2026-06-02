import {
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  Unique,
} from 'typeorm';

import { Role } from '../Auth&RBAC/Role';
import { Permission } from '../Auth&RBAC/Permission';

@Entity('role_permissions')
@Unique(['role', 'permission'])
export class RolePermission {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Role, {
    onDelete: 'CASCADE',
  })
  role!: Role;

  @ManyToOne(() => Permission, {
    onDelete: 'CASCADE',
  })
  permission!: Permission;
}