import { CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { Customer } from "./Customer";
import { CustomerTag } from "./CustomerTag";

@Entity('customer_tag_relations')
@Index(['customer', 'tag'], { unique: true })
export class CustomerTagRelation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Customer, (customer) => customer.tags, {
    onDelete: 'CASCADE',
  })
  customer!: Customer;

  @ManyToOne(() => CustomerTag, (tag) => tag.customers, {
    onDelete: 'CASCADE',
  })
  tag!: CustomerTag;

  @CreateDateColumn()
  created_at!: Date;
}