import { resolve } from 'node:path';
import { config as load } from 'dotenv';
load({ path: resolve(__dirname, '../../api/.env') });
process.env.DATABASE_URL = (process.env.DATABASE_URL ?? '').replace(/\/commhub(\?|$)/, '/commhub_test$1');
process.env.PROVIDER_MODE = 'MOCK';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createProviders } from '@commhub/provider-adapters';
import { processRecipientSubmission, RetryableProviderError, startWorkerRuntime } from './worker';

const prisma = new PrismaClient();

describe('BullMQ Worker & Pre-execution Safety (integration)', () => {
  const providers = createProviders('MOCK', 'test-secret');

  beforeAll(async () => {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`;
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(',')} CASCADE`);
    await prisma.systemSetting.create({ data: { key: 'emergencyStop', value: { active: false } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('rechecks suppression immediately before execution, handles UNCERTAIN without retrying, retries RETRYABLE, and is idempotent', async () => {
    const sms = await prisma.smsTemplate.create({
      data: { name: 'T', body: 'Authorised message', segments: 1, encoding: 'GSM-7', status: 'APPROVED', createdById: 'u1', reviewedById: 'u2' },
    });
    const camp = await prisma.campaign.create({
      data: {
        name: 'Worker Test', channel: 'SMS', smsTemplateId: sms.id,
        status: 'PROCESSING', createdById: 'u1', approverId: 'u2', approvedAt: new Date(), simulated: true,
      },
    });
    const contacts = await Promise.all([
      prisma.contact.create({ data: { phoneE164: '+919876510002', source: 'S', lawfulBasis: 'B', consentAt: new Date() } }), // normal -> ACCEPTED
      prisma.contact.create({ data: { phoneE164: '+919876510005', source: 'S', lawfulBasis: 'B', consentAt: new Date() } }), // will be suppressed AFTER scheduling
      prisma.contact.create({ data: { phoneE164: '+919876510009', source: 'S', lawfulBasis: 'B', consentAt: new Date() } }), // ends in 9 -> UNCERTAIN
      prisma.contact.create({ data: { phoneE164: '+919876510008', source: 'S', lawfulBasis: 'B', consentAt: new Date() } }), // ends in 8 -> RETRYABLE
    ]);
    const recs = await Promise.all(
      contacts.map((ct) =>
        prisma.campaignRecipient.create({
          data: { campaignId: camp.id, contactId: ct.id, phoneE164: ct.phoneE164, status: 'QUEUED', idempotencyKey: `${camp.id}:${ct.phoneE164}` },
        }),
      ),
    );

    // Contact 2 opts out AFTER the campaign was scheduled.
    await prisma.suppression.create({ data: { phoneE164: '+919876510005', reason: 'Late opt-out', source: 'MANUAL' } });

    // 1. Normal recipient -> PROVIDER_ACCEPTED; second call is a no-op (idempotent).
    const r1 = await processRecipientSubmission(prisma, providers, recs[0].id);
    expect(r1.outcome).toBe('PROVIDER_ACCEPTED');
    const r1Again = await processRecipientSubmission(prisma, providers, recs[0].id);
    expect(r1Again.outcome).toBe('ALREADY_HANDLED');

    // 2. Late-suppressed recipient -> SKIPPED_SUPPRESSED (never sent).
    const r2 = await processRecipientSubmission(prisma, providers, recs[1].id);
    expect(r2.outcome).toBe('SKIPPED_SUPPRESSED');
    expect((await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: recs[1].id } })).providerRef).toBeNull();

    // 3. Uncertain outcome (ends in 9) -> stored as UNCERTAIN, does NOT throw, and a second call does NOT resubmit.
    const r3 = await processRecipientSubmission(prisma, providers, recs[2].id);
    expect(r3.outcome).toBe('UNCERTAIN');
    const r3Again = await processRecipientSubmission(prisma, providers, recs[2].id);
    expect(r3Again.outcome).toBe('ALREADY_HANDLED');
    expect((await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: recs[2].id } })).attempts).toBe(1);

    // 4. Retryable transport error (ends in 8) -> throws RetryableProviderError and resets status to QUEUED so BullMQ can retry.
    await expect(processRecipientSubmission(prisma, providers, recs[3].id)).rejects.toThrow(RetryableProviderError);
    expect((await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: recs[3].id } })).status).toBe('QUEUED');

    // 5. Emergency stop prevents any new submission.
    await prisma.systemSetting.update({ where: { key: 'emergencyStop' }, data: { value: { active: true } } });
    const blocked = await processRecipientSubmission(prisma, providers, recs[3].id);
    expect(blocked.outcome).toBe('DEFERRED_EMERGENCY_STOP');
    await prisma.systemSetting.update({ where: { key: 'emergencyStop' }, data: { value: { active: false } } });
  });

  it('publishes outbox events to Redis/BullMQ and processes a campaign end-to-end in the worker runtime', async () => {
    const rt = await startWorkerRuntime();
    try {
      const sms = await prisma.smsTemplate.findFirstOrThrow();
      const c = await prisma.campaign.create({
        data: { name: 'E2E Queue', channel: 'SMS', smsTemplateId: sms.id, status: 'SCHEDULED', createdById: 'u1', approverId: 'u2', approvedAt: new Date() },
      });
      const ct = await prisma.contact.create({ data: { phoneE164: '+919876510012', source: 'S', lawfulBasis: 'B', consentAt: new Date() } });
      const rec = await prisma.campaignRecipient.create({
        data: { campaignId: c.id, contactId: ct.id, phoneE164: ct.phoneE164, status: 'PENDING', idempotencyKey: `${c.id}:${ct.phoneE164}` },
      });
      await prisma.outboxEvent.create({ data: { type: 'campaign.schedule', payload: { campaignId: c.id, scheduledAt: new Date().toISOString() } } });

      const published = await rt.publishOutboxOnce();
      expect(published).toBeGreaterThanOrEqual(1);

      // Wait briefly for BullMQ workers to process dispatch -> submit-recipient.
      for (let i = 0; i < 30; i++) {
        const cur = await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: rec.id } });
        if (cur.status === 'PROVIDER_ACCEPTED') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const final = await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: rec.id } });
      expect(final.status).toBe('PROVIDER_ACCEPTED');
      expect(final.providerRef).toMatch(/^mocksms_/);
    } finally {
      await rt.shutdown();
    }
  });
});
