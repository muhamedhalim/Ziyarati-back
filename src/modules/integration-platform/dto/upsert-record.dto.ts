import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsObject, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * A single external-system upsert. `data` carries the resource fields keyed by
 * the domain field names; it is NOT deep-validated here — the write pipeline
 * sanitizes it against the per-resource allowlist (rejecting protected fields)
 * and then validates it against the real domain DTO, so business rules are
 * reused rather than duplicated.
 */
export class UpsertRecordDto {
  @ApiProperty({ description: 'Connection this write belongs to.', format: 'uuid' })
  @IsUUID('4')
  connectionId!: string;

  @ApiProperty({ description: "The external system's own id for this record.", example: 'PMS-10432' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  externalId!: string;

  @ApiProperty({ description: 'Resource fields (domain field names). Protected fields are rejected.', type: Object })
  @IsObject()
  data!: Record<string, unknown>;
}
