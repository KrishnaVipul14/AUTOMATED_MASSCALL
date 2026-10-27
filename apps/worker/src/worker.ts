import { DelayedError, Job, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { Prisma, PrismaClient } from '@prisma/client';
import { loadConfig } from '@commhub/configuration';
import {
  getEmergencyStop, getOperatingWindow, isWithinWindow, msUntilWindowOpens,
  productionBlockers, QUEUES, recheckRecipient,
} from '@commhub/domain';
import { createProviders, SmsProvider, VoiceProvider } from '@commhub/provider-adapters';

/**
 * Error thrown only when a request definitely did NOT reach the provider (e.g. connection refused).
 * BullMQ retries these with exponential backoff. Uncertain/timed-out requests do NOT throw this error.
 */
export class RetryableProviderError extends Error {}

export interface WorkerRuntime {
  prisma: PrismaClient;
  redis: IORedis;
  queues: Record<string, Queue>;
  workers: Worker[];
  providers: { voice: VoiceProvider; sms: SmsProvider };
  publishOutboxOnce: () => Promise<number>;
  reconcileOnce: () => Promise<number>;
  shutdown: () => Promise<void>;
}

async function recordJob(prisma: PrismaClient, queue: string, name: string, refId: string | undefined, status: string, attempts = 1, error?: string) {
  await prisma.jobRecord.create({ data: { queue, name, refId, status, attempts, error } });
}

/**
 * Executes a single recipient submission with full pre-execution rechecks and atomic claim.
 * Exported as a pure function over Prisma + providers so it can also be unit/integration tested directly.
 */
export async function processRecipientSubmission(
  prisma: PrismaClient,
  providers: { voice: VoiceProvider; sms: SmsProvider },
  recipientId: string,
  envMode = process.env.PROVIDER_MODE ?? 'MOCK',
): Promise<{ outcome: string; detail?: string }> {
  // 1. Emergency stop check before touching anything.
  const stop = await getEmergencyStop(prisma);
  if (stop.active) return { outcome: 'DEFERRED_EMERGENCY_STOP' };

  const r = await prisma.campaignRecipient.findUnique({
    where: { id: recipientId },
    include: { campaign: { include: { smsTemplate: true, audioAsset: true } } },
  });
  if (!r) return { outcome: 'NOT_FOUND' };

  // 2. Idempotency: if already submitted/terminal/uncertain, never re-send.
  if (r.status !== 'PENDING' && r.status !== 'QUEUED') {
    return { outcome: 'ALREADY_HANDLED', detail: r.status };
  }

  // 3. Campaign state + explicit approval check.
  const c = r.campaign;
  if (c.status === 'CANCELLED') {
    await prisma.campaignRecipient.update({ where: { id: r.id }, data: { status: 'CANCELLED' } });
    return { outcome: 'CANCELLED' };
  }
  if (c.status === 'PAUSED') return { outcome: 'PAUSED' };
  if ((c.status !== 'PROCESSING' && c.status !== 'SCHEDULED') || !c.approverId || !c.approvedAt) {
    return { outcome: 'CAMPAIGN_NOT_EXECUTABLE', detail: c.status };
  }

  // 4. Production gate recheck (if not MOCK).
  if (envMode !== 'MOCK') {
    const blockers = await productionBlockers(prisma, envMode, c.channel);
    if (blockers.length) return { outcome: 'BLOCKED_PRODUCTION_GATE', detail: blockers.join('; ') };
  }

  // 5. Operating window check (enforced in production, or in mock when enforceInMockMode=true).
  const win = await getOperatingWindow(prisma);
  if ((envMode !== 'MOCK' || win.enforceInMockMode) && !isWithinWindow(new Date(), win)) {
    return { outcome: 'OUTSIDE_WINDOW', detail: String(msUntilWindowOpens(new Date(), win)) };
  }

  // 6. Authoritative uncached suppression & preference recheck immediately before submission.
  const ineligible = await recheckRecipient(prisma, r.phoneE164, r.contactId, c.channel);
  if (ineligible) {
    await prisma.campaignRecipient.update({
      where: { id: r.id },
      data: { status: 'SKIPPED_SUPPRESSED', lastError: ineligible },
    });
    await checkCampaignCompletion(prisma, c.id);
    return { outcome: 'SKIPPED_SUPPRESSED', detail: ineligible };
  }

  // 7. Atomic claim: only transition PENDING/QUEUED -> SUBMITTING once.
  const claimed = await prisma.campaignRecipient.updateMany({
    where: { id: r.id, status: { in: ['PENDING', 'QUEUED'] } },
    data: { status: 'SUBMITTING', attempts: { increment: 1 }, submittedAt: new Date() },
  });
  if (claimed.count === 0) return { outcome: 'ALREADY_CLAIMED' };

  // 8. Submit to provider with idempotencyKey.
  const res = c.channel === 'SMS'
    ? await providers.sms.submitMessage({ to: r.phoneE164, body: c.smsTemplate?.body ?? '', idempotencyKey: r.idempotencyKey })
    : await providers.voice.submitCall({ to: r.phoneE164, audioUrl: `storage://${c.audioAsset?.storageKey ?? ''}`, idempotencyKey: r.idempotencyKey });

  if (res.status === 'RETRYABLE') {
    // Request definitely did not reach the provider: reset to QUEUED so BullMQ retry can safely re-attempt.
    await prisma.campaignRecipient.update({
      where: { id: r.id },
      data: { status: 'QUEUED', lastError: res.error ?? 'Retryable transport error' },
    });
    throw new RetryableProviderError(res.error ?? 'Retryable provider error');
  }

  if (res.status === 'UNCERTAIN') {
    // Request may or may not have reached the provider. Mark UNCERTAIN and DO NOT throw (never blindly retry).
    await prisma.campaignRecipient.update({
      where: { id: r.id },
      data: { status: 'UNCERTAIN', providerRef: res.providerRef, lastError: res.error ?? 'Outcome uncertain; awaiting reconciliation', simulated: res.simulated },
    });
    await checkCampaignCompletion(prisma, c.id);
    return { outcome: 'UNCERTAIN' };
  }

  if (res.status === 'FAILED') {
    await prisma.campaignRecipient.update({
      where: { id: r.id },
      data: { status: 'FAILED', providerRef: res.providerRef, lastError: res.error, simulated: res.simulated },
    });
    await checkCampaignCompletion(prisma, c.id);
    return { outcome: 'FAILED', detail: res.error };
  }

  // SUBMITTED or PROVIDER_ACCEPTED: note that this is NOT final delivery / call completion.
  await prisma.campaignRecipient.update({
    where: { id: r.id },
    data: { status: res.status, providerRef: res.providerRef, simulated: res.simulated, lastError: null },
  });
  const segments = c.channel === 'SMS' ? (c.smsTemplate?.segments ?? 1) : 1;
  const now = new Date();
  await prisma.usageCost.create({
    data: {
      provider: c.channel === 'SMS' ? providers.sms.name : providers.voice.name,
      campaignId: c.id, channel: c.channel, quantity: segments,
      unit: c.channel === 'VOICE' ? 'call_attempt' : 'segment',
      amount: new Prisma.Decimal((c.channel === 'VOICE' ? 0.30 : 0.15) * segments),
      currency: 'INR', isEstimate: true, periodStart: now, periodEnd: now,
      reconciliation: res.simulated ? 'SIMULATED' : 'UNRECONCILED',
    },
  });
  return { outcome: res.status, detail: res.providerRef };
}

async function checkCampaignCompletion(prisma: PrismaClient, campaignId: string) {
  const active = await prisma.campaignRecipient.count({
    where: { campaignId, status: { in: ['PENDING', 'QUEUED', 'SUBMITTING'] } },
  });
  if (active === 0) {
    const anyAccepted = await prisma.campaignRecipient.count({
      where: { campaignId, status: { in: ['SUBMITTED', 'PROVIDER_ACCEPTED', 'ANSWERED'] } },
    });
    if (anyAccepted === 0) {
      await prisma.campaign.updateMany({ where: { id: campaignId, status: 'PROCESSING' }, data: { status: 'COMPLETED', completedAt: new Date() } });
    }
  }
}

/** Fans out a scheduled/resumed campaign into per-recipient submission jobs. */
export async function dispatchCampaign(prisma: PrismaClient, queues: Record<string, Queue>, campaignId: string) {
  const stop = await getEmergencyStop(prisma);
  if (stop.active) return { dispatched: 0, reason: 'emergency_stop' };

  const c = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!c || (c.status !== 'SCHEDULED' && c.status !== 'PROCESSING') || !c.approverId) {
    return { dispatched: 0, reason: 'not_executable' };
  }
  if (c.status === 'SCHEDULED') {
    await prisma.campaign.update({ where: { id: c.id }, data: { status: 'PROCESSING', startedAt: c.startedAt ?? new Date() } });
    await prisma.campaignStatusHistory.create({ data: { campaignId: c.id, fromStatus: 'SCHEDULED', toStatus: 'PROCESSING', reason: 'Worker started processing' } });
  }
  const recipients = await prisma.campaignRecipient.findMany({
    where: { campaignId: c.id, status: { in: ['PENDING', 'QUEUED'] } },
    select: { id: true },
  });
  const q = c.channel === 'SMS' ? queues[QUEUES.submitSms] : queues[QUEUES.submitVoice];
  for (const r of recipients) {
    await prisma.campaignRecipient.update({ where: { id: r.id }, data: { status: 'QUEUED' } });
    await q.add(
      'submit-recipient',
      { recipientId: r.id },
      {
        jobId: `recipient_${r.id}`, // BullMQ-level deduplication
        attempts: 3,
        backoff: { type: 'exponential', delay: 500 },
        removeOnComplete: 200,
        removeOnFail: 200,
      },
    );
  }
  return { dispatched: recipients.length };
}

export async function startWorkerRuntime(): Promise<WorkerRuntime> {
  const cfg = loadConfig(process.env);
  const prisma = new PrismaClient();
  await prisma.$connect();
  const redis = new IORedis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
  const providers = createProviders('MOCK', cfg.WEBHOOK_SIGNING_SECRET || 'mock-secret');

  const queues: Record<string, Queue> = {};
  for (const name of Object.values(QUEUES)) queues[name] = new Queue(name, { connection: redis });

  const [smsCfg, voiceCfg] = await Promise.all([
    prisma.providerConfig.findFirst({ where: { channel: 'SMS' } }),
    prisma.providerConfig.findFirst({ where: { channel: 'VOICE' } }),
  ]);

  const makeSubmitWorker = (queueName: string, concurrency: number, ratePerSecond: number) =>
    new Worker(
      queueName,
      async (job: Job<{ recipientId: string }>, token) => {
        const res = await processRecipientSubmission(prisma, providers, job.data.recipientId, cfg.PROVIDER_MODE);
        if (res.outcome === 'OUTSIDE_WINDOW') {
          await job.moveToDelayed(Date.now() + Number(res.detail || 60_000), token);
          throw new DelayedError();
        }
        await recordJob(prisma, queueName, job.name, job.data.recipientId, res.outcome, job.attemptsMade + 1);
        return res;
      },
      {
        connection: redis.duplicate({ maxRetriesPerRequest: null }),
        concurrency,
        limiter: { max: ratePerSecond, duration: 1000 },
      },
    );

  const workers: Worker[] = [
    new Worker(
      QUEUES.campaign,
      async (job: Job<{ campaignId: string }>) => {
        const r = await dispatchCampaign(prisma, queues, job.data.campaignId);
        await recordJob(prisma, QUEUES.campaign, job.name, job.data.campaignId, 'COMPLETED', 1);
        return r;
      },
      { connection: redis.duplicate({ maxRetriesPerRequest: null }), concurrency: 2 },
    ),
    makeSubmitWorker(QUEUES.submitSms, smsCfg?.maxConcurrency ?? 4, smsCfg?.ratePerSecond ?? 10),
    makeSubmitWorker(QUEUES.submitVoice, voiceCfg?.maxConcurrency ?? 2, voiceCfg?.ratePerSecond ?? 5),
    new Worker(
      QUEUES.contactImport,
      async (job: Job<{ batchId: string }>) => {
        await recordJob(prisma, QUEUES.contactImport, job.name, job.data.batchId, 'COMPLETED', 1);
        return { batchId: job.data.batchId };
      },
      { connection: redis.duplicate({ maxRetriesPerRequest: null }), concurrency: 2 },
    ),
    new Worker(
      QUEUES.providerStatus,
      async (job: Job<{ providerEventId: string }>) => {
        await recordJob(prisma, QUEUES.providerStatus, job.name, job.data.providerEventId, 'COMPLETED', 1);
        return { providerEventId: job.data.providerEventId };
      },
      { connection: redis.duplicate({ maxRetriesPerRequest: null }), concurrency: 4 },
    ),
    new Worker(
      QUEUES.reports,
      async (job: Job<{ campaignId?: string }>) => {
        await recordJob(prisma, QUEUES.reports, job.name, job.data?.campaignId, 'COMPLETED', 1);
        return { ok: true };
      },
      { connection: redis.duplicate({ maxRetriesPerRequest: null }), concurrency: 1 },
    ),
    new Worker(
      QUEUES.maintenance,
      async (job: Job) => {
        const reconciled = await reconcileOnce();
        await recordJob(prisma, QUEUES.maintenance, job.name, undefined, 'COMPLETED', 1);
        return { reconciled };
      },
      { connection: redis.duplicate({ maxRetriesPerRequest: null }), concurrency: 1 },
    ),
  ];

  /** Outbox publisher: atomically claims PENDING outbox rows and enqueues them to BullMQ with deterministic jobIds. */
  const publishOutboxOnce = async (): Promise<number> => {
    const pending = await prisma.outboxEvent.findMany({
      where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 50,
    });
    let published = 0;
    for (const ev of pending) {
      try {
        const p = ev.payload as Record<string, unknown>;
        if (ev.type === 'campaign.schedule' || ev.type === 'campaign.resume') {
          const scheduledAt = typeof p.scheduledAt === 'string' ? new Date(p.scheduledAt) : new Date();
          const delay = Math.max(0, scheduledAt.getTime() - Date.now());
          await queues[QUEUES.campaign].add('dispatch-campaign', { campaignId: p.campaignId }, { jobId: `outbox_${ev.id}`, delay });
        } else if (ev.type === 'contact-import.validate' || ev.type === 'contact-import.commit') {
          await queues[QUEUES.contactImport].add(ev.type, p, { jobId: `outbox_${ev.id}` });
        } else if (ev.type === 'provider-event.process') {
          await queues[QUEUES.providerStatus].add(ev.type, p, { jobId: `outbox_${ev.id}` });
        } else if (ev.type === 'report.generate') {
          await queues[QUEUES.reports].add(ev.type, p, { jobId: `outbox_${ev.id}` });
        }
        await prisma.outboxEvent.update({ where: { id: ev.id }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
        published++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'outbox publish failed';
        await prisma.outboxEvent.update({
          where: { id: ev.id },
          data: { attempts: { increment: 1 }, lastError: msg, status: ev.attempts + 1 >= 5 ? 'FAILED' : 'PENDING' },
        });
      }
    }
    return published;
  };

  /**
   * Reconciler: any recipient stuck in SUBMITTING for >2 minutes (e.g. worker crashed mid-HTTP call)
   * is moved to UNCERTAIN (never auto-retried), and UNCERTAIN rows with a providerRef are polled via getStatus.
   */
  const reconcileOnce = async (): Promise<number> => {
    const cutoff = new Date(Date.now() - 2 * 60_000);
    const stuck = await prisma.campaignRecipient.updateMany({
      where: { status: 'SUBMITTING', submittedAt: { lt: cutoff } },
      data: { status: 'UNCERTAIN', lastError: 'Worker interrupted during submission; outcome uncertain' },
    });
    const uncertain = await prisma.campaignRecipient.findMany({
      where: { status: 'UNCERTAIN', providerRef: { not: null } },
      include: { campaign: { select: { channel: true } } },
      take: 50,
    });
    let resolved = 0;
    for (const u of uncertain) {
      const st = u.campaign.channel === 'SMS'
        ? await providers.sms.getMessageStatus(u.providerRef!)
        : await providers.voice.getCallStatus(u.providerRef!);
      if (st.status !== 'UNCERTAIN') {
        await prisma.campaignRecipient.update({ where: { id: u.id }, data: { status: st.status } });
        resolved++;
      }
    }
    return stuck.count + resolved;
  };

  const shutdown = async () => {
    for (const w of workers) await w.close();
    for (const q of Object.values(queues)) await q.close();
    await redis.quit();
    await prisma.$disconnect();
  };

  return { prisma, redis, queues, workers, providers, publishOutboxOnce, reconcileOnce, shutdown };
}
