import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AppError, ErrorCode } from '../../common/errors';

/** Rows per section. A patient with more than this is exported truncated, and says so. */
export const EXPORT_SECTION_LIMIT = 5000;

export interface SubjectExport {
  generatedAt: string;
  subjectId: string;
  /** Section name -> rows. */
  sections: Record<string, unknown[]>;
  /** Section name -> row count actually included. */
  counts: Record<string, number>;
  /** Sections cut at {@link EXPORT_SECTION_LIMIT}. */
  truncated: string[];
}

interface Section {
  name: string;
  sql: string;
}

/**
 * Everything the clinic holds about ONE patient, as a machine-readable document
 * (residency plan P13 — the "access / copy" request).
 *
 * What it contains is chosen section by section below, not "every column of every
 * table": a patient is entitled to their own data, not to staff-internal
 * identifiers, storage keys, signed URLs or other patients' rows. Documents are
 * listed by name and type; their bytes are fetched through the normal download.
 *
 * Every statement is tenant-scoped and parameterised. The caller is expected to
 * record the read in the read-audit log (the request service does).
 */
@Injectable()
export class SubjectExportService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private sections(): Section[] {
    const mine = `"customerId" = $1 AND "tenantId" = $2`;
    const myAppointments = `SELECT "id" FROM "appointments" WHERE "customerId" = $1 AND "tenantId" = $2`;
    const myConversations = `SELECT "id" FROM "conversations" WHERE "customerId" = $1 AND "tenantId" = $2`;
    return [
      {
        name: 'identity',
        sql: `SELECT "id", "full_name", "phone", "whatsapp_id", "whatsapp_name", "email", "gender", "date_of_birth", "national_id", "source", "preferred_locale", "created_at" FROM "customers" WHERE "id" = $1 AND "tenantId" = $2`,
      },
      {
        name: 'consent',
        sql: `SELECT "marketing_opt_in", "opted_out_at", "opt_out_source" FROM "customers" WHERE "id" = $1 AND "tenantId" = $2`,
      },
      {
        name: 'health_intake',
        sql: `SELECT "has_chronic_diseases", "chronic_diseases", "has_health_insurance" FROM "customers" WHERE "id" = $1 AND "tenantId" = $2`,
      },
      {
        name: 'addresses',
        sql: `SELECT "label", "address_line", "city", "is_default" FROM "customer_addresses" WHERE ${mine}`,
      },
      {
        name: 'profile',
        sql: `SELECT "medical_history", "allergies", "blood_type", "emergency_contact_name", "emergency_contact_phone", "notes" FROM "customer_profiles" WHERE "customer_id" = $1 AND "tenantId" = $2`,
      },
      {
        name: 'notes',
        sql: `SELECT "content", "created_at" FROM "customer_notes" WHERE ${mine} ORDER BY "created_at"`,
      },
      {
        name: 'documents',
        sql: `SELECT "file_name", "file_type", "created_at" FROM "customer_files" WHERE ${mine} ORDER BY "created_at"`,
      },
      {
        name: 'appointments',
        sql: `SELECT "id", "start_at", "end_at", "status", "payment_status", "total_amount", "currency", "source", "notes", "created_at" FROM "appointments" WHERE ${mine} ORDER BY "start_at"`,
      },
      {
        name: 'appointment_notes',
        sql: `SELECT "appointmentId" AS "appointment_id", "content", "created_at" FROM "appointment_notes" WHERE "tenantId" = $2 AND "appointmentId" IN (${myAppointments}) ORDER BY "created_at"`,
      },
      {
        name: 'clinical_encounters',
        sql: `SELECT "occurred_at", "summary" FROM "clinical_encounters" WHERE ${mine} ORDER BY "occurred_at"`,
      },
      {
        name: 'clinical_entries',
        sql: `SELECT "kind", "data", "recorded_at" FROM "clinical_entries" WHERE ${mine} AND "deleted_at" IS NULL ORDER BY "recorded_at"`,
      },
      {
        name: 'reviews',
        sql: `SELECT "rating", "comment", "reply", "created_at" FROM "customer_reviews" WHERE ${mine} AND "deleted_at" IS NULL ORDER BY "created_at"`,
      },
      {
        name: 'invoices',
        sql: `SELECT "invoice_number", "total_amount", "currency", "status", "issued_at", "paid_at" FROM "invoices" WHERE ${mine} ORDER BY "issued_at"`,
      },
      {
        name: 'payments',
        sql: `SELECT "amount", "currency", "status", "payment_method", "paid_at" FROM "payments" WHERE ${mine} ORDER BY "created_at"`,
      },
      {
        name: 'messages',
        sql: `SELECT "sender_type", "message_type", "content", "created_at" FROM "messages" WHERE "tenantId" = $2 AND "conversationId" IN (${myConversations}) ORDER BY "created_at"`,
      },
    ];
  }

  async build(tenantId: string, customerId: string): Promise<SubjectExport> {
    const exists: unknown[] = await this.dataSource.query(
      `SELECT 1 FROM "customers" WHERE "id" = $1 AND "tenantId" = $2`,
      [customerId, tenantId],
    );
    if (exists.length === 0) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Customer not found in this clinic.',
      });
    }

    const sections: Record<string, unknown[]> = {};
    const counts: Record<string, number> = {};
    const truncated: string[] = [];
    for (const s of this.sections()) {
      // One extra row tells us whether the section was cut, without a second count query.
      const rows: unknown[] = await this.dataSource.query(
        `${s.sql} LIMIT ${EXPORT_SECTION_LIMIT + 1}`,
        [customerId, tenantId],
      );
      if (rows.length > EXPORT_SECTION_LIMIT) {
        truncated.push(s.name);
        rows.length = EXPORT_SECTION_LIMIT;
      }
      sections[s.name] = rows;
      counts[s.name] = rows.length;
    }
    return {
      generatedAt: new Date().toISOString(),
      subjectId: customerId,
      sections,
      counts,
      truncated,
    };
  }
}
