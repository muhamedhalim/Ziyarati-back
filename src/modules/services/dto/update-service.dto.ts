import { PartialType } from '@nestjs/swagger';
import { CreateServiceDto } from './create-service.dto';

/** Partial update of a service (all fields optional). */
export class UpdateServiceDto extends PartialType(CreateServiceDto) {}
