import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../common/auth';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  async summary() {
    const p = this.prisma;
    const [totalContacts, suppressions, eligibleRows, byStatus, recipientStats, recent, providers, providerErrors, usage, emergency, pendingJobs] = await Promise.all([
      p.contact.count(),
      p.suppression.count(),
      p.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM "Contact" c WHERE NOT EXISTS (SELECT 1 FROM "Suppression" s WHERE s."phoneE164" = c."phoneE164")`,
      p.campaign.groupBy({ by: ['status'], _count: { _all: true } }),
      p.campaignRecipient.groupBy({ by: ['status', 'simulated'], _count: { _all: true } }),
      p.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, action: true, entityType: true, actorEmail: true, createdAt: true } }),
      p.providerConfig.findMany({ select: { channel: true, adapter: true, enabled: true, mode: true, approvalVerified: true } }),
      p.providerEvent.count({ where: { error: { not: null }, receivedAt: { gte: new Date(Date.now() - 24 * 3600_000) } } }),
      p.usageCost.groupBy({ by: ['channel', 'currency', 'isEstimate'], _sum: { amount: true, quantity: true } }),
      p.systemSetting.findUnique({ where: { key: 'emergencyStop' } }),
      p.outboxEvent.count({ where: { status: 'PENDING' } }),
    ]);
    const outcome: Record<string, { real: number; simulated: number }> = {};
    for (const r of recipientStats) {
      outcome[r.status] ??= { real: 0, simulated: 0 };
      outcome[r.status][r.simulated ? 'simulated' : 'real'] += r._count._all;
    }
    return {
      mode: config().PROVIDER_MODE,
      emergencyStop: Boolean((emergency?.value as { active?: boolean } | null)?.active),
      contacts: { total: totalContacts, eligible: Number(eligibleRows[0]?.n ?? 0), suppressionRecords: suppressions },
      campaignsByStatus: Object.fromEntries(byStatus.map((b) => [b.status, b._count._all])),
      pendingOutboxJobs: pendingJobs,
      outcomes: outcome,
      recentActivity: recent,
      providers: { configs: providers, errorsLast24h: providerErrors },
      usage: usage.map((u) => ({ channel: u.channel, currency: u.currency, isEstimate: u.isEstimate, amount: u._sum.amount?.toString() ?? '0', quantity: u._sum.quantity ?? 0 })),
    };
  }
}

@ApiTags('dashboard')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private svc: DashboardService) {}
  @Get('summary')
  @RequirePermissions('reports:read')
  summary() {
    return this.svc.summary();
  }
}

@Module({ providers: [DashboardService], controllers: [DashboardController] })
export class DashboardModule {}
