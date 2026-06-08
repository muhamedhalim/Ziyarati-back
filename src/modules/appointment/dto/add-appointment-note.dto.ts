import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Attach an internal staff note to an appointment. Notes are tenant-scoped and
 * authored by the current user (captured server-side from the principal).
 */
export class AddAppointmentNoteDto {
  @ApiProperty({
    description: 'The internal note content. Visible to clinic staff only.',
    example: 'Patient has a latex allergy — flagged for the practitioner.',
    minLength: 1,
    maxLength: 4000,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  content!: string;
}
