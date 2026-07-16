import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** Internal admin note — never visible to tenant users. */
export class AddTicketNoteDto {
  @ApiProperty({ maxLength: 2000, example: 'Escalated to engineering, awaiting fix ETA.' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  note!: string;
}
