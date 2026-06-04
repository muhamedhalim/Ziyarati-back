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

@Column({ unique: true })
  email?: string;

  @Column({ nullable: true })
  gender?: string;

  @Column({ type: 'date', nullable: true })
  date_of_birth?: Date;

  @Column({ nullable: true })
  source?: string;

  @Column({ default: false })
  marketing_opt_in!: boolean;

  @Column({ default: true })
  is_active!: boolean;

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