import {
  BadRequestException, Body, Controller, Get, HttpCode, Injectable, Module,
  Param, Post, RawBodyRequest, Req, UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma, RecipientStatus } from '@prisma/client';
import type { Request } from 'express';
import { z } from 'zod';
import { createProviders, MockSmsProvider, MockVoiceProvider, NormalisedEvent, signBody } from '@commhub/provider-adapters';
import { OutcomeStatus, shouldApplyOutcome } from '@commhub/shared-types';
import { enqueueOutbox, normalisePhone } from '@commhub/domain';
import { AuditService } from '../audit/audit.module';
import { AuthUser, CurrentUser, Public, RequirePermissions, ZodPipe } from '../common/auth';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Applies a normalised provider event idempotently to PostgreSQL.
 * Also exported so the BullMQ provider-status worker can use the exact same logic.
 */
export async function applyNormalisedEvent(prisma: PrismaService, provider: string, ev: NormalisedEvent, simulated: boolean) {
  if (ev.kind === 'opt_out') {
    const phone = normalisePhone(ev.phone) ?? ev.phone;
    await prisma.suppression.upsert({
      where: { phoneE164: phone },
      update: { reason: 'Provider-reported opt-out', source: `WEBHOOK:${provider}` },
      create: { phoneE164: phone, reason: 'Provider-reported opt-out', source: `WEBHOOK:${provider}` },
    });
    return { applied: true, detail: 'opt_out_recorded' };
  }

  const recipient = await prisma.campaignRecipient.findFirst({ where: { providerRef: ev.providerRef } });
  if (!recipient) return { applied: false, detail: 'unknown_provider_ref' };

  const current = (recipient.status === 'PENDING' || recipient.status === 'QUEUED' || recipient.status === 'SUBMITTING'
    ? 'SUBMITTED' : recipient.status) as OutcomeStatus;
  if (!shouldApplyOutcome(current, ev.status)) {
    return { applied: false, detail: `ignored_regression_or_duplicate(${recipient.status}->${ev.status})` };
  }

  await prisma.$transaction(async (tx) => {
    await tx.campaignRecipient.update({
      where: { id: recipient.id },
      data: { status: ev.status as RecipientStatus },
    });
    if (ev.cost) {
      const camp = await tx.campaign.findUnique({ where: { id: recipient.campaignId }, select: { channel: true } });
      if (camp) {
        const now = new Date();
        await tx.usageCost.create({
          data: {
            provider, campaignId: recipient.campaignId, channel: camp.channel,
            quantity: 1, unit: camp.channel === 'VOICE' ? 'call' : 'segment',
            amount: new Prisma.Decimal(ev.cost.amount), currency: ev.cost.currency,
            isEstimate: simulated, periodStart: now, periodEnd: now,
            reconciliation: simulated ? 'SIMULATED' : 'PROVIDER_REPORTED',
          },
        });
      }
    }
    const remaining = await tx.campaignRecipient.count({
      where: { campaignId: recipient.campaignId, status: { in: ['PENDING', 'QUEUED', 'SUBMITTING', 'SUBMITTED', 'PROVIDER_ACCEPTED', 'ANSWERED'] } },
    });
    if (remaining === 0) {
      const c = await tx.campaign.findUnique({ where: { id: recipient.campaignId } });
      if (c && c.status === 'PROCESSING') {
        await tx.campaign.update({ where: { id: c.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
        await tx.campaignStatusHistory.create({ data: { campaignId: c.id, fromStatus: 'PROCESSING', toStatus: 'COMPLETED', reason: 'All recipients reached terminal/uncertain status' } });
      }
    }
  });
  return { applied: true, detail: `${recipient.status}->${ev.status}` };
}

@Injectable()
export class WebhooksService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  async handleCallback(channel: 'voice' | 'sms', rawBody: string, headers: Record<string, string | undefined>) {
    const cfg = config();
    const providers = createProviders('MOCK', cfg.WEBHOOK_SIGNING_SECRET);
    const adapter = channel === 'voice' ? providers.voice : providers.sms;

    if (!adapter.verifyWebhook({ rawBody, headers })) {
      await this.audit.log(null, 'webhook.invalid_signature', 'ProviderEvent', null, { channel });
      throw new UnauthorizedException('Invalid webhook signature');
    }

    let ev: NormalisedEvent;
    try {
      ev = adapter.parseWebhook(rawBody);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Malformed payload';
      await this.prisma.providerEvent.create({
        data: { provider: adapter.name, eventId: `malformed_${Date.now()}_${Math.random()}`, payload: { raw: rawBody.slice(0, 500) }, error: msg },
      });
      throw new BadRequestException(msg);
    }

    // Duplicate callback protection via unique (provider, eventId).
    const existing = await this.prisma.providerEvent.findUnique({
      where: { provider_eventId: { provider: adapter.name, eventId: ev.eventId } },
    });
    if (existing) return { duplicate: true, eventId: ev.eventId, applied: existing.applied };

    const result = await applyNormalisedEvent(this.prisma, adapter.name, ev, adapter.simulated);
    const stored = await this.prisma.providerEvent.create({
      data: {
        provider: adapter.name,
        eventId: ev.eventId,
        providerRef: ev.kind === 'status' ? ev.providerRef : undefined,
        rawStatus: ev.kind === 'status' ? ev.rawStatus : 'opt_out',
        normalisedStatus: ev.kind === 'status' ? (ev.status as RecipientStatus) : undefined,
        payload: JSON.parse(rawBody) as Prisma.InputJsonValue,
        applied: result.applied,
        error: result.applied ? null : result.detail,
      },
    });
    await enqueueOutbox(this.prisma, 'provider-event.process', { providerEventId: stored.id });
    return { duplicate: false, eventId: ev.eventId, applied: result.applied, detail: result.detail };
  }

  /**
   * Authorised simulator: generates signed mock callbacks for every PROVIDER_ACCEPTED recipient of a campaign.
   * Only works when PROVIDER_MODE is MOCK. All resulting records are marked simulated.
   */
  async simulateCampaignCallbacks(actor: AuthUser, campaignId: string) {
    if (config().PROVIDER_MODE !== 'MOCK') throw new BadRequestException('Simulation is only available in MOCK mode');
    const c = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!c) throw new BadRequestException('Campaign not found');
    const recipients = await this.prisma.campaignRecipient.findMany({
      where: { campaignId, providerRef: { not: null } },
    });
    const secret = config().WEBHOOK_SIGNING_SECRET;
    let delivered = 0;
    for (const r of recipients) {
      const steps = c.channel === 'VOICE' ? MockVoiceProvider.plannedEvents(r.phoneE164) : MockSmsProvider.plannedEvents(r.phoneE164);
      for (let idx = 0; idx < steps.length; idx++) {
        const status = steps[idx];
        // Duplicate step in plannedEvents reuses the same eventId to exercise duplicate-callback handling.
        const isDup = idx > 0 && steps[idx] === steps[idx - 1];
        const eventId = `sim_${r.id}_${isDup ? idx - 1 : idx}_${status}`;
        const isFinal = status === 'completed' || status === 'delivered';
        const payload = JSON.stringify({
          eventId, providerRef: r.providerRef, status,
          occurredAt: new Date().toISOString(),
          cost: isFinal ? { amount: c.channel === 'VOICE' ? 0.35 : 0.18, currency: 'INR' } : undefined,
        });
        await this.handleCallback(c.channel === 'VOICE' ? 'voice' : 'sms', payload, { 'x-signature': signBody(payload, secret) });
        delivered++;
      }
    }
    await this.audit.log(actor, 'webhook.simulated', 'Campaign', campaignId, { callbacks: delivered, simulated: true });
    return { simulated: true, callbacksProcessed: delivered };
  }
}

const simSingleSchema = z.object({
  channel: z.enum(['voice', 'sms']),
  providerRef: z.string().min(1),
  status: z.enum(['accepted', 'answered', 'completed', 'delivered', 'failed', 'no_answer', 'busy', 'undelivered']),
  eventId: z.string().optional(),
});

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private svc: WebhooksService, private prisma: PrismaService) {}

  @Public()
  @Post(':channel')
  @HttpCode(200)
  async receive(@Param('channel') channel: string, @Req() req: RawBodyRequest<Request>, @Body() body: unknown) {
    if (channel !== 'voice' && channel !== 'sms') throw new BadRequestException('Unknown webhook channel');
    const raw = req.rawBody ? req.rawBody.toString('utf8') : typeof body === 'string' ? body : JSON.stringify(body ?? {});
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    return this.svc.handleCallback(channel, raw, headers);
  }

  @ApiBearerAuth()
  @RequirePermissions('campaigns:control')
  @Post('simulate/campaign/:id')
  @HttpCode(200)
  simulateCampaign(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.simulateCampaignCallbacks(u, id);
  }

  @ApiBearerAuth()
  @RequirePermissions('campaigns:control')
  @Post('simulate/event')
  @HttpCode(200)
  simulateOne(@Body(new ZodPipe(simSingleSchema)) b: z.infer<typeof simSingleSchema>) {
    if (config().PROVIDER_MODE !== 'MOCK') throw new BadRequestException('Simulation is only available in MOCK mode');
    const payload = JSON.stringify({
      eventId: b.eventId ?? `sim_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      providerRef: b.providerRef, status: b.status, occurredAt: new Date().toISOString(),
    });
    return this.svc.handleCallback(b.channel, payload, { 'x-signature': signBody(payload, config().WEBHOOK_SIGNING_SECRET) });
  }

  @ApiBearerAuth()
  @RequirePermissions('reports:read')
  @Get('events')
  events() { return this.prisma.providerEvent.findMany({ orderBy: { receivedAt: 'desc' }, take: 100 }); }
}

@Module({ providers: [WebhooksService], controllers: [WebhooksController], exports: [WebhooksService] })
export class WebhooksModule {}
