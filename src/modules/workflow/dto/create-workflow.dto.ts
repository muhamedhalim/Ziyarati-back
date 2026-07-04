import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { WORKFLOW_TRIGGERS } from '../workflow.constants';
import { WorkflowActionDto, WorkflowConditionDto } from './workflow-spec.dto';

/** Creates a tenant automation (Event → Conditions → Actions). */
export class CreateWorkflowDto {
  @ApiProperty({ description: 'Human-readable name.', example: 'WhatsApp reminder on booking', maxLength: 160 })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional({ description: 'Optional description.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ description: 'Domain event that triggers this workflow.', enum: WORKFLOW_TRIGGERS })
  @IsIn(WORKFLOW_TRIGGERS)
  triggerEvent!: string;

  @ApiPropertyOptional({ description: 'Active flag. Defaults to true.', default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Conditions (ALL must match). Empty = always run.', type: [WorkflowConditionDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowConditionDto)
  conditions?: WorkflowConditionDto[];

  @ApiProperty({ description: 'Actions to execute (1–20).', type: [WorkflowActionDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => WorkflowActionDto)
  actions!: WorkflowActionDto[];
}
