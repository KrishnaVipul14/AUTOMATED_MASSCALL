import { BadRequestException, Body, Controller, ForbiddenException, Get, Module, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Roles } from '@commhub/shared-types';
import { AuditService } from '../audit/audit.module';
import { hashPassword, passwordSchema } from '../auth/auth.module';
import { AuthUser, CurrentUser, RequirePermissions, ZodPipe } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';

const createSchema = z.object({ email: z.string().email(), name: z.string().min(1).max(100), role: z.enum(Roles), password: passwordSchema });
const updateSchema = z.object({ name: z.string().min(1).max(100).optional(), role: z.enum(Roles).optional(), active: z.boolean().optional() });
const publicFields = { id: true, email: true, name: true, role: true, active: true, mfaEnabled: true, createdAt: true } as const;

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  @Get()
  @RequirePermissions('users:manage')
  list() {
    return this.prisma.user.findMany({ select: publicFields, orderBy: { createdAt: 'asc' } });
  }

  @Post()
  @RequirePermissions('users:manage')
  async create(@CurrentUser() actor: AuthUser, @Body(new ZodPipe(createSchema)) b: z.infer<typeof createSchema>) {
    const email = b.email.toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) throw new BadRequestException('Email already exists');
    const user = await this.prisma.user.create({ data: { email, name: b.name, role: b.role, passwordHash: await hashPassword(b.password) }, select: publicFields });
    await this.audit.log(actor, 'user.created', 'User', user.id, { role: b.role });
    return user;
  }

  @Patch(':id')
  @RequirePermissions('users:manage')
  async update(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body(new ZodPipe(updateSchema)) b: z.infer<typeof updateSchema>) {
    // Prevent self-modification of role/active state (no self-escalation or self-lockout).
    if (id === actor.id && (b.role !== undefined || b.active !== undefined)) throw new ForbiddenException('You cannot change your own role or status');
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException();
    const user = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({ where: { id }, data: b, select: publicFields });
      if (b.active === false || (b.role && b.role !== existing.role)) {
        await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      await this.audit.log(actor, 'user.updated', 'User', id, { before: { role: existing.role, active: existing.active }, changes: b }, tx);
      return u;
    });
    return user;
  }
}

@Module({ controllers: [UsersController] })
export class UsersModule {}
