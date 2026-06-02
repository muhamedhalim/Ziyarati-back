import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';
import { User } from '../Auth&RBAC/User';

@Entity('file_uploads')
@Index(['tenant', 'created_at'])
export class FileUpload {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => User, { nullable: true })
  uploaded_by?: User;

  @Column({ type: 'varchar', length: 255, nullable: true })
  file_name?: string;

  @Column({ type: 'text', nullable: true })
  file_url?: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  file_type?: string;

  @Column({ type: 'bigint', nullable: true })
  file_size?: number;

  @CreateDateColumn()
  created_at!: Date;
}