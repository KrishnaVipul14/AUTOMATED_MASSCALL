import { BadRequestException, Body, Controller, Get, HttpCode, Injectable, Module, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { complianceStatus, getEmergencyStop, getOperatingWindow, productionBlockers } from '@commhub/domain';
import { AuditService } from '../audit/audit.module';
import { AuthUser, CurrentUser, RequirePermissions, ZodPipe } from '../common/auth';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';

const providerPatchSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(['MOCK', 'TEST', 'PRODUCTION']).optional(),
  ratePerSecond: z.number().int().min(1).max(100).optional(),
  maxConcurrency: z.number().int().min(1).max(20).optional(),
  approvalVerified: z.boolean().optional(),
  approvalReference: z.string().max(200).optional(),
});

const windowSchema = z.object({
  timezone: z.string().min(1),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(1).max(24),
  enforceInMockMode: z.boolean().default(false),
});

const stopSchema = z.object({ active: z.boolean(), reason: z.string().max(200).optional() });
const checkSchema = z.object({ checked: z.boolean(), note: z.string().max(300).optional() });

@Injectable()
export class SettingsService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  /** Returns provider configurations and server-side credential status (never the secret values). */
  async getProviders() {
    const configs = await this.prisma.providerConfig.findMany({ orderBy: { channel: 'asc' } });
    const [voiceBlockers, smsBlockers, compliance] = await Promise.all([
      productionBlockers(this.prisma, config().PROVIDER_MODE, 'VOICE'),
      productionBlockers(this.prisma, config().PROVIDER_MODE, 'SMS'),
      complianceStatus(this.prisma),
    ]);
    return {
      envMode: config().PROVIDER_MODE,
      credentials: {
        voiceApiKeyConfigured: Boolean(process.env.VOICE_PROVIDER_API_KEY),
        smsApiKeyConfigured: Boolean(process.env.SMS_PROVIDER_API_KEY),
        webhookSecretConfigured: Boolean(config().WEBHOOK_SIGNING_SECRET),
      },
      compliance,
      productionBlockers: { VOICE: voiceBlockers, SMS: smsBlockers },
      configs,
    };
  }

  async updateProvider(actor: AuthUser, id: string, b: z.infer<typeof providerPatchSchema>) {
    const existing = await this.prisma.providerConfig.findUnique({ where: { id } });
    if (!existing) throw new BadRequestException('Provider config not found');
    if (b.mode === 'PRODUCTION') {
      if (existing.adapter === 'mock') throw new BadRequestException('The mock adapter cannot be switched to PRODUCTION mode');
      if (!(b.approvalVerified ?? existing.approvalVerified)) {
        throw new BadRequestException('Cannot set mode=PRODUCTION until provider approval is verified');
      }
      const c = await complianceStatus(this.prisma);
      if (!c.complete) throw new BadRequestException(`Cannot set mode=PRODUCTION: compliance checklist incomplete (${c.missing.join(', ')})`);
      const hasKey = existing.channel === 'SMS' ? Boolean(process.env.SMS_PROVIDER_API_KEY) : Boolean(process.env.VOICE_PROVIDER_API_KEY);
      if (!hasKey) throw new BadRequestException('Cannot set mode=PRODUCTION: provider API key is not configured in server environment');
    }
    const updated = await this.prisma.providerConfig.update({ where: { id }, data: b });
    await this.audit.log(actor, 'provider_config.updated', 'ProviderConfig', id, b);
    return updated;
  }

  async getSettings() {
    const [stop, window, items] = await Promise.all([
      getEmergencyStop(this.prisma),
      getOperatingWindow(this.prisma),
      this.prisma.complianceItem.findMany({ orderBy: { key: 'asc' } }),
    ]);
    return { mode: config().PROVIDER_MODE, timezone: config().APP_TIMEZONE, emergencyStop: stop, operatingWindow: window, complianceItems: items };
  }

  /**
   * Emergency stop: immediately flips the global flag (checked by workers before every provider request)
   * AND pauses any SCHEDULED/PROCESSING campaigns inside a single transaction.
   * Note: requests that have already been handed to an external provider cannot be recalled.
   */
  async setEmergencyStop(actor: AuthUser, b: z.infer<typeof stopSchema>) {
    const val = { active: b.active, reason: b.reason, by: actor.email, at: new Date().toISOString() };
    await this.prisma.$transaction(async (tx) => {
      await tx.systemSetting.upsert({
        where: { key: 'emergencyStop' },
        update: { value: val as Prisma.InputJsonValue, updatedBy: actor.id },
        create: { key: 'emergencyStop', value: val as Prisma.InputJsonValue, updatedBy: actor.id },
      });
      if (b.active) {
        const running = await tx.campaign.findMany({ where: { status: { in: ['SCHEDULED', 'PROCESSING'] } } });
        for (const c of running) {
          await tx.campaign.update({ where: { id: c.id }, data: { status: 'PAUSED' } });
          await tx.campaignStatusHistory.create({
            data: { campaignId: c.id, fromStatus: c.status, toStatus: 'PAUSED', actorId: actor.id, reason: `Emergency stop: ${b.reason ?? ''}` },
          });
        }
      }
      await this.audit.log(actor, b.active ? 'emergency_stop.activated' : 'emergency_stop.cleared', 'SystemSetting', 'emergencyStop', val, tx);
    });
    return val;
  }

  async setOperatingWindow(actor: AuthUser, b: z.infer<typeof windowSchema>) {
    if (b.endHour <= b.startHour) throw new BadRequestException('endHour must be greater than startHour');
    await this.prisma.systemSetting.upsert({
      where: { key: 'operatingWindow' },
      update: { value: b as Prisma.InputJsonValue, updatedBy: actor.id },
      create: { key: 'operatingWindow', value: b as Prisma.InputJsonValue, updatedBy: actor.id },
    });
    await this.audit.log(actor, 'settings.operating_window_updated', 'SystemSetting', 'operatingWindow', b);
    return b;
  }

  async updateCompliance(actor: AuthUser, key: string, b: z.infer<typeof checkSchema>) {
    const item = await this.prisma.complianceItem.update({
      where: { key },
      data: { checked: b.checked, checkedById: b.checked ? actor.id : null, checkedAt: b.checked ? new Date() : null, note: b.note },
    });
    await this.audit.log(actor, 'compliance.updated', 'ComplianceItem', key, b);
    return item;
  }
}

@ApiTags('settings')
@ApiBearerAuth()
@Controller()
export class SettingsController {
  constructor(private svc: SettingsService) {}

  @Get('providers')
  @RequirePermissions('providers:manage')
  providers() { return this.svc.getProviders(); }

  @Patch('providers/:id')
  @RequirePermissions('providers:manage')
  updateProvider(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(providerPatchSchema)) b: z.infer<typeof providerPatchSchema>) {
    return this.svc.updateProvider(u, id, b);
  }

  @Get('settings')
  @RequirePermissions('reports:read')
  settings() { return this.svc.getSettings(); }

  @Post('settings/emergency-stop')
  @RequirePermissions('campaigns:control')
  @HttpCode(200)
  emergencyStop(@CurrentUser() u: AuthUser, @Body(new ZodPipe(stopSchema)) b: z.infer<typeof stopSchema>) {
    return this.svc.setEmergencyStop(u, b);
  }

  @Patch('settings/operating-window')
  @RequirePermissions('settings:manage')
  window(@CurrentUser() u: AuthUser, @Body(new ZodPipe(windowSchema)) b: z.infer<typeof windowSchema>) {
    return this.svc.setOperatingWindow(u, b);
  }

  @Patch('settings/compliance/:key')
  @RequirePermissions('settings:manage')
  compliance(@CurrentUser() u: AuthUser, @Param('key') key: string, @Body(new ZodPipe(checkSchema)) b: z.infer<typeof checkSchema>) {
    return this.svc.updateCompliance(u, key, b);
  }
}

@Module({ providers: [SettingsService], controllers: [SettingsController], exports: [SettingsService] })
export class SettingsModule {}
