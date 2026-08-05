import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToOne,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
  JoinColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { CustomerProfile } from '../CRM/CustomerProfile';
import { CustomerAddress } from '../CRM/CustomerAddress';
import { CustomerNote } from '../CRM/CustomerNote';
import { CustomerFile } from '../CRM/CustomerFile';
import { CustomerTagRelation } from '../CRM/CustomerTagRelation';

@Entity('customers')
@Index(['tenant', 'phone'], { unique: true })
// FND-040/M-01: tenant-scoped, matching the sibling phone index above — was
// UNIQUE (email) globally (migration CustomerTenantScopedEmail1730019000000).
@Index(['tenant', 'email'], { unique: true })
export class Customer {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column({ nullable: true })
  full_name?: string;

  @Column({ length: 20 })
  phone!: string;

  @Column({ nullable: true })
  whatsapp_id?: string;

  @Column({ nullable: true })
  whatsapp_name?: string;

  // NOT NULL at the DB level (verified live, D-1) — tightened from the
  // previous `email?: string` so application code cannot attempt an insert
  // the column would reject. Uniqueness is expressed by the tenant-scoped
  // class-level @Index above, not `unique: true` here (that would be a
  // GLOBAL constraint, which is exactly the defect FND-040 fixes).
  @Column()
  email!: string;

  @Column({ nullable: true })
  gender?: string;

  @Column({ type: 'date', nullable: true })
  date_of_birth?: Date;

  @Column({ nullable: true })
  source?: string;

  @Column({ default: false })
  marketing_opt_in!: boolean;

  /**
   * FND-024/M-05: when an inbound opt-out (e.g. "STOP") was detected. `NULL`
   * means never opted out — no backfill on migration. Additive to, not a
   * replacement for, `marketing_opt_in`: this records WHEN/HOW, which the
   * boolean alone cannot express.
   */
  @Column({ type: 'timestamptz', nullable: true })
  opted_out_at?: Date | null;

  /** How the opt-out was registered (e.g. `inbound_keyword`, `manual`) — for audit. NULL until opted_out_at is set. */
  @Column({ type: 'varchar', length: 50, nullable: true })
  opt_out_source?: string | null;

  @Column({ default: true })
  is_active!: boolean;

  /**
   * M-09/CAP-I18N: persisted locale preference for recipient-locale
   * notifications (FR-H014/FR-H015). `NULL` means "no explicit choice
   * recorded, fall back to `DEFAULT_LOCALE`" — never backfilled, mirrors
   * `User.preferred_locale`'s (M-08) exact semantics.
   */
  @Column({ type: 'varchar', length: 10, nullable: true })
  preferred_locale?: string | null;

  @OneToOne(() => CustomerProfile, (profile) => profile.customer)
  profile?: CustomerProfile;

  @OneToMany(() => CustomerAddress, (address) => address.customer)
  addresses!: CustomerAddress[];

  @OneToMany(() => CustomerNote, (note) => note.customer)
  notes!: CustomerNote[];

  @OneToMany(() => CustomerFile, (file) => file.customer)
  files!: CustomerFile[];

  @OneToMany(() => CustomerTagRelation, (relation) => relation.customer)
  tags!: CustomerTagRelation[];

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at?: Date;

  @DeleteDateColumn()
  deleted_at?: Date;
}