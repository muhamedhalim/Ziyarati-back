import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { User } from '../Auth&RBAC/User';

@Entity('password_resets')
export class PasswordReset {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => User, {
    onDelete: 'CASCADE',
  })
  user!: User;

  @Column()
  token_hash!: string;

  @Column({
    type: 'timestamptz',
  })
  expires_at!: Date;

  @Column({
    type: 'timestamptz',
    nullable: true,
  })
  used_at?: Date;

  @CreateDateColumn()
  created_at!: Date;
}