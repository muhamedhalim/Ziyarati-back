import { IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SetPlatformStaffStatusDto {
  @ApiProperty({
    description: 'true = activate (can sign in), false = deactivate.',
    example: false,
  })
  @IsBoolean()
  isActive!: boolean;
}
