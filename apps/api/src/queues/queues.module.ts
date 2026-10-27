import { Controller, Get, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { QUEUES } from '@commhub/domain';
import { RequirePermissions } from '../common/auth';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class QueuesService implements OnModuleDestroy {
  private redis?: IORedis;
  private queues = new Map<string, Queue>();

  private getQueue(name: string): Queue {
    if (!this.redis) this.redis = new IORedis(config().REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.redis });
      this.queues.set(name, q);
    }
    return q;
  }

  async health() {
    const out: Record<string, { counts: Record<string, number>; failed: { id?: string; name: string; failedReason: string; attemptsMade: number }[] }> = {};
    let redisOk = true;
    try {
      for (const name of Object.values(QUEUES)) {
        const q = this.getQueue(name);
        const [counts, failed] = await Promise.all([q.getJobCounts(), q.getFailed(0, 10)]);
        out[name] = {
          counts,
          failed: failed.map((j) => ({ id: j.id, name: j.name, failedReason: j.failedReason, attemptsMade: j.attemptsMade })),
        };
      }
    } catch {
      redisOk = false;
    }
    const [pendingOutbox, failedOutbox, recentJobs] = await Promise.all([
      this.prisma.outboxEvent.count({ where: { status: 'PENDING' } }),
      this.prisma.outboxEvent.count({ where: { status: 'FAILED' } }),
      this.prisma.jobRecord.findMany({ orderBy: { updatedAt: 'desc' }, take: 30 }),
    ]);
    return { redisOk, queues: out, outbox: { pending: pendingOutbox, failed: failedOutbox }, recentJobs };
  }

  constructor(private prisma: PrismaService) {}

  async onModuleDestroy() {
    for (const q of this.queues.values()) await q.close().catch(() => undefined);
    if (this.redis) await this.redis.quit().catch(() => undefined);
  }
}

@ApiTags('queues')
@ApiBearerAuth()
@Controller('queues')
export class QueuesController {
  constructor(private svc: QueuesService) {}
  @Get('health')
  @RequirePermissions('reports:read')
  health() { return this.svc.health(); }
}

@Module({ providers: [QueuesService], controllers: [QueuesController], exports: [QueuesService] })
export class QueuesModule {}
