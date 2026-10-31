import {
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

export class MfaVerifyDto {
  @IsString()
  @MaxLength(1000)
  challengeToken!: string;

  @IsOptional()
  @Matches(/^\d{6}$/)
  code?: string;

  @IsOptional()
  @IsString()
  @Length(11, 11)
  recoveryCode?: string;
}

export class MfaChallengeDto {
  @IsString()
  @MaxLength(1000)
  challengeToken!: string;
}

export class MfaConfirmEnrollDto extends MfaChallengeDto {
  @Matches(/^\d{6}$/)
  code!: string;
}

export class MfaCodeDto {
  @Matches(/^\d{6}$/)
  code!: string;
}
