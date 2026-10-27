import { Body, Controller, Get, Header, Injectable, Module, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { z } from 'zod';
import { maskPhone } from '@commhub/domain';
import { AuditService } from '../audit/audit.module';
import { AuthUser, CurrentUser, RequirePermissions, ZodPipe } from '../common/auth';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';

const filterSchema = z.object({
  campaignId: z.string().uuid().optional(),
  channel: z.enum(['VOICE', 'SMS']).optional(),
  status: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  includeFullPhone: z.enum(['true', 'false']).default('false'),
});

const usageSchema = z.object({
  provider: z.string().min(1).max(60),
  campaignId: z.string().uuid().optional(),
  channel: z.enum(['VOICE', 'SMS']),
  quantity: z.number().int().min(0),
  unit: z.string().min(1).max(30),
  amount: z.number().min(0),
  currency: z.string().length(3).default('INR'),
  isEstimate: z.boolean(),
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
  reconciliation: z.enum(['UNRECONCILED', 'PROVIDER_REPORTED', 'RECONCILED', 'SIMULATED']).default('UNRECONCILED'),
});

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  /**
   * Outcome report. Explicitly separates SUBMITTED, PROVIDER_ACCEPTED, ANSWERED, COMPLETED and DELIVERED,
   * and separates simulated results from real provider-reported results so simulated data is never mistaken for real delivery.
   */
  async outcomes(q: z.infer<typeof filterSchema>) {
    const where: Prisma.CampaignRecipientWhereInput = {
      campaignId: q.campaignId,
      status: q.status ? (q.status as Prisma.EnumRecipientStatusFilter['equals']) : undefined,
      createdAt: q.from || q.to ? { gte: q.from, lte: q.to } : undefined,
      campaign: q.channel ? { channel: q.channel } : undefined,
    };
    const [grouped, campaigns, usage] = await Promise.all([
      this.prisma.campaignRecipient.groupBy({ where, by: ['status', 'simulated'], _count: { _all: true } }),
      this.prisma.campaign.findMany({
        where: { id: q.campaignId, channel: q.channel, createdAt: q.from || q.to ? { gte: q.from, lte: q.to } : undefined },
        orderBy: { createdAt: 'desc' },
        select: { id: true, name: true, channel: true, status: true, simulated: true, scheduledAt: true, startedAt: true, completedAt: true, createdAt: true },
      }),
      this.prisma.usageCost.findMany({
        where: { campaignId: q.campaignId, channel: q.channel, createdAt: q.from || q.to ? { gte: q.from, lte: q.to } : undefined },
        orderBy: { createdAt: 'desc' }, take: 200,
      }),
    ]);
    const counts: Record<string, { real: number; simulated: number }> = {};
    for (const g of grouped) {
      counts[g.status] ??= { real: 0, simulated: 0 };
      counts[g.status][g.simulated ? 'simulated' : 'real'] += g._count._all;
    }
    const costSummary = {
      estimatedInr: usage.filter((u) => u.isEstimate).reduce((s, u) => s + Number(u.amount), 0).toFixed(4),
      providerReportedInr: usage.filter((u) => !u.isEstimate).reduce((s, u) => s + Number(u.amount), 0).toFixed(4),
    };
    return {
      mode: config().PROVIDER_MODE,
      note: 'ANSWERED indicates call connection only; COMPLETED indicates the announcement finished playing.',
      counts, campaigns, usage, costSummary,
    };
  }

  async exportCsv(actor: AuthUser, q: z.infer<typeof filterSchema>) {
    const rows = await this.prisma.campaignRecipient.findMany({
      where: {
        campaignId: q.campaignId,
        status: q.status ? (q.status as Prisma.EnumRecipientStatusFilter['equals']) : undefined,
        createdAt: q.from || q.to ? { gte: q.from, lte: q.to } : undefined,
        campaign: q.channel ? { channel: q.channel } : undefined,
      },
      include: { campaign: { select: { name: true, channel: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 50_000,
    });
    const full = q.includeFullPhone === 'true' && actor.role === 'ADMIN';
    await this.audit.log(actor, 'report.exported_csv', 'CampaignRecipient', q.campaignId ?? null, { rows: rows.length, masked: !full });
    const header = 'campaign_id,campaign_name,channel,phone,status,simulated,provider_ref,attempts,submitted_at,updated_at\n';
    const body = rows.map((r) => [
      r.campaignId,
      `"${r.campaign.name.replace(/"/g, '""')}"`,
      r.campaign.channel,
      full ? r.phoneE164 : maskPhone(r.phoneE164),
      r.status,
      r.simulated ? 'SIMULATED' : 'REAL',
      r.providerRef ?? '',
      r.attempts,
      r.submittedAt?.toISOString() ?? '',
      r.updatedAt.toISOString(),
    ].join(',')).join('\n');
    return header + body + '\n';
  }

  async recordUsage(actor: AuthUser, b: z.infer<typeof usageSchema>) {
    const rec = await this.prisma.usageCost.create({
      data: { ...b, amount: new Prisma.Decimal(b.amount) },
    });
    await this.audit.log(actor, 'usage_cost.recorded', 'UsageCost', rec.id, { isEstimate: b.isEstimate, amount: b.amount });
    return rec;
  }
}

@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private svc: ReportsService) {}

  @Get('outcomes')
  @RequirePermissions('reports:read')
  outcomes(@Query(new ZodPipe(filterSchema)) q: z.infer<typeof filterSchema>) { return this.svc.outcomes(q); }

  @Get('export.csv')
  @RequirePermissions('reports:export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportCsv(@CurrentUser() u: AuthUser, @Query(new ZodPipe(filterSchema)) q: z.infer<typeof filterSchema>, @Res() res: Response) {
    const csv = await this.svc.exportCsv(u, q);
    res.setHeader('Content-Disposition', 'attachment; filename="outcomes-report.csv"');
    res.send(csv);
  }

  @Post('usage')
  @RequirePermissions('settings:manage')
  recordUsage(@CurrentUser() u: AuthUser, @Body(new ZodPipe(usageSchema)) b: z.infer<typeof usageSchema>) {
    return this.svc.recordUsage(u, b);
  }
}

@Module({ providers: [ReportsService], controllers: [ReportsController] })
export class ReportsModule {}
