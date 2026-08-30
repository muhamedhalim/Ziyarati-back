import { IsIn, IsObject, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { EXPORT_REGISTRY_KEYS } from '../export-registry';
import type { ReportKey } from '../export-registry';

/**
 * Spec 014 (Clinic Platform Completion) — T184 (US13, contracts/
 * clinic-surfaces.md F13). `report` must be a key from the CLOSED registry
 * (T180) — validated against `EXPORT_REGISTRY_KEYS`, never accepted as an
 * arbitrary string. `filters` is intentionally loose here: its REAL shape is
 * report-specific (each registry entry names its own existing DTO,
 * `argsDto`), so `ReportExportService` re-validates it against that DTO once
 * `report` is known, rather than this route trying to statically type every
 * report's filter shape at once.
 */
export class CreateReportExportDto {
  @ApiProperty({
    description: 'A key from the closed export registry.',
    enum: EXPORT_REGISTRY_KEYS as unknown as string[],
  })
  @IsIn(EXPORT_REGISTRY_KEYS)
  report!: ReportKey;

  @ApiPropertyOptional({
    description:
      'Export format. Defaults to XLSX. Only offered where the registry entry declares it (FR-X003).',
    example: 'XLSX',
  })
  @IsOptional()
  @IsIn(['XLSX', 'PDF'])
  format?: 'XLSX' | 'PDF';

  @ApiPropertyOptional({
    description:
      "Exactly the filters the on-screen report used — validated against that report's own existing filter DTO.",
  })
  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;
}
