import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsUUID, ValidateNested } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { InvoiceItemInputDto } from './add-invoice-item.dto';

/**
 * Create a DRAFT invoice for the caller's tenant. The invoice number is
 * generated server-side (tenant-scoped). Items are optional at creation and can
 * be added later via the add-items endpoint; the total is auto-calculated.
 */
export class CreateInvoiceDto {
  @ApiPropertyOptional({ description: 'Customer the invoice is billed to.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ description: 'Appointment the invoice relates to.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  appointmentId?: string;

  @ApiPropertyOptional({ description: 'Optional initial line items.', type: [InvoiceItemInputDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InvoiceItemInputDto)
  items?: InvoiceItemInputDto[];
}
