import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateTenantDto } from './create-tenant.dto';

/**
 * Profile updates. `slug` is immutable (it identifies the tenant in URLs/login).
 * Approval status and `is_active` are NOT here — they change only through the
 * approval lifecycle endpoints (approve/reject/suspend).
 */
export class UpdateTenantDto extends PartialType(
  OmitType(CreateTenantDto, ['slug'] as const),
) {}
