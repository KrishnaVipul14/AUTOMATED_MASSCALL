import {
  BadRequestException, Body, Controller, Delete, Get, Header, HttpCode, Injectable, Module,
  NotFoundException, Param, Patch, Post, Query, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  ColumnMapping, createStorage, CSV_TEMPLATE, DEFAULT_MAPPING, enqueueOutbox,
  normalisePhone, parseContactsCsv, StorageAdapter,
} from '@commhub/domain';
import { AuditService } from '../audit/audit.module';
import { AuthUser, CurrentUser, RequirePermissions, ZodPipe } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().optional(),
  source: z.string().optional(),
  suppressed: z.enum(['all', 'only', 'exclude']).default('all'),
});

const createContactSchema = z.object({
  phone: z.string().min(4),
  name: z.string().max(100).optional(),
  source: z.string().min(1).max(80),
  lawfulBasis: z.string().min(1).max(160),
  consentAt: z.coerce.date(),
  allowSms: z.boolean().default(true),
  allowVoice: z.boolean().default(true),
  language: z.string().max(10).optional(),
});

const updateContactSchema = z.object({
  name: z.string().max(100).optional(),
  allowSms: z.boolean().optional(),
  allowVoice: z.boolean().optional(),
  language: z.string().max(10).optional(),
});

const suppressSchema = z.object({
  phone: z.string().min(4),
  reason: z.string().min(2).max(200),
  source: z.string().min(1).max(80).default('MANUAL'),
});

@Injectable()
export class ContactsService {
  private storage: StorageAdapter = createStorage();
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  async list(q: z.infer<typeof listSchema>) {
    const suppressedPhones = (await this.prisma.suppression.findMany({ select: { phoneE164: true } })).map((s) => s.phoneE164);
    const supSet = new Set(suppressedPhones);
    const where: Prisma.ContactWhereInput = {
      source: q.source || undefined,
      OR: q.q ? [{ phoneE164: { contains: q.q } }, { name: { contains: q.q, mode: 'insensitive' } }] : undefined,
      phoneE164: q.suppressed === 'only' ? { in: suppressedPhones } : q.suppressed === 'exclude' ? { notIn: suppressedPhones } : undefined,
    };
    const [items, total, sources] = await Promise.all([
      this.prisma.contact.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.contact.count({ where }),
      this.prisma.contact.findMany({ distinct: ['source'], select: { source: true } }),
    ]);
    return {
      items: items.map((c) => ({ ...c, suppressed: supSet.has(c.phoneE164) })),
      total, page: q.page, pageSize: q.pageSize,
      sources: sources.map((s) => s.source),
    };
  }

  async create(actor: AuthUser, b: z.infer<typeof createContactSchema>) {
    const phoneE164 = normalisePhone(b.phone);
    if (!phoneE164) throw new BadRequestException('Invalid phone number format');
    if (b.consentAt > new Date()) throw new BadRequestException('Consent timestamp cannot be in the future');
    const c = await this.prisma.contact.upsert({
      where: { phoneE164 },
      update: { name: b.name, source: b.source, lawfulBasis: b.lawfulBasis, consentAt: b.consentAt, allowSms: b.allowSms, allowVoice: b.allowVoice, language: b.language },
      create: { phoneE164, name: b.name, source: b.source, lawfulBasis: b.lawfulBasis, consentAt: b.consentAt, allowSms: b.allowSms, allowVoice: b.allowVoice, language: b.language },
    });
    await this.audit.log(actor, 'contact.upserted', 'Contact', c.id, { source: b.source, lawfulBasis: b.lawfulBasis });
    return c;
  }

  async update(actor: AuthUser, id: string, b: z.infer<typeof updateContactSchema>) {
    const existing = await this.prisma.contact.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException();
    const updated = await this.prisma.contact.update({ where: { id }, data: b });
    await this.audit.log(actor, 'contact.corrected', 'Contact', id, { changes: b });
    return updated;
  }

  /** Deletion request: deletes the contact record AND adds a suppression entry so the number is not re-contacted. */
  async remove(actor: AuthUser, id: string, reason = 'Deletion request') {
    const existing = await this.prisma.contact.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException();
    await this.prisma.$transaction(async (tx) => {
      await tx.suppression.upsert({
        where: { phoneE164: existing.phoneE164 },
        update: { reason },
        create: { phoneE164: existing.phoneE164, reason, source: 'DELETION_REQUEST', createdById: actor.id },
      });
      await tx.contact.delete({ where: { id } });
      await this.audit.log(actor, 'contact.deleted_and_suppressed', 'Contact', id, { reason }, tx);
    });
    return { deleted: true };
  }

  /**
   * Uploads and validates a CSV, storing a preview batch. Does NOT insert contacts until `commitImport` is called.
   * Also enqueues an outbox event so background workers record the validation job.
   */
  async previewCsv(actor: AuthUser, file: Express.Multer.File | undefined, body: { source?: string; lawfulBasis?: string; mapping?: string }) {
    if (!file || !file.buffer?.length) throw new BadRequestException('CSV file is required');
    if (file.size > 5 * 1024 * 1024) throw new BadRequestException('CSV exceeds 5 MB limit');
    const source = (body.source ?? '').trim();
    const lawfulBasis = (body.lawfulBasis ?? '').trim();
    if (!source || !lawfulBasis) throw new BadRequestException('source and lawfulBasis are required');
    let mapping: ColumnMapping = DEFAULT_MAPPING;
    if (body.mapping) {
      try { mapping = { ...DEFAULT_MAPPING, ...JSON.parse(body.mapping) }; } catch { throw new BadRequestException('Invalid mapping JSON'); }
    }
    const text = file.buffer.toString('utf8');
    const parsed = parseContactsCsv(text, mapping);
    if (parsed.headerErrors.length) throw new BadRequestException({ message: 'CSV header validation failed', errors: parsed.headerErrors });

    const phones = parsed.valid.map((v) => v.phoneE164);
    const [existingContacts, existingSuppressions] = await Promise.all([
      phones.length ? this.prisma.contact.findMany({ where: { phoneE164: { in: phones } }, select: { phoneE164: true } }) : [],
      phones.length ? this.prisma.suppression.findMany({ where: { phoneE164: { in: phones } }, select: { phoneE164: true } }) : [],
    ]);
    const existingSet = new Set(existingContacts.map((c) => c.phoneE164));
    const supSet = new Set(existingSuppressions.map((s) => s.phoneE164));

    const key = `imports/${Date.now()}_${Math.random().toString(36).slice(2)}.csv`;
    await this.storage.put(key, file.buffer, 'text/csv');

    const allErrors = [
      ...parsed.errors,
      ...parsed.duplicatesInFile,
      ...parsed.valid.filter((v) => existingSet.has(v.phoneE164)).map((v) => ({ row: v.row, field: 'phone', message: 'Duplicate of existing contact (will be skipped)' })),
      ...parsed.valid.filter((v) => supSet.has(v.phoneE164)).map((v) => ({ row: v.row, field: 'phone', message: 'Number is on suppression list (will be skipped)' })),
    ];
    const importable = parsed.valid.filter((v) => !existingSet.has(v.phoneE164) && !supSet.has(v.phoneE164));

    const batch = await this.prisma.$transaction(async (tx) => {
      const b = await tx.importBatch.create({
        data: {
          filename: file.originalname.slice(0, 120),
          source, lawfulBasis, status: 'PREVIEW_READY',
          totalRows: parsed.totalRows,
          validRows: importable.length,
          invalidRows: parsed.errors.length,
          duplicateRows: parsed.duplicatesInFile.length + existingSet.size,
          suppressedRows: supSet.size,
          errors: allErrors.slice(0, 500) as unknown as Prisma.InputJsonValue,
          preview: importable.slice(0, 50) as unknown as Prisma.InputJsonValue,
          storageKey: key, createdById: actor.id,
        },
      });
      await enqueueOutbox(tx, 'contact-import.validate', { batchId: b.id });
      await this.audit.log(actor, 'contact.import_previewed', 'ImportBatch', b.id, { totalRows: b.totalRows, validRows: b.validRows }, tx);
      return b;
    });
    return { ...batch, warnings: parsed.warnings };
  }

  async commitImport(actor: AuthUser, batchId: string) {
    const batch = await this.prisma.importBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new NotFoundException();
    if (batch.status === 'COMMITTED') return batch;
    if (batch.status !== 'PREVIEW_READY') throw new BadRequestException(`Batch status is ${batch.status}`);

    const raw = (await this.storage.get(batch.storageKey)).toString('utf8');
    const parsed = parseContactsCsv(raw);
    const phones = parsed.valid.map((v) => v.phoneE164);
    const suppressed = new Set(
      (await this.prisma.suppression.findMany({ where: { phoneE164: { in: phones } }, select: { phoneE164: true } })).map((s) => s.phoneE164),
    );
    const toInsert = parsed.valid.filter((v) => !suppressed.has(v.phoneE164));

    const updated = await this.prisma.$transaction(async (tx) => {
      const created = await tx.contact.createMany({
        data: toInsert.map((v) => ({
          phoneE164: v.phoneE164, name: v.name, source: batch.source, lawfulBasis: batch.lawfulBasis,
          consentAt: v.consentAt, allowSms: v.allowSms, allowVoice: v.allowVoice, language: v.language,
          importBatchId: batch.id,
        })),
        skipDuplicates: true,
      });
      const b = await tx.importBatch.update({
        where: { id: batch.id },
        data: { status: 'COMMITTED', validRows: created.count, committedAt: new Date() },
      });
      await enqueueOutbox(tx, 'contact-import.commit', { batchId: b.id, inserted: created.count });
      await this.audit.log(actor, 'contact.import_committed', 'ImportBatch', b.id, { inserted: created.count, source: batch.source }, tx);
      return b;
    });
    return updated;
  }

  listBatches() {
    return this.prisma.importBatch.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  }

  listSuppressions() {
    return this.prisma.suppression.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  }

  async addSuppression(actor: AuthUser, b: z.infer<typeof suppressSchema>) {
    const phoneE164 = normalisePhone(b.phone);
    if (!phoneE164) throw new BadRequestException('Invalid phone number format');
    const s = await this.prisma.suppression.upsert({
      where: { phoneE164 },
      update: { reason: b.reason, source: b.source },
      create: { phoneE164, reason: b.reason, source: b.source, createdById: actor.id },
    });
    await this.audit.log(actor, 'contact.suppressed', 'Suppression', s.id, { reason: b.reason, source: b.source });
    return s;
  }
}

@ApiTags('contacts')
@ApiBearerAuth()
@Controller('contacts')
export class ContactsController {
  constructor(private svc: ContactsService) {}

  @Get('template.csv')
  @RequirePermissions('contacts:read')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="contacts-template.csv"')
  template() { return CSV_TEMPLATE; }

  @Get()
  @RequirePermissions('contacts:read')
  list(@Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>) { return this.svc.list(q); }

  @Post()
  @RequirePermissions('contacts:import')
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(createContactSchema)) b: z.infer<typeof createContactSchema>) { return this.svc.create(u, b); }

  @Patch(':id')
  @RequirePermissions('contacts:import')
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(new ZodPipe(updateContactSchema)) b: z.infer<typeof updateContactSchema>) {
    return this.svc.update(u, id, b);
  }

  @Delete(':id')
  @RequirePermissions('contacts:suppress')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('reason') reason?: string) {
    return this.svc.remove(u, id, reason);
  }

  @Post('imports/preview')
  @RequirePermissions('contacts:import')
  @UseInterceptors(FileInterceptor('file'))
  preview(@CurrentUser() u: AuthUser, @UploadedFile() file: Express.Multer.File, @Body() body: { source?: string; lawfulBasis?: string; mapping?: string }) {
    return this.svc.previewCsv(u, file, body);
  }

  @Post('imports/:id/commit')
  @RequirePermissions('contacts:import')
  @HttpCode(200)
  commit(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.commitImport(u, id); }

  @Get('imports')
  @RequirePermissions('contacts:read')
  batches() { return this.svc.listBatches(); }

  @Get('suppressions')
  @RequirePermissions('contacts:read')
  suppressions() { return this.svc.listSuppressions(); }

  @Post('suppressions')
  @RequirePermissions('contacts:suppress')
  suppress(@CurrentUser() u: AuthUser, @Body(new ZodPipe(suppressSchema)) b: z.infer<typeof suppressSchema>) { return this.svc.addSuppression(u, b); }
}

@Module({ providers: [ContactsService], controllers: [ContactsController], exports: [ContactsService] })
export class ContactsModule {}
