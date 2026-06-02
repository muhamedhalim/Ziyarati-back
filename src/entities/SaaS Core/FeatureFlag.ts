import { Entity, PrimaryGeneratedColumn, Column, Unique, ManyToOne } from 'typeorm';
import { Tenant } from '../SaaS Core/Tenant';

@Entity('feature_flags')
@Unique(['tenant_id', 'feature_key'])
export class FeatureFlag {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, (t) => t.featureFlags, { onDelete: 'CASCADE' })
  tenant!: Tenant;

  @Column()
  feature_key!: string;

  @Column({ default: false })
  is_enabled!: boolean;

  @Column({ type: 'timestamptz' })
  created_at!: Date;
}