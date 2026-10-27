import {
  BadRequestException, Body, Controller, Get, Injectable, Module, NotFoundException,
  Param, Post, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { createStorage, smsSegments, StorageAdapter } from '@commhub/domain';
import { AuditService } from '../audit/audit.module';
import { AuthUser, CurrentUser, RequirePermissions, ZodPipe } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_DURATION_SEC = 180;
const ALLOWED_AUDIO = new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg', 'audio/mp3', 'audio/ogg']);

/** Parses duration from a RIFF/WAVE header if present; otherwise returns null so the caller can supply/validate it. */
export function parseWavDurationSec(buf: Buffer): number | null {
  if (buf.length < 44) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let byteRate = 0;
  let dataBytes = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ' && size >= 16 && offset + 20 <= buf.length) byteRate = buf.readUInt32LE(offset + 16);
    else if (id === 'data') { dataBytes = size; break; }
    offset += 8 + size + (size % 2);
  }
  return byteRate > 0 && dataBytes > 0 ? Math.round((dataBytes / byteRate) * 100) / 100 : null;
}

function hasAudioSignature(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.length >= 12 && buf.toString('ascii', 8, 12) === 'WAVE') return true;
  if (buf.toString('ascii', 0, 4) === 'OggS') return true;
  if (buf.toString('ascii', 0, 3) === 'ID3') return true;
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true; // MPEG frame sync
  return false;
}

const reviewSchema = z.object({ decision: z.enum(['APPROVED', 'REJECTED']), note: z.string().max(300).optional() });
const smsSchema = z.object({ name: z.string().min(2).max(100), body: z.string().min(1).max(1000) });

@Injectable()
export class ContentService {
  private storage: StorageAdapter = createStorage();
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  async uploadAudio(actor: AuthUser, file: Express.Multer.File | undefined, title?: string, declaredDurationSec?: number) {
    if (!file || !file.buffer?.length) throw new BadRequestException('Audio file is required');
    if (!ALLOWED_AUDIO.has(file.mimetype)) throw new BadRequestException(`Unsupported audio MIME type: ${file.mimetype}`);
    if (file.size > MAX_AUDIO_BYTES) throw new BadRequestException('Audio file exceeds 10 MB limit');
    if (!hasAudioSignature(file.buffer)) throw new BadRequestException('File header does not match a supported audio format (WAV/MP3/OGG)');
    const wavDur = parseWavDurationSec(file.buffer);
    const durationSec = wavDur ?? (declaredDurationSec && declaredDurationSec > 0 ? declaredDurationSec : null);
    if (!durationSec || durationSec <= 0) throw new BadRequestException('Audio duration could not be verified; provide a valid WAV or durationSec');
    if (durationSec > MAX_DURATION_SEC) throw new BadRequestException(`Audio duration ${durationSec}s exceeds maximum ${MAX_DURATION_SEC}s`);

    const ext = file.mimetype.includes('wav') ? 'wav' : file.mimetype.includes('ogg') ? 'ogg' : 'mp3';
    const key = `audio/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    await this.storage.put(key, file.buffer, file.mimetype);
    const asset = await this.prisma.audioAsset.create({
      data: {
        title: (title?.trim() || file.originalname).slice(0, 120),
        filename: file.originalname.slice(0, 120),
        storageKey: key, mimeType: file.mimetype, sizeBytes: file.size,
        durationSec, status: 'IN_REVIEW', createdById: actor.id,
      },
    });
    await this.audit.log(actor, 'audio.uploaded', 'AudioAsset', asset.id, { sizeBytes: file.size, durationSec });
    return asset;
  }

  async streamAudio(id: string) {
    const asset = await this.prisma.audioAsset.findUnique({ where: { id } });
    if (!asset) throw new NotFoundException();
    const buf = await this.storage.get(asset.storageKey);
    return { asset, buf };
  }

  async reviewAudio(actor: AuthUser, id: string, b: z.infer<typeof reviewSchema>) {
    const a = await this.prisma.audioAsset.findUnique({ where: { id } });
    if (!a) throw new NotFoundException();
    const updated = await this.prisma.audioAsset.update({
      where: { id }, data: { status: b.decision, reviewedById: actor.id, reviewNote: b.note },
    });
    await this.audit.log(actor, `audio.${b.decision.toLowerCase()}`, 'AudioAsset', id, { note: b.note });
    return updated;
  }

  async createSms(actor: AuthUser, b: z.infer<typeof smsSchema>) {
    const info = smsSegments(b.body);
    if (info.segments > 6) throw new BadRequestException(`Message is ${info.segments} segments; maximum is 6`);
    const tpl = await this.prisma.smsTemplate.create({
      data: { name: b.name, body: b.body, segments: info.segments, encoding: info.encoding, status: 'IN_REVIEW', createdById: actor.id },
    });
    await this.audit.log(actor, 'sms_template.created', 'SmsTemplate', tpl.id, { segments: info.segments, encoding: info.encoding });
    return { ...tpl, units: info.units, perSegment: info.perSegment };
  }

  async reviewSms(actor: AuthUser, id: string, b: z.infer<typeof reviewSchema>) {
    const t = await this.prisma.smsTemplate.findUnique({ where: { id } });
    if (!t) throw new NotFoundException();
    const updated = await this.prisma.smsTemplate.update({
      where: { id }, data: { status: b.decision, reviewedById: actor.id, reviewNote: b.note },
    });
    await this.audit.log(actor, `sms_template.${b.decision.toLowerCase()}`, 'SmsTemplate', id, { note: b.note });
    return updated;
  }
}

@ApiTags('voice-announcements')
@ApiBearerAuth()
@Controller('voice-announcements')
export class VoiceController {
  constructor(private svc: ContentService, private prisma: PrismaService) {}

  @Get()
  @RequirePermissions('contacts:read')
  list() { return this.prisma.audioAsset.findMany({ orderBy: { createdAt: 'desc' } }); }

  @Post()
  @RequirePermissions('campaigns:create')
  @UseInterceptors(FileInterceptor('file'))
  upload(@CurrentUser() u: AuthUser, @UploadedFile() file: Express.Multer.File, @Body() b: { title?: string; durationSec?: string }) {
    return this.svc.uploadAudio(u, file, b.title, b.durationSec ? Number(b.durationSec) : undefined);
  }

  @Get(':id/stream')
  @RequirePermissions('contacts:read')
  async stream(@Param('id') id: string, @Res() res: Response) {
    const { asset, buf } = await this.svc.streamAudio(id);
    res.setHeader('Content-Type', asset.mimeType);
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  }

  @Post(':id/review')
  @RequirePermissions('campaigns:approve')
  review(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(reviewSchema)) b: z.infer<typeof reviewSchema>) {
    return this.svc.reviewAudio(u, id, b);
  }
}

@ApiTags('sms-templates')
@ApiBearerAuth()
@Controller('sms-templates')
export class SmsController {
  constructor(private svc: ContentService, private prisma: PrismaService) {}

  @Get()
  @RequirePermissions('contacts:read')
  list() { return this.prisma.smsTemplate.findMany({ orderBy: { createdAt: 'desc' } }); }

  @Post('estimate')
  @RequirePermissions('contacts:read')
  estimate(@Body(new ZodPipe(z.object({ body: z.string().max(2000) }))) b: { body: string }) { return smsSegments(b.body); }

  @Post()
  @RequirePermissions('campaigns:create')
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(smsSchema)) b: z.infer<typeof smsSchema>) { return this.svc.createSms(u, b); }

  @Post(':id/review')
  @RequirePermissions('campaigns:approve')
  review(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(reviewSchema)) b: z.infer<typeof reviewSchema>) {
    return this.svc.reviewSms(u, id, b);
  }
}

@Module({ providers: [ContentService], controllers: [VoiceController, SmsController], exports: [ContentService] })
export class ContentModule {}
