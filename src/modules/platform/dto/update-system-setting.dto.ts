import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** PLATFORM-ONLY (super admin). Update a global system setting. */
export class UpdateSystemSettingDto {
  @ApiPropertyOptional({ description: 'New unique key.', example: 'maintenance_mode' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  key?: string;

  @ApiPropertyOptional({ description: 'New value (any JSON).', example: true })
  @IsOptional()
  value?: any;
}
