import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export const CONTACT_LEAD_SUBJECT = [
  'demo',
  'pricing',
  'support',
  'partnership',
  'other',
] as const;
export type ContactLeadSubject = (typeof CONTACT_LEAD_SUBJECT)[number];

export const CONTACT_LEAD_STATUS = ['new', 'handled'] as const;
export type ContactLeadStatus = (typeof CONTACT_LEAD_STATUS)[number];

/**
 * An enquiry from the PUBLIC marketing site's Contact Us form (CR-05).
 *
 * Deliberately NOT tenant-scoped: the sender is a prospect, not a user of any clinic. It is the
 * system of record for these enquiries; the notification email to the sales inbox is best-effort
 * on top of it, so a lead is never lost to a mail failure. The sender's IP is not stored.
 */
@Entity('contact_leads')
@Check('CHK_contact_leads_subject', `"subject" IN ('demo','pricing','support','partnership','other')`)
@Check('CHK_contact_leads_status', `"status" IN ('new','handled')`)
@Index('IX_contact_leads_status_created', ['status', 'created_at'])
@Index('IX_contact_leads_email_created', ['email', 'created_at'])
export class ContactLead {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  full_name!: string;

  /** Lower-cased. */
  @Column({ type: 'varchar', length: 254 })
  email!: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  facility_name?: string | null;

  @Column({ type: 'varchar', length: 16 })
  subject!: ContactLeadSubject;

  @Column({ type: 'text' })
  message!: string;

  /** The locale the visitor submitted from (`en` | `ar`). */
  @Column({ type: 'varchar', length: 8, default: 'en' })
  locale!: string;

  @Column({ type: 'varchar', length: 16, default: 'new' })
  status!: ContactLeadStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
