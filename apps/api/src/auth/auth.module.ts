import { Body, Controller, Get, HttpCode, Injectable, Module, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'node:crypto';
import { authenticator } from 'otplib';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.module';
import { AuthUser, CurrentUser, Public, RequirePermissions, ZodPipe } from '../common/auth';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';

export const ACCESS_TTL_SEC = 15 * 60;
export const REFRESH_TTL_MS = 8 * 60 * 60 * 1000; // 8h working session
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;
const COOKIE = 'commhub_rt';
let DUMMY_HASH: string | undefined;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const hashPassword = (p: string) => bcrypt.hash(p, 12);

export const passwordSchema = z.string().min(12, 'Password must be at least 12 characters').max(128);
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(128), mfaCode: z.string().regex(/^\d{6}$/).optional() });

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  signAccess(userId: string) {
    return jwt.sign({ sub: userId, typ: 'access' }, config().JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: ACCESS_TTL_SEC });
  }

  async login(input: z.infer<typeof loginSchema>, ip?: string) {
    const user = await this.prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    const generic = new UnauthorizedException('Invalid credentials');
    if (!user || !user.active) {
      DUMMY_HASH ??= bcrypt.hashSync('timing-equaliser', 12);
      await bcrypt.compare(input.password, DUMMY_HASH); // equalise timing for unknown users
      throw generic;
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) throw new UnauthorizedException('Account temporarily locked');
    const ok = await bcrypt.compare(input.password, user.passwordHash);
    if (!ok) {
      const failed = user.failedLogins + 1;
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLogins: failed >= MAX_FAILED ? 0 : failed, lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MS) : undefined },
      });
      await this.audit.log({ id: user.id, email: user.email }, 'auth.login_failed', 'User', user.id, { ip });
      throw generic;
    }
    if (user.mfaEnabled) {
      if (!input.mfaCode) return { mfaRequired: true as const };
      if (!user.mfaSecret || !authenticator.check(input.mfaCode, user.mfaSecret)) throw new UnauthorizedException('Invalid MFA code');
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
    const refresh = await this.createSession(user.id, ip);
    await this.audit.log({ id: user.id, email: user.email }, 'auth.login', 'User', user.id, { ip });
    return { accessToken: this.signAccess(user.id), refresh, user: { id: user.id, email: user.email, name: user.name, role: user.role, mfaEnabled: user.mfaEnabled } };
  }

  private async createSession(userId: string, ip?: string) {
    const token = randomBytes(48).toString('base64url');
    await this.prisma.session.create({ data: { userId, refreshTokenHash: sha256(token), expiresAt: new Date(Date.now() + REFRESH_TTL_MS), ip } });
    return token;
  }

  /** Rotates the refresh token. Reuse of a revoked token revokes all of the user's sessions. */
  async refresh(token: string | undefined, ip?: string) {
    if (!token) throw new UnauthorizedException();
    const s = await this.prisma.session.findUnique({ where: { refreshTokenHash: sha256(token) }, include: { user: true } });
    if (!s) throw new UnauthorizedException();
    if (s.revokedAt) {
      await this.prisma.session.updateMany({ where: { userId: s.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.log({ id: s.userId, email: s.user.email }, 'auth.refresh_reuse_detected', 'User', s.userId, { ip });
      throw new UnauthorizedException();
    }
    if (s.expiresAt < new Date() || !s.user.active) throw new UnauthorizedException();
    await this.prisma.session.update({ where: { id: s.id }, data: { revokedAt: new Date() } });
    const next = await this.createSession(s.userId, ip);
    const u = s.user;
    return { accessToken: this.signAccess(u.id), refresh: next, user: { id: u.id, email: u.email, name: u.name, role: u.role, mfaEnabled: u.mfaEnabled } };
  }

  async logout(token: string | undefined) {
    if (!token) return;
    await this.prisma.session.updateMany({ where: { refreshTokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } });
  }
}

function setCookie(res: Response, token: string) {
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production',
    path: '/api/auth', maxAge: REFRESH_TTL_MS,
  });
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService, private prisma: PrismaService, private audit: AuditService) {}

  @Public()
  @Throttle({ default: { limit: () => Number(process.env.LOGIN_RATE_LIMIT ?? 5), ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.login(body, req.ip);
    if ('mfaRequired' in r) return r;
    setCookie(res, r.refresh);
    return { accessToken: r.accessToken, user: r.user };
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.refresh(req.cookies?.[COOKIE], req.ip);
    setCookie(res, r.refresh);
    return { accessToken: r.accessToken, user: r.user };
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[COOKIE]);
    res.clearCookie(COOKIE, { path: '/api/auth' });
  }

  @ApiBearerAuth()
  @RequirePermissions()
  @Get('me')
  me(@CurrentUser() u: AuthUser) {
    return u;
  }

  /** Begin MFA enrolment: returns an otpauth URI. MFA is not active until confirmed. */
  @ApiBearerAuth()
  @RequirePermissions()
  @Post('mfa/setup')
  async mfaSetup(@CurrentUser() u: AuthUser) {
    const secret = authenticator.generateSecret();
    await this.prisma.user.update({ where: { id: u.id }, data: { mfaSecret: secret, mfaEnabled: false } });
    return { otpauthUrl: authenticator.keyuri(u.email, 'CommHub', secret), secret };
  }

  @ApiBearerAuth()
  @RequirePermissions()
  @Post('mfa/enable')
  @HttpCode(200)
  async mfaEnable(@CurrentUser() u: AuthUser, @Body(new ZodPipe(z.object({ code: z.string().regex(/^\d{6}$/) }))) b: { code: string }) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    if (!user.mfaSecret || !authenticator.check(b.code, user.mfaSecret)) throw new UnauthorizedException('Invalid MFA code');
    await this.prisma.user.update({ where: { id: u.id }, data: { mfaEnabled: true } });
    await this.audit.log(u, 'auth.mfa_enabled', 'User', u.id);
    return { mfaEnabled: true };
  }
}

@Module({ providers: [AuthService], controllers: [AuthController], exports: [AuthService] })
export class AuthModule {}
