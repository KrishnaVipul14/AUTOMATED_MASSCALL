import { Controller, Get, Global, Injectable, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuthUser, RequirePermissions, ZodPipe } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';

type Tx = Prisma.TransactionClient | PrismaService;

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  /** Writes an audit entry. Pass a transaction client to make it atomic with the change. */
  log(
    actor: Pick<AuthUser, 'id' | 'email'> | null,
    action: string,
    entityType: string,
    entityId?: string | null,
    metadata: Record<string, unknown> = {},
    tx: Tx = this.prisma,
  ) {
    return tx.auditLog.create({
      data: {
        actorId: actor?.id, actorEmail: actor?.email, action, entityType,
        entityId: entityId ?? undefined, metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }
}

const query = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  action: z.string().optional(),
  entityType: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit-logs')
export class AuditController {
  constructor(private prisma: PrismaService) {}

  @Get()
  @RequirePermissions('audit:read')
  async list(@Query(new ZodPipe(query)) q: z.infer<typeof query>) {
    const where: Prisma.AuditLogWhereInput = {
      action: q.action ? { contains: q.action } : undefined,
      entityType: q.entityType,
      createdAt: q.from || q.to ? { gte: q.from, lte: q.to } : undefined,
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }
}

@Global()
@Module({ providers: [AuditService], controllers: [AuditController], exports: [AuditService] })
export class AuditModule {}
