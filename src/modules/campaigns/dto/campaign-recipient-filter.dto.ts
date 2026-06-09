import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { RecipientStatus } from '../../../entities/enums';

/** Filter + pagination for a campaign's recipients (scoped via the campaign). */
export class CampaignRecipientFilterDto {
  @ApiPropertyOptional({
    description: 'Filter by recipient delivery status.',
    enum: RecipientStatus,
    example: RecipientStatus.FAILED,
  })
  @IsOptional()
  @IsEnum(RecipientStatus)
  status?: RecipientStatus;

  @ApiPropertyOptional({ description: 'Filter by a specific customer.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ description: 'Page number (1-based).', example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: 'Results per page. Max 200.', example: 50, minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;
}
