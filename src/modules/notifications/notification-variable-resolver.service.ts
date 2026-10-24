import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { Customer } from '../../entities/CRM/Customer';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { WhatsappTemplate } from '../../entities/WhatsApp/WhatsappTemplate';
import {
  fixedSourceValue,
  isFixedSource,
  WHATSAPP_TEMPLATE_VARIABLE_SOURCE as SRC,
  WhatsappTemplateVariableSource,
} from '../whatsapp/whatsapp.constants';
import {
  orderedBodyParameters,
  urlButtonParameters,
} from '../whatsapp/template-variables.util';

export interface ResolvedTemplateVariables {
  /** Values for the template's placeholders (plus any pass-through extras). */
  variables: Record<string, unknown>;
  /** Placeholders that have no value — the send must NOT go out. */
  unresolved: Array<{ placeholder: string; source?: string }>;
}

/**
 * Fills an approved WhatsApp template's placeholders from TRUSTED rows.
 *
 * Why this exists: a Meta template is `Hello {{1}}, … on {{2}}`. The
 * notification pipeline knew which template to send but had nothing that
 * supplied "{{1}} = this patient's name, {{2}} = this appointment's date", so
 * every variable-bearing template failed its completeness check and the
 * message silently fell back to email.
 *
 * Trust model — the only inputs are:
 *   - the placeholder → source map stored on the template (a closed
 *     vocabulary, validated when it is written);
 *   - rows loaded here by id AND tenant (appointment, clinic);
 *   - the recipient `Customer` the dispatcher already loaded tenant-scoped.
 * Nothing is taken from a request body, and an appointment that belongs to a
 * different customer than the recipient is treated as "no appointment" — a
 * notification can never carry one patient's booking details to another.
 *
 * Nothing clinical is exposed: no service, specialty, notes, price or
 * diagnosis are available as sources (see `WHATSAPP_TEMPLATE_VARIABLE_SOURCE`).
 */
@Injectable()
export class NotificationVariableResolver {
  constructor(
    @InjectRepository(Appointment)
    private readonly appointments: Repository<Appointment>,
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
  ) {}

  async resolve(
    tenantId: string,
    template: Pick<
      WhatsappTemplate,
      'components' | 'variable_mapping' | 'language'
    >,
    input: {
      customer: Pick<Customer, 'id' | 'full_name'>;
      appointmentId?: string;
      /** Defaults + per-notification values already assembled by the caller. */
      supplied: Record<string, unknown>;
    },
  ): Promise<ResolvedTemplateVariables> {
    // Body placeholders plus any dynamic URL button parameter (`button_<i>`).
    const declared = [
      ...orderedBodyParameters(template.components),
      ...urlButtonParameters(template.components).map((p) => p.key),
    ];
    const mapping = template.variable_mapping ?? {};
    const out: Record<string, unknown> = { ...input.supplied };
    const unresolved: ResolvedTemplateVariables['unresolved'] = [];

    if (declared.length === 0) return { variables: out, unresolved };

    const needsAppointment = declared.some((n) =>
      [
        SRC.APPOINTMENT_DATE,
        SRC.APPOINTMENT_TIME,
        SRC.DOCTOR_NAME,
        SRC.BRANCH_NAME,
      ].includes(mapping[n] as never),
    );
    const needsClinic = declared.some((n) => mapping[n] === SRC.CLINIC_NAME);

    const appointment =
      needsAppointment && input.appointmentId
        ? await this.loadAppointment(
            tenantId,
            input.appointmentId,
            input.customer.id,
          )
        : undefined;
    const clinicName = needsClinic
      ? await this.loadClinicName(tenantId)
      : undefined;
    const locale = this.localeOf(template.language);

    for (const name of declared) {
      const source = mapping[name] as
        | WhatsappTemplateVariableSource
        | undefined;
      // A clinic-typed constant (`fixed:<text>`), e.g. a promotion's offer.
      if (isFixedSource(source)) {
        const fixed = this.clean(fixedSourceValue(source));
        if (fixed) out[name] = fixed;
        else unresolved.push({ placeholder: name, source: 'fixed' });
        continue;
      }
      if (!source) {
        // No binding: only a value the caller already supplied may fill it.
        if (!this.hasValue(out[name])) unresolved.push({ placeholder: name });
        continue;
      }

      const value = this.valueFor(source, {
        customer: input.customer,
        appointment,
        clinicName,
        locale,
        supplied: input.supplied,
      });
      if (this.hasValue(value)) out[name] = value;
      else unresolved.push({ placeholder: name, source });
    }
    return { variables: out, unresolved };
  }

  private valueFor(
    source: WhatsappTemplateVariableSource,
    ctx: {
      customer: Pick<Customer, 'full_name'>;
      appointment?: Appointment;
      clinicName?: string;
      locale: string;
      supplied: Record<string, unknown>;
    },
  ): string | undefined {
    const a = ctx.appointment;
    switch (source) {
      case SRC.PATIENT_NAME:
        return this.clean(ctx.customer.full_name);
      case SRC.PATIENT_FIRST_NAME:
        return this.clean(ctx.customer.full_name)?.split(' ')[0];
      case SRC.RESCHEDULE_TOKEN:
        return this.tokenOf(ctx.supplied['rescheduleUrl']);
      case SRC.CLINIC_NAME:
        return this.clean(ctx.clinicName);
      case SRC.BRANCH_NAME:
        return this.clean(a?.branch?.name);
      case SRC.DOCTOR_NAME:
        return this.clean(a?.staff?.user?.full_name);
      case SRC.APPOINTMENT_DATE:
        return a ? this.formatDate(a, ctx.locale) : undefined;
      case SRC.APPOINTMENT_TIME:
        return a ? this.formatTime(a, ctx.locale) : undefined;
      // The two links are issued per message by the event listener / reminder
      // scheduler (single-use secrets) and arrive as notification variables.
      case SRC.CANCEL_URL:
        return this.clean(ctx.supplied['cancelUrl']);
      case SRC.RESCHEDULE_URL:
        return this.clean(ctx.supplied['rescheduleUrl']);
      default:
        return undefined;
    }
  }

  private async loadAppointment(
    tenantId: string,
    appointmentId: string,
    customerId: string,
  ): Promise<Appointment | undefined> {
    const appointment = await this.appointments.findOne({
      where: { id: appointmentId, tenant: { id: tenantId } },
      relations: { branch: true, staff: { user: true }, customer: true },
      select: {
        id: true,
        start_at: true,
        booked_timezone: true,
        branch: { id: true, name: true, timezone: true },
        staff: { id: true, user: { id: true, full_name: true } },
        customer: { id: true },
      },
    });
    // Belongs to someone else → behave as if there were no appointment.
    if (!appointment || appointment.customer?.id !== customerId)
      return undefined;
    return appointment;
  }

  private async loadClinicName(tenantId: string): Promise<string | undefined> {
    const tenant = await this.tenants.findOne({
      where: { id: tenantId },
      select: { id: true, name: true },
    });
    return tenant?.name;
  }

  /**
   * Gregorian + Latin digits for both languages. `ar-SA` alone would render the
   * Umm al-Qura (Hijri) calendar — a booking date in the wrong calendar is
   * worse than no date.
   */
  private localeOf(templateLanguage: string): string {
    return (templateLanguage ?? '').toLowerCase().startsWith('ar')
      ? 'ar-SA-u-ca-gregory-nu-latn'
      : 'en-GB';
  }

  private zone(a: Appointment): string {
    return a.booked_timezone || a.branch?.timezone || 'Asia/Riyadh';
  }

  private formatDate(a: Appointment, locale: string): string {
    return new Intl.DateTimeFormat(locale, {
      timeZone: this.zone(a),
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(new Date(a.start_at));
  }

  private formatTime(a: Appointment, locale: string): string {
    return new Intl.DateTimeFormat(locale, {
      timeZone: this.zone(a),
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(a.start_at));
  }

  /**
   * The secret at the end of an issued `…/appointment-action/<secret>` link —
   * what a dynamic URL button appends to its fixed base. Anything that is not
   * that exact shape yields nothing (the send is then blocked), so a stray
   * value can never be turned into a path suffix.
   */
  private tokenOf(url: unknown): string | undefined {
    const match = /\/appointment-action\/([A-Za-z0-9_-]{16,200})\/?$/.exec(
      String(url ?? ''),
    );
    return match?.[1];
  }

  private clean(value: unknown): string | undefined {
    if (value === null || value === undefined) return undefined;
    // Meta rejects a parameter containing newlines / tabs or 4+ consecutive
    // spaces, so a free-text name is normalised rather than risk the send.
    const text = String(value)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/ {2,}/g, ' ')
      .trim();
    return text.length > 0 ? text : undefined;
  }

  private hasValue(value: unknown): boolean {
    return value !== undefined && value !== null && String(value).trim() !== '';
  }
}
