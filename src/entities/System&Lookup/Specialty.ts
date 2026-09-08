import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Platform-owned clinical specialty lookup (Marketplace BE-1). Modelled on
 * `City`: no tenant column, no soft delete — hidden via `is_active` instead,
 * since associations (`TenantSpecialty`/`StaffSpecialty`) must survive a
 * specialty being temporarily hidden from discovery.
 */
@Entity('specialties')
@Index(['is_active', 'sort_order'])
export class Specialty {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Stable public identifier; assigned once, never rewritten by a rename. */
  @Column({ type: 'varchar', length: 120, unique: true })
  slug!: string;

  @Column({ type: 'varchar', length: 120 })
  name_en!: string;

  @Column({ type: 'varchar', length: 120 })
  name_ar!: string;

  @Column({ type: 'text', nullable: true })
  description_en?: string | null;

  @Column({ type: 'text', nullable: true })
  description_ar?: string | null;

  @Column({ default: true })
  is_active!: boolean;

  @Column({ default: 0 })
  sort_order!: number;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
