import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** Assign an existing tag to a customer (both must belong to the caller tenant). */
export class AssignTagDto {
  @ApiProperty({ description: 'Tag id to assign.', format: 'uuid' })
  @IsUUID()
  tagId!: string;
}
