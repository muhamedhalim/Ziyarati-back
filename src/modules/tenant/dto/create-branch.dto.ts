import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateBranchDto {
  @IsString()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsOptional()
  @IsUUID()
  cityId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  /** Branch-level WhatsApp number — each branch runs its own WhatsApp system. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  whatsappPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}
