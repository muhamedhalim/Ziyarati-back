import { Entity, PrimaryGeneratedColumn, Column, Unique, ManyToOne, CreateDateColumn } from 'typeorm';
import { Tenant } from '../SaaS Core/Tenant';

@Entity('feature_flags')
@Unique(['tenant', 'feature_key'])
export class FeatureFlag {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, (t) => t.featureFlags, { onDelete: 'CASCADE' })
  tenant!: Tenant;

  @Column()
  feature_key!: string;

  @Column({ default: false })
  is_enabled!: boolean;

  @CreateDateColumn()
  created_at!: Date;
}