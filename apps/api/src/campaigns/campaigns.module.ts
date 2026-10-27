import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Injectable,
  Module, NotFoundException, Param, Patch, Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CampaignStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { canTransition } from '@commhub/shared-types';
import {
  Audience, complianceStatus, countEligibleContacts, enqueueOutbox, findEligibleContacts,
  getEmergencyStop, productionBlockers,
} from '@commhub/domain';
import { AuditService } from '../audit/audit.module';
import { AuthUser, CurrentUser, RequirePermissions, ZodPipe } from '../common/auth';
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
}

@ApiTags('campaigns')
@ApiBearerAuth()
@Controller('campaigns')
export class CampaignsController {
  constructor(private svc: CampaignsService) {}

  @Get()
  @RequirePermissions('reports:read')
  list() { return this.svc.list(); }

  @Get(':id')
  @RequirePermissions('reports:read')
  get(@Param('id') id: string) { return this.svc.get(id); }

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
