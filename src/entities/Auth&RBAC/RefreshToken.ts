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