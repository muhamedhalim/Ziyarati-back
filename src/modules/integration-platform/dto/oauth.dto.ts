import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * OAuth callback payload. Deliberately does NOT accept a redirect URI — the
 * redirect is taken from the provider's compiled allowlist and from the stored
 * handshake, never echoed back from the caller (open-redirect defense).
 */
export class OAuthCallbackDto {
  @ApiProperty({ description: 'The single-use `state` issued when authorization started.' })
  @IsString()
  @MaxLength(128)
  state!: string;

  @ApiPropertyOptional({ description: 'Authorization code from the provider.' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  code?: string;

  @ApiPropertyOptional({ description: 'Provider error code when the user declined.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  error?: string;
}
