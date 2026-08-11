import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';

import { Patient } from '../../entities/Patients/Patient';
import { RegisterPatientDto } from './dto/register-patient.dto';
import { AuthTokens } from './interfaces/auth-tokens.interface';
import { AppError, ErrorCode } from '../../common/errors';

const BCRYPT_ROUNDS = 12;

export interface PatientAuthResult extends AuthTokens {
  patient: {
    id: string;
    email: string;
    fullName?: string | null;
    type: 'patient';
  };
}

/**
 * Authentication for external B2C patients — completely separate from the
 * tenant/RBAC user flows.
 *
 * Isolation guarantees:
 *  - patients live in their own `patients` table (never `users`), so they can
 *    never appear in `buildAuthenticatedUser` or any tenant relation;
 *  - patient tokens carry `type: 'patient'`, so the existing JwtStrategy (which
 *    only accepts `type: 'access'`) rejects them on tenant/RBAC endpoints —
 *    no guard or strategy change required.
 */
@Injectable()
export class PatientService {
  constructor(
    @InjectRepository(Patient)
    private readonly patients: Repository<Patient>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async registerPatient(dto: RegisterPatientDto): Promise<PatientAuthResult> {
    const existing = await this.patients.findOne({
      where: { email: dto.email },
    });
    if (existing) {
      throw new AppError(ErrorCode.EMAIL_ALREADY_EXISTS);
    }

    const patient = await this.patients.save(
      this.patients.create({
        email: dto.email,
        phone: dto.phone,
        full_name: dto.fullName,
        password_hash: await bcrypt.hash(dto.password, BCRYPT_ROUNDS),
        is_active: true,
      }),
    );

    const tokens = await this.issuePatientTokens(patient.id);
    return {
      ...tokens,
      patient: {
        id: patient.id,
        email: patient.email,
        fullName: patient.full_name ?? null,
        type: 'patient',
      },
    };
  }

  /**
   * Issues a patient-scoped token pair. Distinct `type` claims keep these
   * tokens unusable against tenant endpoints while remaining standard JWTs.
   */
  private async issuePatientTokens(patientId: string): Promise<AuthTokens> {
    const accessTtl = this.config.get<string>('JWT_ACCESS_TTL', '15m');
    const refreshTtl = this.config.get<string>('JWT_REFRESH_TTL', '7d');

    const accessToken = await this.jwt.signAsync(
      { sub: patientId, type: 'patient' },
      {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: accessTtl as JwtSignOptions['expiresIn'],
      },
    );

    const refreshToken = await this.jwt.signAsync(
      { sub: patientId, type: 'patient_refresh' },
      {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: refreshTtl as JwtSignOptions['expiresIn'],
      },
    );

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.ttlToSeconds(accessTtl),
    };
  }

  /** Converts a jwt-style duration ("15m", "7d", "900") to seconds. */
  private ttlToSeconds(ttl: string): number {
    const match = /^(\d+)\s*([smhd])?$/.exec(ttl.trim());
    if (!match) return 0;
    const value = Number(match[1]);
    const unit = match[2] ?? 's';
    const seconds: Record<string, number> = {
      s: 1,
      m: 60,
      h: 3600,
      d: 86400,
    };
    return value * seconds[unit];
  }
}
