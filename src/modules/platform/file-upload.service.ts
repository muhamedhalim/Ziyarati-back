import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';

import { FileUpload } from '../../entities/System/FileUpload';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { User } from '../../entities/Auth&RBAC/User';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateFileUploadDto } from './dto/create-file-upload.dto';
import { QueryFileUploadsDto } from './dto/query-file-uploads.dto';
import { SystemSettingService } from './system-setting.service';
import { SettingKey } from './settings.registry';
import { UsageService } from '../subscription-billing/usage.service';

/**
 * File upload METADATA tracking (`file_uploads`).
 *
 * Tenant-scoped via the `tenant` relation (required on this entity). NO storage
 * provider is implemented — `file_url` is an opaque storage reference produced
 * elsewhere. The uploader is taken from the principal, not from input.
 *
 * Limits (max file size, per-tenant quota) are read from the typed settings
 * registry at call time so they can be changed without a restart.
 */
@Injectable()
export class FileUploadService {
  /** Hostnames a stored file_url may NOT point at (SSRF / cross-tenant guard). */
  private static readonly BLOCKED_HOST =
    /^(localhost|127\.|0\.0\.0\.0|169\.254\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;

  constructor(
    @InjectRepository(FileUpload)
    private readonly files: Repository<FileUpload>,
    private readonly platformSettings: SystemSettingService,
    // `forwardRef`: SubscriptionBillingModule imports PlatformModule for
    // SystemSettingService, and this makes the dependency mutual. Same pattern
    // already used between WhatsappModule and NotificationsModule.
    @Inject(forwardRef(() => UsageService))
    private readonly usage: UsageService,
  ) {}

  async register(
    tenantId: string,
    dto: CreateFileUploadDto,
    userId?: string,
  ): Promise<FileUpload> {
    const [maxFileSizeMb, tenantQuotaGb] = await Promise.all([
      this.platformSettings.getTyped<number>(SettingKey.MAX_FILE_SIZE_MB),
      this.platformSettings.getTyped<number>(SettingKey.TENANT_QUOTA_GB),
    ]);
    const maxFileBytes = maxFileSizeMb * 1024 * 1024;
    const tenantQuotaBytes = tenantQuotaGb * 1024 * 1024 * 1024;

    this.assertSafeUrl(dto.file_url);
    const size = dto.file_size ?? 0;
    if (size < 0 || size > maxFileBytes) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `File size exceeds the ${maxFileSizeMb} MB limit`,
      });
    }
    // Best-effort quota: size is client-claimed (no storage integration here), so
    // this is an advisory cap until a real storage provider reports actual bytes.
    const used = await this.usedBytes(tenantId);
    if (used + size > tenantQuotaBytes) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Tenant storage quota exceeded',
        publicContext: { usedBytes: used, quotaBytes: tenantQuotaBytes },
      });
    }

    // The PLAN's own caps, alongside the platform-wide `TENANT_QUOTA_GB` above.
    // Both are checked, so the lower of the two binds — the platform setting is
    // a hard infrastructure ceiling, the plan columns are the commercial limit.
    // Scoped to CORE_WORKSPACE (always-on): a tenant with a paid plan is
    // PLAN_ENFORCED here, while one running on a super-admin feature grant has
    // no plan and is UNMETERED_BY_PLAN, so uploads keep working for it.
    await this.usage.assertResourceWithinLimit(
      tenantId,
      'storageBytes',
      used,
      size,
    );
    // `uploadedFiles` is also a byte-size cap (Pricing Catalog: priced per
    // GB) — same `used`/`size` bytes as the `storageBytes` check above, just
    // a separately-configurable plan ceiling.
    await this.usage.assertResourceWithinLimit(
      tenantId,
      'uploadedFiles',
      used,
      size,
    );

    return this.files.save(
      this.files.create({
        tenant: { id: tenantId } as Tenant,
        uploaded_by: userId ? ({ id: userId } as User) : undefined,
        file_name: dto.file_name,
        file_url: dto.file_url,
        file_type: dto.file_type,
        file_size: size,
      }),
    );
  }

  /** Reject non-http(s) schemes and internal/link-local hosts (SSRF + cross-tenant). */
  private assertSafeUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'file_url must be a valid URL',
      });
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'file_url must be http(s)',
      });
    }
    if (FileUploadService.BLOCKED_HOST.test(parsed.hostname)) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'file_url host is not allowed',
      });
    }
  }

  private async usedBytes(tenantId: string): Promise<number> {
    const row = await this.files
      .createQueryBuilder('f')
      .innerJoin('f.tenant', 't')
      .where('t.id = :tenantId', { tenantId })
      .select('COALESCE(SUM(f.file_size), 0)', 'bytes')
      .getRawOne<{ bytes: string }>();
    return Number(row?.bytes ?? 0);
  }

  async remove(tenantId: string, id: string) {
    const file = await this.get(tenantId, id);
    await this.files.remove(file);
    return { id, deleted: true };
  }

  async get(tenantId: string, id: string): Promise<FileUpload> {
    const file = await this.files.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { uploaded_by: true },
    });
    if (!file) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'File not found' });
    }
    return file;
  }

  async list(tenantId: string, query: QueryFileUploadsDto) {
    const where: FindOptionsWhere<FileUpload> = { tenant: { id: tenantId } };
    if (query.fileType) where.file_type = query.fileType;

    const [data, total] = await this.files.findAndCount({
      where,
      relations: { uploaded_by: true },
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data, total, page: query.page, limit: query.limit };
  }

  /** Storage usage summary: total files + bytes, plus a per-type breakdown. */
  async storageUsage(tenantId: string) {
    const base = this.files
      .createQueryBuilder('f')
      .innerJoin('f.tenant', 't')
      .where('t.id = :tenantId', { tenantId });

    const totals = await base
      .clone()
      .select('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(f.file_size), 0)', 'bytes')
      .getRawOne<{ count: string; bytes: string }>();

    const byType = await base
      .clone()
      .select('f.file_type', 'fileType')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(f.file_size), 0)', 'bytes')
      .groupBy('f.file_type')
      .orderBy('bytes', 'DESC')
      .getRawMany<{ fileType: string; count: string; bytes: string }>();

    return {
      totalFiles: Number(totals?.count ?? 0),
      totalBytes: Number(totals?.bytes ?? 0),
      byType: byType.map((r) => ({
        fileType: r.fileType,
        count: Number(r.count),
        bytes: Number(r.bytes),
      })),
    };
  }
}
