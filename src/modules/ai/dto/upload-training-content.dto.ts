import { IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UploadTrainingContentDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Tenant-owned AI agent that will use this file.' })
  @IsOptional() @IsUUID()
  agentId?: string;
}
