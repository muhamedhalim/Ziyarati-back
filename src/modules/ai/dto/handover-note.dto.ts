import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Internal (staff-only) note against a handover's conversation — never seen by the customer. */
export class HandoverNoteDto {
  @ApiProperty({ description: 'Note content.', maxLength: 4000 })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  content!: string;
}
