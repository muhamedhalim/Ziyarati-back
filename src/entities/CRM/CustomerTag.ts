import { Column, CreateDateColumn, Entity, Index, ManyToOne, OneToMany, PrimaryGeneratedColumn } from "typeorm";
import { CustomerTagRelation } from "./CustomerTagRelation";
import { Tenant } from "../SaaS Core/Tenant";

@Entity('customer_tags')
@Index(['tenant', 'name'], { unique: true })
export class CustomerTag {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column()
  name!: string;

  @Column({ nullable: true })
  color?: string;

  @OneToMany(
    () => CustomerTagRelation,
    (relation) => relation.tag,
  )
  customers!: CustomerTagRelation[];

  @CreateDateColumn()
  created_at!: Date;
}