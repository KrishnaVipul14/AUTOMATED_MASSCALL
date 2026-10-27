import {
  BadRequestException, CanActivate, createParamDecorator, ExecutionContext,
  ForbiddenException, Injectable, PipeTransform, SetMetadata, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import { ZodSchema } from 'zod';
import { Permission, Role, RolePermissions } from '@commhub/shared-types';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';

export interface AuthUser { id: string; email: string; role: Role; name: string }

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const PERMS = 'permissions';
/** Every non-public route must declare the permission(s) it requires. */
export const RequirePermissions = (...p: Permission[]) => SetMetadata(PERMS, p);

export const CurrentUser = createParamDecorator((_d, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);

export function hasPermission(role: Role, p: Permission) {
  return RolePermissions[role].includes(p);
}

/**
 * Global guard: verifies the bearer access token, reloads the user from the DB
 * (so deactivation / role changes take effect immediately) and enforces permissions.
 * Routes that are neither @Public nor annotated with permissions are denied by default.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();
    let payload: { sub: string; typ?: string };
    try {
      payload = jwt.verify(header.slice(7), config().JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as typeof payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    if (payload.typ !== 'access') throw new UnauthorizedException();
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.active) throw new UnauthorizedException();
    req.user = { id: user.id, email: user.email, role: user.role, name: user.name } satisfies AuthUser;

    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMS, targets);
    if (required === undefined) throw new ForbiddenException('Route has no permission policy');
    if (!required.every((p) => hasPermission(user.role as Role, p))) throw new ForbiddenException('Insufficient permissions');
    return true;
  }
}

export class ZodPipe<T> implements PipeTransform {
  constructor(private schema: ZodSchema<T>) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      throw new BadRequestException({ message: 'Validation failed', issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    return r.data;
  }
}
