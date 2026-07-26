import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class RejectBillingUpgradeRequestDto {
  @ApiProperty({ description: 'Why the request was rejected (shown to the owner).' })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}
