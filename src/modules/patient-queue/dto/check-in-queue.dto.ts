import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** F10 — `POST /queue/check-in`. */
export class CheckInQueueDto {
  @ApiProperty({
    description: "The patient's appointment to check in.",
    format: 'uuid',
  })
  @IsUUID()
  appointmentId!: string;
}
