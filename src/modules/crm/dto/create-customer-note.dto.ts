import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** Add an internal (staff-only) note to a customer. */
export class CreateCustomerNoteDto {
  @ApiProperty({ description: 'Note content.', example: 'Prefers afternoon appointments.' })
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  content!: string;
}
