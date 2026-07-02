import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Unique,
  Index,
  CreateDateColumn,
} from 'typeorm';

/**
 * Feature dependency edge: `feature_key` requires `requires_key`. The full graph
 * is stored (not hardcoded) and supports unlimited depth; the resolver walks it
 * with cycle detection, and edge creation rejects cycles.
 */
@Entity('feature_dependencies')
@Unique(['feature_key', 'requires_key'])
export class FeatureDependency {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column()
  feature_key!: string;

  @Column()
  requires_key!: string;

  @CreateDateColumn()
  created_at!: Date;
}
