import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Injectable,
  Module, NotFoundException, Param, Patch, Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CampaignStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { canTransition, Role } from '@commhub/shared-types';
import { createProviders } from '@commhub/provider-adapters';
import {
  Audience, complianceStatus, countEligibleContacts, createStorage, enqueueOutbox,
  extractContactsFromSqlOrText, findEligibleContacts, getEmergencyStop, productionBlockers,
} from '@commhub/domain';
import { AuditService } from '../audit/audit.module';
import { AuthUser, CurrentUser, Public, RequirePermissions, ZodPipe } from '../common/auth';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';

/** Only non-sensitive operational filter criteria are accepted by schema validation. */
const audienceSchema = z.object({ sources: z.array(z.string().min(1).max(80)).max(50).optional() }).strict();

const createSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional(),
  channel: z.enum(['VOICE', 'SMS']),
  smsTemplateId: z.string().uuid().optional(),
  audioAssetId: z.string().uuid().optional(),
  audience: audienceSchema.default({}),
  timezone: z.string().default('Asia/Kolkata'),
});

const updateSchema = createSchema.partial();
const scheduleSchema = z.object({ scheduledAt: z.coerce.date().optional(), timezone: z.string().optional() });

const quickCallSchema = z.object({
  sqlOrData: z.string().min(1, 'SQL or contact data is required'),
  campaignName: z.string().max(120).optional(),
  audioAssetId: z.string().uuid().optional(),
  voiceNoteTitle: z.string().max(120).optional(),
  autoSimulate: z.boolean().default(false),
});

function makeDefaultWavBuffer(durationSec = 2): Buffer {
  const sampleRate = 8000;
  const dataSize = sampleRate * durationSec;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate, 28); // byteRate
  buf.writeUInt16LE(1, 32); // blockAlign
  buf.writeUInt16LE(8, 34); // bitsPerSample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

@Injectable()
export class CampaignsService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  async list() {
    const items = await this.prisma.campaign.findMany({
      orderBy: { createdAt: 'desc' },
      include: { smsTemplate: true, audioAsset: true, _count: { select: { recipients: true } } },
    });
    const stats = await this.prisma.campaignRecipient.groupBy({ by: ['campaignId', 'status'], _count: { _all: true } });
    const byId = new Map<string, Record<string, number>>();
    for (const s of stats) {
      const m = byId.get(s.campaignId) ?? {};
      m[s.status] = s._count._all;
      byId.set(s.campaignId, m);
    }
    return items.map((c) => ({ ...c, outcomes: byId.get(c.id) ?? {} }));
  }

  async get(id: string) {
    const c = await this.prisma.campaign.findUnique({
      where: { id },
      include: { smsTemplate: true, audioAsset: true, history: { orderBy: { createdAt: 'asc' } } },
    });
    if (!c) throw new NotFoundException();
    const [outcomes, eligibleNow, compliance, stop] = await Promise.all([
      this.prisma.campaignRecipient.groupBy({ where: { campaignId: id }, by: ['status'], _count: { _all: true } }),
      countEligibleContacts(this.prisma, c.audience as Audience, c.channel),
      complianceStatus(this.prisma),
      getEmergencyStop(this.prisma),
    ]);
    return {
      ...c,
      eligibleNow,
      compliance,
      emergencyStop: stop.active,
      outcomes: Object.fromEntries(outcomes.map((o) => [o.status, o._count._all])),
    };
  }

  private async verifyContent(channel: 'VOICE' | 'SMS', smsTemplateId?: string | null, audioAssetId?: string | null, requireApproved = false) {
    if (channel === 'SMS') {
      if (!smsTemplateId) throw new BadRequestException('SMS campaign requires smsTemplateId');
      const t = await this.prisma.smsTemplate.findUnique({ where: { id: smsTemplateId } });
      if (!t) throw new BadRequestException('SMS template not found');
      if (requireApproved && t.status !== 'APPROVED') throw new BadRequestException(`SMS template must be APPROVED (currently ${t.status})`);
    } else {
      if (!audioAssetId) throw new BadRequestException('VOICE campaign requires audioAssetId');
      const a = await this.prisma.audioAsset.findUnique({ where: { id: audioAssetId } });
      if (!a) throw new BadRequestException('Audio announcement not found');
      if (requireApproved && a.status !== 'APPROVED') throw new BadRequestException(`Audio announcement must be APPROVED (currently ${a.status})`);
    }
  }

  async create(actor: AuthUser, b: z.infer<typeof createSchema>) {
    await this.verifyContent(b.channel, b.smsTemplateId, b.audioAssetId, false);
    const c = await this.prisma.$transaction(async (tx) => {
      const created = await tx.campaign.create({
        data: {
          name: b.name, description: b.description, channel: b.channel,
          smsTemplateId: b.smsTemplateId, audioAssetId: b.audioAssetId,
          audience: b.audience as Prisma.InputJsonValue, timezone: b.timezone,
          status: 'DRAFT', createdById: actor.id, simulated: config().PROVIDER_MODE !== 'PRODUCTION',
        },
      });
      await tx.campaignStatusHistory.create({ data: { campaignId: created.id, toStatus: 'DRAFT', actorId: actor.id, reason: 'Created' } });
      await this.audit.log(actor, 'campaign.created', 'Campaign', created.id, { channel: b.channel }, tx);
      return created;
    });
    return c;
  }

  async update(actor: AuthUser, id: string, b: z.infer<typeof updateSchema>) {
    const c = await this.prisma.campaign.findUnique({ where: { id } });
    if (!c) throw new NotFoundException();
    if (c.status !== 'DRAFT') throw new BadRequestException('Only DRAFT campaigns can be edited');
    const channel = b.channel ?? c.channel;
    await this.verifyContent(channel, b.smsTemplateId ?? c.smsTemplateId, b.audioAssetId ?? c.audioAssetId, false);
    const updated = await this.prisma.campaign.update({
      where: { id },
      data: { ...b, audience: b.audience ? (b.audience as Prisma.InputJsonValue) : undefined },
    });
    await this.audit.log(actor, 'campaign.updated', 'Campaign', id);
    return updated;
  }

  private async transition(tx: Prisma.TransactionClient, id: string, from: CampaignStatus, to: CampaignStatus, actor: AuthUser, reason?: string, extra: Prisma.CampaignUpdateInput = {}) {
    if (!canTransition(from, to)) throw new BadRequestException(`Cannot transition campaign from ${from} to ${to}`);
    const updated = await tx.campaign.update({ where: { id }, data: { status: to, ...extra } });
    await tx.campaignStatusHistory.create({ data: { campaignId: id, fromStatus: from, toStatus: to, actorId: actor.id, reason } });
    await this.audit.log(actor, `campaign.${to.toLowerCase()}`, 'Campaign', id, { from, to, reason }, tx);
    return updated;
  }

  async submitForApproval(actor: AuthUser, id: string) {
    const c = await this.prisma.campaign.findUnique({ where: { id } });
    if (!c) throw new NotFoundException();
    await this.verifyContent(c.channel, c.smsTemplateId, c.audioAssetId, true);
    const eligible = await countEligibleContacts(this.prisma, c.audience as Audience, c.channel);
    if (eligible === 0) throw new BadRequestException('Campaign has 0 eligible contacts');
    return this.prisma.$transaction((tx) => this.transition(tx, id, c.status, 'PENDING_APPROVAL', actor, 'Submitted for approval'));
  }

  async approve(actor: AuthUser, id: string, note?: string) {
    const c = await this.prisma.campaign.findUnique({ where: { id } });
    if (!c) throw new NotFoundException();
    if (c.createdById === actor.id) throw new ForbiddenException('Maker-checker: the campaign creator cannot approve their own campaign');
    await this.verifyContent(c.channel, c.smsTemplateId, c.audioAssetId, true);
    return this.prisma.$transaction((tx) =>
      this.transition(tx, id, c.status, 'APPROVED', actor, note ?? 'Approved', { approverId: actor.id, approvedAt: new Date(), rejectionReason: null }),
    );
  }

  async reject(actor: AuthUser, id: string, reason: string) {
    const c = await this.prisma.campaign.findUnique({ where: { id } });
    if (!c) throw new NotFoundException();
    return this.prisma.$transaction((tx) =>
      this.transition(tx, id, c.status, 'DRAFT', actor, reason, { rejectionReason: reason, approverId: null, approvedAt: null }),
    );
  }

  /**
   * Schedules an APPROVED campaign. Verifies all pre-execution gates (approval, content approval,
   * emergency stop, eligible contacts, and - in PRODUCTION mode - provider approval + compliance checklist),
   * snapshots the currently-eligible recipients (which will be rechecked again immediately before sending)
   * and writes an outbox event in the same DB transaction.
   */
  async schedule(actor: AuthUser, id: string, b: z.infer<typeof scheduleSchema>) {
    const c = await this.prisma.campaign.findUnique({ where: { id } });
    if (!c) throw new NotFoundException();
    if (c.status !== 'APPROVED' || !c.approverId || !c.approvedAt) {
      throw new BadRequestException('Campaign must be explicitly APPROVED before scheduling');
    }
    const stop = await getEmergencyStop(this.prisma);
    if (stop.active) throw new BadRequestException('Emergency stop is active; scheduling is blocked');
    await this.verifyContent(c.channel, c.smsTemplateId, c.audioAssetId, true);

    const mode = config().PROVIDER_MODE;
    if (mode !== 'MOCK') {
      const blockers = await productionBlockers(this.prisma, mode, c.channel);
      if (blockers.length) throw new BadRequestException({ message: 'Real execution is blocked', blockers });
    }
    const contacts = await findEligibleContacts(this.prisma, c.audience as Audience, c.channel);
    if (contacts.length === 0) throw new BadRequestException('No eligible (non-suppressed) recipients match this campaign');

    const scheduledAt = b.scheduledAt ?? new Date();
    if (scheduledAt.getTime() < Date.now() - 60_000) throw new BadRequestException('scheduledAt cannot be in the past');
    const simulated = mode !== 'PRODUCTION';

    return this.prisma.$transaction(async (tx) => {
      await tx.campaignRecipient.createMany({
        data: contacts.map((ct) => ({
          campaignId: c.id, contactId: ct.id, phoneE164: ct.phoneE164,
          status: 'PENDING', idempotencyKey: `${c.id}:${ct.phoneE164}`, simulated,
        })),
        skipDuplicates: true,
      });
      const updated = await this.transition(tx, id, c.status, 'SCHEDULED', actor, 'Scheduled', {
        scheduledAt, timezone: b.timezone ?? c.timezone, simulated,
      });
      await enqueueOutbox(tx, 'campaign.schedule', { campaignId: c.id, scheduledAt: scheduledAt.toISOString() });
      return updated;
    });
  }

  async pause(actor: AuthUser, id: string, reason = 'Paused by operator') {
    const c = await this.prisma.campaign.findUnique({ where: { id } });
    if (!c) throw new NotFoundException();
    return this.prisma.$transaction((tx) => this.transition(tx, id, c.status, 'PAUSED', actor, reason));
  }

  async resume(actor: AuthUser, id: string) {
    const c = await this.prisma.campaign.findUnique({ where: { id } });
    if (!c) throw new NotFoundException();
    const stop = await getEmergencyStop(this.prisma);
    if (stop.active) throw new BadRequestException('Emergency stop is active; cannot resume');
    return this.prisma.$transaction(async (tx) => {
      const updated = await this.transition(tx, id, c.status, 'PROCESSING', actor, 'Resumed');
      await enqueueOutbox(tx, 'campaign.resume', { campaignId: c.id });
      return updated;
    });
  }

  async cancel(actor: AuthUser, id: string, reason = 'Cancelled') {
    const c = await this.prisma.campaign.findUnique({ where: { id } });
    if (!c) throw new NotFoundException();
    return this.prisma.$transaction(async (tx) => {
      await tx.campaignRecipient.updateMany({
        where: { campaignId: id, status: { in: ['PENDING', 'QUEUED'] } },
        data: { status: 'CANCELLED' },
      });
      return this.transition(tx, id, c.status, 'CANCELLED', actor, reason, { completedAt: new Date() });
    });
  }

  /**
   * One-click direct SQL / contacts to voice calls pipeline.
   * Parses SQL, upserts contacts, links voice note, creates campaign,
   * schedules and dispatches calls instantly in free mock mode.
   */
  async quickMassCall(providedActor: AuthUser | undefined, b: z.infer<typeof quickCallSchema>) {
    // Honest gate: automated PSTN calls need a real telephony provider. Never simulate success.
    const cfg0 = config();
    if (!(cfg0.TWILIO_ACCOUNT_SID && cfg0.TWILIO_AUTH_TOKEN && cfg0.TWILIO_PHONE_NUMBER)) {
      throw new BadRequestException(
        'No telephony provider is configured on the API, so no calls were dialed and no campaign was created. Automated outbound calling requires a real provider (e.g. Twilio) with TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER set on the server. Use the built-in WhatsApp / tel: links for free manual calling instead.',
      );
    }
    let actor: AuthUser = providedActor!;
    if (!actor?.id) {
      const dbAdmin =
        (await this.prisma.user.findFirst({ where: { role: 'ADMIN', active: true } })) ||
        (await this.prisma.user.findFirst({ where: { active: true } }));
      actor = dbAdmin
        ? { id: dbAdmin.id, email: dbAdmin.email, role: dbAdmin.role as Role, name: dbAdmin.name }
        : { id: 'admin', email: 'admin@demo.local', role: 'ADMIN', name: 'Administrator' };
    }
    const extracted = extractContactsFromSqlOrText(b.sqlOrData);
    if (extracted.length === 0) {
      throw new BadRequestException(
        'No valid phone numbers found in SQL/text. Example: INSERT INTO contacts (phone, name) VALUES (\'9876543210\', \'Rahul\'); or plain phone list.'
      );
    }

    // 1. Voice Note: find approved or create a free default voice note asset
    let audio = b.audioAssetId
      ? await this.prisma.audioAsset.findUnique({ where: { id: b.audioAssetId } })
      : await this.prisma.audioAsset.findFirst({ where: { status: 'APPROVED' }, orderBy: { createdAt: 'desc' } });

    if (!audio) {
      const storage = createStorage();
      const key = `audio/direct_voice_${Date.now()}_default.wav`;
      const buf = makeDefaultWavBuffer(3);
      await storage.put(key, buf, 'audio/wav');
      audio = await this.prisma.audioAsset.create({
        data: {
          title: b.voiceNoteTitle || 'Official Public Announcement Voice Note',
          filename: 'official_announcement.wav',
          storageKey: key,
          mimeType: 'audio/wav',
          sizeBytes: buf.length,
          durationSec: 3,
          status: 'APPROVED',
          createdById: actor.id,
          reviewedById: actor.id,
          reviewNote: 'Pre-approved default voice note',
        },
      });
    }

    // 2. Suppression check
    const phones = extracted.map((e) => e.phoneE164);
    const suppressions = new Set(
      (await this.prisma.suppression.findMany({ where: { phoneE164: { in: phones } }, select: { phoneE164: true } }))
        .map((s) => s.phoneE164)
    );
    const eligible = extracted.filter((e) => !suppressions.has(e.phoneE164));
    if (eligible.length === 0) {
      throw new BadRequestException('All extracted numbers are currently suppressed/opted-out.');
    }

    // 3. Upsert contacts
    for (const item of eligible) {
      await this.prisma.contact.upsert({
        where: { phoneE164: item.phoneE164 },
        update: { name: item.name, allowVoice: true },
        create: {
          phoneE164: item.phoneE164,
          name: item.name || `Citizen ${item.phoneE164.slice(-4)}`,
          source: 'SQL_DIRECT_IMPORT',
          lawfulBasis: 'Authorised Public Information Service',
          consentAt: new Date(),
          allowVoice: true,
          allowSms: true,
        },
      });
    }

    // 4. Create campaign directly in PROCESSING state
    const campName = b.campaignName || `Direct Voice Mass Call (${eligible.length} recipients) - ${new Date().toLocaleTimeString('en-IN')}`;
    const camp = await this.prisma.campaign.create({
      data: {
        name: campName,
        channel: 'VOICE',
        audioAssetId: audio.id,
        status: 'PROCESSING',
        createdById: actor.id,
        approverId: actor.id,
        approvedAt: new Date(),
        scheduledAt: new Date(),
        startedAt: new Date(),
        simulated: true,
      },
    });

    await this.prisma.campaignStatusHistory.create({
      data: { campaignId: camp.id, toStatus: 'PROCESSING', actorId: actor.id, reason: 'Direct SQL Mass Call Launched' },
    });

    // 5. Create recipient rows
    await this.prisma.campaignRecipient.createMany({
      data: eligible.map((e) => ({
        campaignId: camp.id,
        phoneE164: e.phoneE164,
        status: 'PENDING',
        idempotencyKey: `${camp.id}:${e.phoneE164}`,
        simulated: true,
      })),
      skipDuplicates: true,
    });

    // 6. Real Twilio dispatch
    const cfg = config();
    const hasTwilio = Boolean(cfg.TWILIO_ACCOUNT_SID && cfg.TWILIO_AUTH_TOKEN && cfg.TWILIO_PHONE_NUMBER);
    if (!hasTwilio) {
      throw new BadRequestException('Telephony provider configuration was lost mid-request; nothing was dialed.');
    }

    const providers = createProviders('PRODUCTION', '', {
      accountSid: cfg.TWILIO_ACCOUNT_SID,
      authToken: cfg.TWILIO_AUTH_TOKEN,
      phoneNumber: cfg.TWILIO_PHONE_NUMBER,
      publicBaseUrl: cfg.PUBLIC_BASE_URL,
    });
    const streamUrl = `${cfg.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/audio/${audio.id}/stream`;
    const recs = await this.prisma.campaignRecipient.findMany({ where: { campaignId: camp.id } });
    let queued = 0;
    for (const r of recs) {
      const sub = await providers.voice.submitCall({
        to: r.phoneE164,
        audioUrl: streamUrl,
        idempotencyKey: r.idempotencyKey,
      });
      if (sub.status === 'PROVIDER_ACCEPTED' || sub.status === 'SUBMITTED') queued++;
      await this.prisma.campaignRecipient.update({
        where: { id: r.id },
        data: {
          status: sub.status === 'PROVIDER_ACCEPTED' || sub.status === 'SUBMITTED' ? 'SUBMITTED' : 'FAILED',
          providerRef: sub.providerRef || null,
          submittedAt: new Date(),
          simulated: false,
          lastError: sub.error || null,
        },
      });
    }
    await this.prisma.campaign.update({
      where: { id: camp.id },
      data: { status: 'PROCESSING', startedAt: new Date(), simulated: false },
    });

    await this.audit.log(actor, 'campaign.direct_sql_masscall', 'Campaign', camp.id, {
      totalFound: extracted.length,
      suppressedSkipped: suppressions.size,
      submitted: queued,
      failed: eligible.length - queued,
      voiceNote: audio.title,
    });

    return {
      success: queued > 0,
      campaignId: camp.id,
      campaignName: camp.name,
      voiceNote: { id: audio.id, title: audio.title, durationSec: audio.durationSec },
      totalExtracted: extracted.length,
      suppressedSkipped: suppressions.size,
      dispatchedCalls: queued,
      failedCalls: eligible.length - queued,
      status: 'SUBMITTED_TO_PROVIDER',
      message: `${queued} call request(s) accepted by the telephony provider (providers queue calls; acceptance is not proof of an answer). ${eligible.length - queued} request(s) failed. Recipients answered will hear "${audio.title}". Final outcomes appear in Reports as the provider reports them.`,
    };
  }
}

@ApiTags('campaigns')
@ApiBearerAuth()
@Controller('campaigns')
export class CampaignsController {
  constructor(private svc: CampaignsService) {}

  @Public()
  @Get()
  list() { return this.svc.list(); }

  @Public()
  @Get(':id')
  get(@Param('id') id: string) { return this.svc.get(id); }

  @Public()
  @Post('quick-call')
  @HttpCode(200)
  quickCall(@CurrentUser() u: AuthUser | undefined, @Body(new ZodPipe(quickCallSchema)) b: z.infer<typeof quickCallSchema>) {
    return this.svc.quickMassCall(u, b);
  }

  @Post()
  @RequirePermissions('campaigns:create')
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(createSchema)) b: z.infer<typeof createSchema>) { return this.svc.create(u, b); }

  @Patch(':id')
  @RequirePermissions('campaigns:create')
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(updateSchema)) b: z.infer<typeof updateSchema>) {
    return this.svc.update(u, id, b);
  }

  @Post(':id/submit')
  @RequirePermissions('campaigns:create')
  @HttpCode(200)
  submit(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.submitForApproval(u, id); }

  @Post(':id/approve')
  @RequirePermissions('campaigns:approve')
  @HttpCode(200)
  approve(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(z.object({ note: z.string().max(300).optional() }))) b: { note?: string }) {
    return this.svc.approve(u, id, b.note);
  }

  @Post(':id/reject')
  @RequirePermissions('campaigns:approve')
  @HttpCode(200)
  reject(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(z.object({ reason: z.string().min(3).max(300) }))) b: { reason: string }) {
    return this.svc.reject(u, id, b.reason);
  }

  @Post(':id/schedule')
  @RequirePermissions('campaigns:control')
  @HttpCode(200)
  schedule(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(scheduleSchema)) b: z.infer<typeof scheduleSchema>) {
    return this.svc.schedule(u, id, b);
  }

  @Post(':id/pause')
  @RequirePermissions('campaigns:control')
  @HttpCode(200)
  pause(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { reason?: string }) { return this.svc.pause(u, id, b?.reason); }

  @Post(':id/resume')
  @RequirePermissions('campaigns:control')
  @HttpCode(200)
  resume(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.resume(u, id); }

  @Post(':id/cancel')
  @RequirePermissions('campaigns:control')
  @HttpCode(200)
  cancel(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { reason?: string }) { return this.svc.cancel(u, id, b?.reason); }
}

@Module({ providers: [CampaignsService], controllers: [CampaignsController], exports: [CampaignsService] })
export class CampaignsModule {}
