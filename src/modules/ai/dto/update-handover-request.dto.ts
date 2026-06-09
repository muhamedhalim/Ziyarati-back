import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Update mutable handover fields (reason). Lifecycle uses the action endpoints. */
export class UpdateHandoverRequestDto {
  @ApiPropertyOptional({ description: 'Updated reason / note.', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
