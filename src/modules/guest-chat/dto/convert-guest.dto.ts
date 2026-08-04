import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

/**
 * Convert a guest conversation into a patient conversation (Feature 1).
 *
 * `tenantId` is deliberately ABSENT (FND-001). The target tenant is derived from
 * the authenticated principal via `TenantContextService.requireTenantId()` and is
 * never accepted from the client. Because the global `ValidationPipe` runs with
 * `whitelist: true` and `forbidNonWhitelisted: true`, a client that still sends
 * `tenantId` receives a 400 rather than having it silently ignored.
 */
export class ConvertGuestDto {
  @ApiProperty({ format: 'uuid', description: 'The guest AI conversation to convert.' })
  @IsUUID()
  guestConversationId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'The created patient/customer id.' })
  @IsOptional()
  @IsUUID()
  customerId?: string;
}
