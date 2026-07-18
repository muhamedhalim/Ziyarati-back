import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy, type JwtFromRequestFunction } from 'passport-jwt';
import type { Request } from 'express';
import { AuthService } from '../auth.service';
import { CookieService } from '../cookie.service';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { AppError, ErrorCode } from '../../../common/errors';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly authService: AuthService,
  ) {
    // Primary source: the HttpOnly access_token cookie. In non-production we
    // also accept the Bearer header so Swagger / API tooling keeps working.
    const cookieExtractor: JwtFromRequestFunction = (req: Request) =>
      (req?.cookies?.[CookieService.ACCESS_COOKIE] as string | undefined) ??
      null;

    const extractors: JwtFromRequestFunction[] = [cookieExtractor];
    if (config.get<string>('NODE_ENV') !== 'production') {
      extractors.push(ExtractJwt.fromAuthHeaderAsBearerToken());
    }

    super({
      jwtFromRequest: ExtractJwt.fromExtractors(extractors),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  /**
   * Passport calls this with the decoded, signature-verified payload. We
   * resolve the live user (roles/permissions may have changed since the token
   * was issued) and return the principal stored on `request.user`.
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    if (payload.type !== 'access') {
      throw new AppError(ErrorCode.UNAUTHORIZED, { message: 'Invalid token type' });
    }
    return this.authService.buildAuthenticatedUser(payload.sub);
  }
}
