import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
} from 'typeorm';

/**
 * External B2C patient (booking user).
 *
 * Deliberately standalone: NO tenant relation, NO roles/permissions. Patients
 * live in their own table and never participate in the RBAC / multi-tenant
 * model — which is exactly why they can never leak into `buildAuthenticatedUser`
 * (that query only touches `users`).
 */
@Entity('patients')
@Index(['email'], { unique: true })
export class Patient {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  email!: string;

  @Column({ nullable: true })
  phone?: string;

  @Column()
  password_hash!: string;

  @Column({ nullable: true })
  full_name?: string;

  @Column({ default: true })
  is_active!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  last_login_at?: Date;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at?: Date;

  @DeleteDateColumn()
  deleted_at?: Date;
}
