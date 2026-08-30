import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  DataSource,
  EntityManager,
  FindOptionsWhere,
  LessThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';

import { Invoice } from '../../entities/Payments/Invoice';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { Customer } from '../../entities/CRM/Customer';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { InvoiceStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';
import { QueueService } from '../../queue/queue.service';

import { InvoiceItemService } from './invoice-item.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { AddInvoiceItemsDto } from './dto/add-invoice-item.dto';
import { QueryInvoicesDto } from './dto/query-invoices.dto';

/**
 * Invoices (`invoices`) — DRAFT → OPEN (finalized) → PAID/VOID/REFUNDED.
 *
 * Tenant-scoped via the `tenant` relation. Invoice numbers are generated per
 * tenant and protected by the entity's `(tenant, invoice_number)` unique
 * constraint. Totals are auto-calculated from line items. The Invoice entity has
 * no inverse items relation, so detail views compose items via InvoiceItemService.
 */
@Injectable()
export class InvoiceService {
  constructor(
    @InjectRepository(Invoice)
    private readonly invoices: Repository<Invoice>,
    @InjectRepository(TenantSetting)
    private readonly tenantSettings: Repository<TenantSetting>,
    private readonly dataSource: DataSource,
    private readonly itemsService: InvoiceItemService,
    private readonly queue: QueueService,
  ) {}

  /** Bumps the document version and enqueues a render — shared by finalize() and regenerateDocument(). */
  private async triggerDocumentRender(
    tenantId: string,
    invoice: Invoice,
  ): Promise<void> {
    invoice.document_version += 1;
    await this.invoices.save(invoice);
    await this.queue.enqueueAnalyticsInvoiceDocument({
      tenantId,
      invoiceId: invoice.id,
      documentVersion: invoice.document_version,
    });
  }

  async create(tenantId: string, dto: CreateInvoiceDto) {
    const id = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Invoice);
      const invoiceNumber = await this.nextInvoiceNumber(manager, tenantId);
      // FR-I005 (T093) — snapshotted once, at creation, mirroring how
      // `Appointment.currency`/`booked_timezone` already snapshot their
      // context. A later change to `tenant_settings.currency` must never
      // rewrite an already-created invoice.
      const settings = await manager
        .getRepository(TenantSetting)
        .findOne({ where: { tenant: { id: tenantId } } });

      const invoice = await repo.save(
        repo.create({
          tenant: { id: tenantId } as Tenant,
          customer: dto.customerId
            ? ({ id: dto.customerId } as Customer)
            : undefined,
          appointment: dto.appointmentId
            ? ({ id: dto.appointmentId } as Appointment)
            : undefined,
          invoice_number: invoiceNumber,
          total_amount: 0,
          status: InvoiceStatus.DRAFT,
          currency: settings?.currency ?? 'USD',
        }),
      );

      if (dto.items?.length) {
        await this.itemsService.addItems(
          tenantId,
          invoice.id,
          dto.items,
          manager,
        );
        await this.itemsService.recalcTotal(tenantId, invoice.id, manager);
      }
      return invoice.id;
    });

    return this.getOne(tenantId, id);
  }

  async addItems(tenantId: string, id: string, dto: AddInvoiceItemsDto) {
    const invoice = await this.findOne(tenantId, id);
    if (invoice.status !== InvoiceStatus.DRAFT) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Items can only be added to a DRAFT invoice (status: ${invoice.status})`,
      });
    }

    await this.dataSource.transaction(async (manager) => {
      await this.itemsService.addItems(tenantId, id, dto.items, manager);
      await this.itemsService.recalcTotal(tenantId, id, manager);
    });

    return this.getOne(tenantId, id);
  }

  /** DRAFT → OPEN. Stamps `issued_at`, freezes the invoice for payment, and triggers T095's document render. */
  async finalize(tenantId: string, id: string) {
    const invoice = await this.findOne(tenantId, id);
    if (invoice.status !== InvoiceStatus.DRAFT) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `Invoice is already ${invoice.status}`,
      });
    }
    invoice.status = InvoiceStatus.OPEN;
    invoice.issued_at = new Date();
    await this.invoices.save(invoice);
    await this.triggerDocumentRender(tenantId, invoice);
    return this.getOne(tenantId, id);
  }

  /**
   * T096 (spec 014, US12, FR-I010) — forces a fresh render, e.g. after a
   * payment-state change. `invoices.manage` (see the controller): this is a
   * write action, not a read.
   */
  async regenerateDocument(tenantId: string, id: string) {
    const invoice = await this.findOne(tenantId, id);
    if (invoice.status === InvoiceStatus.DRAFT) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'A draft invoice has no document to regenerate',
      });
    }
    await this.triggerDocumentRender(tenantId, invoice);
    return this.getOne(tenantId, id);
  }

  /**
   * T096 — the state the document routes need: DRAFT (409), rendered
   * version behind the trigger version (202 pending), or a ready key (200).
   */
  async getDocumentState(
    tenantId: string,
    id: string,
  ): Promise<
    | { state: 'draft' }
    | { state: 'pending' }
    | { state: 'ready'; documentKey: string }
  > {
    const invoice = await this.findOne(tenantId, id);
    if (invoice.status === InvoiceStatus.DRAFT) return { state: 'draft' };
    if (
      invoice.document_key &&
      invoice.document_rendered_version === invoice.document_version
    ) {
      return { state: 'ready', documentKey: invoice.document_key };
    }
    return { state: 'pending' };
  }

  async list(tenantId: string, query: QueryInvoicesDto) {
    const where: FindOptionsWhere<Invoice> = { tenant: { id: tenantId } };
    if (query.status) where.status = query.status;
    if (query.customerId) where.customer = { id: query.customerId };
    if (query.from && query.to) {
      where.created_at = Between(new Date(query.from), new Date(query.to));
    } else if (query.from) {
      where.created_at = MoreThanOrEqual(new Date(query.from));
    } else if (query.to) {
      where.created_at = LessThan(new Date(query.to));
    }

    const [data, total] = await this.invoices.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data, total, page: query.page, limit: query.limit };
  }

  /** Invoice with its composed line items (entity has no inverse relation). */
  async getOne(tenantId: string, id: string) {
    const invoice = await this.findOne(tenantId, id);
    const items = await this.itemsService.listForInvoice(tenantId, id);
    return { ...invoice, items };
  }

  async findOne(tenantId: string, id: string): Promise<Invoice> {
    const invoice = await this.invoices.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!invoice) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Invoice not found' });
    }
    return invoice;
  }

  /**
   * Tenant-scoped sequential number, e.g. `INV-2026-000001`.
   *
   * H1 fix: a monotonic per-tenant counter incremented atomically via
   * `INSERT … ON CONFLICT DO UPDATE … RETURNING`. This serializes concurrent
   * invoice creates on the counter row, so two requests can never compute the
   * same number (the old `count(*)+1` raced and could also reuse numbers after
   * voids/deletes). The `tenant_counters` table is created by
   * PaymentsSchemaBootstrap / migration.
   */
  private async nextInvoiceNumber(
    manager: EntityManager,
    tenantId: string,
  ): Promise<string> {
    const rows: Array<{ seq: string }> = await manager.query(
      `INSERT INTO tenant_counters (tenant_id, name, seq)
       VALUES ($1, 'invoice', 1)
       ON CONFLICT (tenant_id, name)
       DO UPDATE SET seq = tenant_counters.seq + 1
       RETURNING seq`,
      [tenantId],
    );
    const seq = Number(rows[0]?.seq ?? 1);
    const year = new Date().getFullYear();
    return `INV-${year}-${String(seq).padStart(6, '0')}`;
  }
}
