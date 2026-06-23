import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
} from 'typeorm';
import { Tenant } from './Tenant';

@Entity('branches')
@Index(['tenant'])
export class Branch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, (t) => t.branches, { onDelete: 'CASCADE' })
  tenant!: Tenant;

  @Column()
  name!: string;

  @Column({ nullable: true })
  address?: string;

  @Column({ type: 'uuid', nullable: true })
  city_id?: string;

  @Column({ nullable: true })
  phone?: string;

  @Column({ nullable: true })
  whatsapp_phone?: string;

  /** IANA timezone (e.g. 'Asia/Riyadh'). Drives local working-hours/holiday eval. */
  @Column({ default: 'Asia/Riyadh' })
  timezone!: string;

  @Column({ default: true })
  is_active!: boolean;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  @DeleteDateColumn()
  deleted_at?: Date;
}