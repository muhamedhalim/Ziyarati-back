import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  WORKFLOW_ACTION_TYPES,
  WORKFLOW_OPERATORS,
} from '../workflow.constants';

/** One AND-ed condition evaluated against the run context. */
export class WorkflowConditionDto {
  @ApiProperty({ description: 'Context field path, e.g. `reason` or `amount`.', example: 'amount' })
  @IsString()
  field!: string;

  @ApiProperty({ description: 'Comparison operator.', enum: WORKFLOW_OPERATORS, example: 'gte' })
  @IsIn(WORKFLOW_OPERATORS)
  operator!: string;

  @ApiPropertyOptional({ description: 'Value to compare against (type depends on operator).' })
  @IsOptional()
  value?: unknown;
}

/** One action step. `config` is validated per-type in the executor. */
export class WorkflowActionDto {
  @ApiProperty({ description: 'Action type.', enum: WORKFLOW_ACTION_TYPES, example: 'EMAIL' })
  @IsIn(WORKFLOW_ACTION_TYPES)
  type!: string;

  @ApiProperty({
    description:
      'Action configuration. EMAIL: {to,template?,subject?,body?,variables?}; WHATSAPP: {to?,text}; ' +
      'NOTIFICATION: {templateId,recipientType?,recipientId?}; WEBHOOK: {url,secret?}; AI: {agentId?,prompt}.',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  config!: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Delay in minutes before this action runs.', minimum: 0, maximum: 43200 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(43200)
  delayMinutes?: number;
}
