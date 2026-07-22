import { Service } from '../../entities/Services/Service';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { Customer } from '../../entities/CRM/Customer';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';

/**
 * Response projections for the external integration API.
 *
 * Each mapper is a strict ALLOWLIST — it names every field it returns rather
 * than spreading the entity — so a new internal column added to an entity
 * later is invisible to external clients until someone deliberately adds it
 * here. Excluded on purpose, per resource:
 *  - services:     nothing sensitive; internal soft-delete/relations only.
 *  - staff:        the linked `user`'s email/phone/roles/password_hash,
 *                   avatar signed URLs, commission, rating, dashboard access.
 *  - customers:    whatsapp linkage, gender, date_of_birth, marketing_opt_in,
 *                   source, and all sub-resources (notes/files/addresses/tags)
 *                   — internal CRM metadata and PII beyond what a clinic
 *                   integration needs to identify a customer.
 *  - appointments: `notes` (may contain clinical/medical free text),
 *                   `total_amount` / `currency` / `payment_status` (payment
 *                   details), `booked_by`, `version`, `slot`.
 */

export interface IntegrationService {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  pricingType: string;
  basePrice: number | null;
  isActive: boolean;
  categoryId: string | null;
  categoryName: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export function toIntegrationService(s: Service): IntegrationService {
  return {
    id: s.id,
    name: s.name,
    description: s.description ?? null,
    durationMinutes: s.duration_minutes,
    pricingType: s.pricing_type,
    basePrice: s.base_price ?? null,
    isActive: s.is_active,
    categoryId: s.category?.id ?? null,
    categoryName: s.category?.name ?? null,
    createdAt: s.created_at.toISOString(),
    updatedAt: s.updated_at?.toISOString() ?? null,
  };
}

export interface IntegrationStaff {
  id: string;
  fullName: string | null;
  title: string | null;
  bio: string | null;
  isAvailableForBooking: boolean;
  createdAt: string;
}

export function toIntegrationStaff(p: StaffProfile): IntegrationStaff {
  return {
    id: p.id,
    fullName: p.user?.full_name ?? null,
    title: p.title ?? null,
    bio: p.bio ?? null,
    isAvailableForBooking: p.is_available_for_booking,
    createdAt: p.created_at.toISOString(),
  };
}

export interface IntegrationCustomer {
  id: string;
  fullName: string | null;
  phone: string;
  email: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string | null;
}

export function toIntegrationCustomer(c: Customer): IntegrationCustomer {
  return {
    id: c.id,
    fullName: c.full_name ?? null,
    phone: c.phone,
    email: c.email ?? null,
    isActive: c.is_active,
    createdAt: c.created_at.toISOString(),
    updatedAt: c.updated_at?.toISOString() ?? null,
  };
}

export interface IntegrationAppointment {
  id: string;
  startAt: string;
  endAt: string;
  status: string;
  source: string;
  branchId: string;
  staffId: string;
  customerId: string;
  createdAt: string;
  updatedAt: string | null;
}

export function toIntegrationAppointment(a: Appointment): IntegrationAppointment {
  return {
    id: a.id,
    startAt: a.start_at.toISOString(),
    endAt: a.end_at.toISOString(),
    status: a.status,
    source: a.source,
    branchId: a.branch.id,
    staffId: a.staff.id,
    customerId: a.customer.id,
    createdAt: a.created_at.toISOString(),
    updatedAt: a.updated_at?.toISOString() ?? null,
  };
}
