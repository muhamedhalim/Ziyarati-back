import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';

@Entity('api_logs')
@Index(['tenant', 'created_at'])
export class ApiLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, { nullable: true })
  tenant?: Tenant;

  @Column({ type: 'varchar', length: 255, nullable: true })
  endpoint?: string;

  @Column({ type: 'varchar', length: 10, nullable: true })
  method?: string;

  @Column({ type: 'int', nullable: true })
  status_code?: number;

  @Column({ type: 'int', nullable: true })
  response_time_ms?: number;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ip_address?: string;

  /**
   * The API key that authenticated this request, if any (most traffic is
   * JWT-cookie authenticated and carries no key). Plain column, not a
   * relation — a best-effort correlation id for per-key usage metrics, never
   * loaded as an association.
   */
  @Column({ type: 'uuid', nullable: true })
  api_key_id?: string;

  @CreateDateColumn()
  created_at!: Date;
}