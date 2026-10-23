import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';

import { ContactLead } from '../../entities/Sales/ContactLead';
import { EmailService } from '../email/email.service';
import { SubmitContactDto } from './dto/submit-contact.dto';
import { CONTACT_DUPLICATE_WINDOW_MS } from './public-contact.constants';

@Injectable()
export class ContactLeadService {
  private readonly logger = new Logger(ContactLeadService.name);

  constructor(
    @InjectRepository(ContactLead) private readonly leads: Repository<ContactLead>,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Stores the enquiry, then (best effort) tells the sales inbox. The row is the source of truth: a
   * mail failure never loses a lead and never fails the visitor's submit.
   */
  async submit(dto: SubmitContactDto): Promise<void> {
    // A double-click or a retry after a flaky network must not create two leads or two emails.
    const duplicate = await this.leads.count({
      where: {
        email: dto.email,
        message: dto.message,
        created_at: MoreThan(new Date(Date.now() - CONTACT_DUPLICATE_WINDOW_MS)),
      },
    });
    if (duplicate > 0) return;

    const lead = await this.leads.save(
      this.leads.create({
        full_name: dto.fullName,
        email: dto.email,
        phone: dto.phone ?? null,
        facility_name: dto.facilityName ?? null,
        subject: dto.subject,
        message: dto.message,
        locale: dto.locale ?? 'en',
      }),
    );

    await this.notify(lead);
  }

  private async notify(lead: ContactLead): Promise<void> {
    const to = (this.config.get<string>('CONTACT_LEADS_TO') ?? '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    if (to.length === 0) {
      this.logger.warn(
        `Contact lead ${lead.id} stored but CONTACT_LEADS_TO is not set, so nobody was emailed`,
      );
      return;
    }
    const lines = [
      `From: ${lead.full_name} <${lead.email}>`,
      lead.phone ? `Phone: ${lead.phone}` : null,
      lead.facility_name ? `Facility: ${lead.facility_name}` : null,
      `Language: ${lead.locale}`,
      '',
      lead.message,
    ].filter((l): l is string => l !== null);
    await this.email.send({
      to,
      template: 'generic',
      locale: 'en',
      replyTo: lead.email,
      idempotencyKey: `contact-lead:${lead.id}`,
      variables: {
        title: `New website enquiry (${lead.subject})`,
        message: lines.join('\n'),
      },
    });
  }

  list(params: { status?: 'new' | 'handled'; page: number; limit: number }) {
    return this.leads
      .findAndCount({
        where: params.status ? { status: params.status } : {},
        order: { created_at: 'DESC' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      })
      .then(([data, total]) => ({ data, total, page: params.page, limit: params.limit }));
  }

  async markHandled(id: string): Promise<boolean> {
    const res = await this.leads.update({ id }, { status: 'handled' });
    return Boolean(res.affected);
  }
}
