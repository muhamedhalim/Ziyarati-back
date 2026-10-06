import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CustomerFile } from '../../entities/CRM/CustomerFile';
import { Customer } from '../../entities/CRM/Customer';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { User } from '../../entities/Auth&RBAC/User';
import { AppError, ErrorCode } from '../../common/errors';

import { CustomerService } from './customer.service';
import { PaginationQueryDto } from './dto/pagination-query.dto';
import { StorageService } from '../storage/storage.service';

/** Path segment under the tenant's R2 prefix — see `StorageService.upload`. */
const CUSTOMER_FILE_DOC_TYPE = 'customer-file';

/** Raw upload bytes + metadata, as received from `FileInterceptor`. */
export interface UploadCustomerFileInput {
  originalName: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
  /** Optional display-name override; defaults to the sanitized original name. */
  fileName?: string;
}

/**
 * Customer files (1:N) — METADATA ONLY. The binary lives in private Cloudflare
 * R2 storage (via the shared `StorageService`, same allow-list/magic-byte/size
 * validation as staff avatars and verification documents); this table stores
 * the object key + display metadata + uploader.
 *
 * Tenant-scoped via the `tenant` relation; the parent customer is verified
 * tenant-owned first.
 */
@Injectable()
export class CustomerFileService {
  private readonly logger = new Logger(CustomerFileService.name);

  constructor(
    @InjectRepository(CustomerFile)
    private readonly files: Repository<CustomerFile>,
    private readonly customers: CustomerService,
    private readonly storage: StorageService,
  ) {}

  async upload(
    tenantId: string,
    customerId: string,
    input: UploadCustomerFileInput,
    userId?: string,
  ): Promise<CustomerFile> {
    await this.customers.findOneOrThrow(tenantId, customerId);

    const stored = await this.storage.upload({
      tenantId,
      docType: CUSTOMER_FILE_DOC_TYPE,
      originalName: input.originalName,
      mimeType: input.mimeType,
      size: input.size,
      buffer: input.buffer,
    });

    const file = await this.files.save(
      this.files.create({
        customer: { id: customerId } as Customer,
        tenant: { id: tenantId } as Tenant,
        uploaded_by: userId ? ({ id: userId } as User) : undefined,
        file_name: input.fileName?.trim() || stored.filename,
        file_type: stored.mimeType,
        storage_key: stored.storageKey,
      }),
    );
    return this.withResolvedUrl(file, tenantId);
  }

  async remove(tenantId: string, customerId: string, fileId: string) {
    const file = await this.findOwned(tenantId, customerId, fileId);
    await this.files.remove(file);

    if (file.storage_key) {
      try {
        // A patient document is D4 data: remove it PERMANENTLY, every stored version.
        // `deleteObject` on a versioned bucket only writes a delete marker and leaves the
        // document readable by version id (residency plan P11).
        await this.storage.purgeObject(file.storage_key, tenantId);
      } catch (err) {
        this.logger.warn(
          `Failed to delete R2 object ${file.storage_key}: ${(err as Error)?.message}`,
        );
      }
    }
    return { id: fileId, deleted: true };
  }

  async list(
    tenantId: string,
    customerId: string,
    query: PaginationQueryDto,
  ) {
    await this.customers.findOneOrThrow(tenantId, customerId);
    const [data, total] = await this.files.findAndCount({
      where: { customer: { id: customerId }, tenant: { id: tenantId } },
      relations: { uploaded_by: true },
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    await Promise.all(data.map((file) => this.withResolvedUrl(file, tenantId)));
    return { data, total, page: query.page, limit: query.limit };
  }

  /** File metadata (the "download" payload — there is no binary here). */
  async getMetadata(
    tenantId: string,
    customerId: string,
    fileId: string,
  ): Promise<CustomerFile> {
    const file = await this.findOwned(tenantId, customerId, fileId);
    return this.withResolvedUrl(file, tenantId);
  }

  /**
   * Raw load — no URL resolution. `withResolvedUrl` mutates `file_url` into a
   * presentation-only signed URL; `remove` only needs the real `storage_key`
   * and must never generate (and discard) a signed URL just to delete the row.
   */
  private async findOwned(
    tenantId: string,
    customerId: string,
    fileId: string,
  ): Promise<CustomerFile> {
    const file = await this.files.findOne({
      where: { id: fileId, customer: { id: customerId }, tenant: { id: tenantId } },
      relations: { uploaded_by: true },
    });
    if (!file) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'File not found' });
    }
    return file;
  }

  private async withResolvedUrl<T extends CustomerFile>(file: T, tenantId: string): Promise<T> {
    if (file.storage_key) {
      file.file_url = await this.storage.getSignedDownloadUrl(file.storage_key, tenantId);
    }
    return file;
  }
}
