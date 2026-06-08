import { IsJWT } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RefreshTokenDto {
  @ApiProperty({
    description:
      'The refresh token returned by login or the previous refresh call. Must be a valid JWT string. One-time-use — sending the same token twice will fail.',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1dWlkIiwidHlwZSI6InJlZnJlc2gifQ.sig',
  })
  @IsJWT()
  refreshToken!: string;
}
