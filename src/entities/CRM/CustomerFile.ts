import { Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { Customer } from "./Customer";
import { Tenant } from "../SaaS-Core/Tenant";
import { User } from "../Auth&RBAC/User";

@Entity('customer_files')
export class CustomerFile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Customer, (customer) => customer.files)
  customer!: Customer;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column({ nullable: true })
  file_name?: string;

  /**
   * Legacy/external URL for rows created before private storage, OR a
   * short-lived signed URL resolved in-memory from `storage_key` for API
   * responses (see `CustomerFileService.withResolvedUrl`) — never both
   * meaningfully at once. Uploads always go through S3 going forward; this
   * column is only ever read from, never written to, by new code.
   */
  @Column({ type: 'text', nullable: true })
  file_url?: string | null;

  /**
   * Private S3 object key (`<tenantId>/customer-file/<uuid>.<ext>`). Never a
   * URL. Explicit `type:` avoids TypeORM's `DataTypeNotSupportedError` for
   * union-typed columns.
   */
  @Column({ type: 'varchar', nullable: true })
  storage_key?: string | null;

  @Column({ nullable: true })
  file_type?: string;

  @ManyToOne(() => User, { nullable: true })
  uploaded_by?: User;

  @CreateDateColumn()
  created_at!: Date;
}