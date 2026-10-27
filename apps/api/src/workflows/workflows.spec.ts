import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { signBody } from '@commhub/provider-adapters';
import { createApp, prisma, resetDb, setupRoles } from '../test-utils/helpers';
import { COMPLIANCE_ITEMS } from '../seed';

/** Builds a minimal valid 1-second 8kHz mono 8-bit PCM WAV buffer. */
function makeWavBuffer(durationSec = 1): Buffer {
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

describe('Workflows: Contacts, Content, Campaigns, Webhooks, Reports, Settings (integration)', () => {
  let app: INestApplication;
  let t: Awaited<ReturnType<typeof setupRoles>>;

  beforeAll(async () => {
    await resetDb();
    for (const item of COMPLIANCE_ITEMS) {
      await prisma.complianceItem.create({ data: item });
    }
    await prisma.providerConfig.createMany({
      data: [
        { channel: 'SMS', adapter: 'mock', enabled: true, mode: 'MOCK' },
        { channel: 'VOICE', adapter: 'mock', enabled: true, mode: 'MOCK' },
      ],
    });
    app = await createApp();
    t = await setupRoles(app);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('Contact import, duplicate detection, suppression & deletion', () => {
    it('downloads the CSV template', async () => {
      const res = await request(app.getHttpServer()).get('/api/contacts/template.csv').set('Authorization', `Bearer ${t.OPERATOR}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain('phone,name,consent_at');
    });

    it('previews CSV with row-numbered errors, detects duplicates, excludes suppressed contacts, and commits', async () => {
      // Pre-suppress one number before import.
      const sup = await request(app.getHttpServer()).post('/api/contacts/suppressions').set('Authorization', `Bearer ${t.OPERATOR}`)
        .send({ phone: '+919876500004', reason: 'Prior opt-out', source: 'MANUAL' });
      expect(sup.status).toBe(201);

      const csv = [
        'phone,name,consent_at,allow_sms,allow_voice,religion',
        '+919876500002,Asha,2026-01-10T00:00:00Z,true,true,ignored', // row 2 valid
        '+919876500003,Bala,2026-01-10T00:00:00Z,true,true,ignored', // row 3 valid
        '98765 00002,Asha Dup,2026-01-10T00:00:00Z,true,true,x',     // row 4 duplicate of row 2
        'bad-number,Bad,2026-01-10T00:00:00Z,true,true,x',           // row 5 invalid phone
        '+919876500004,Suppressed,2026-01-10T00:00:00Z,true,true,x', // row 6 on suppression list
        '+919876500009,Uncertain,2026-01-10T00:00:00Z,true,true,x',  // row 7 valid (ends in 9 -> uncertain in mock)
      ].join('\n');

      const prev = await request(app.getHttpServer())
        .post('/api/contacts/imports/preview')
        .set('Authorization', `Bearer ${t.OPERATOR}`)
        .field('source', 'BOOTH_CAMP_JAN')
        .field('lawfulBasis', 'Explicit signed form')
        .attach('file', Buffer.from(csv), 'contacts.csv');

      expect(prev.status).toBe(201);
      expect(prev.body.totalRows).toBe(6);
      expect(prev.body.validRows).toBe(3); // rows 2, 3, 7
      expect(prev.body.invalidRows).toBe(1); // row 5
      expect(prev.body.duplicateRows).toBe(1); // row 4
      expect(prev.body.suppressedRows).toBe(1); // row 6
      expect(prev.body.warnings.join()).toMatch(/religion/i);
      const errRows = (prev.body.errors as { row: number }[]).map((e) => e.row);
      expect(errRows).toEqual(expect.arrayContaining([4, 5, 6]));

      const commit = await request(app.getHttpServer())
        .post(`/api/contacts/imports/${prev.body.id}/commit`)
        .set('Authorization', `Bearer ${t.OPERATOR}`);
      expect(commit.status).toBe(200);
      expect(commit.body.status).toBe('COMMITTED');
      expect(commit.body.validRows).toBe(3);

      // Suppressed row 6 was never inserted into Contact.
      expect(await prisma.contact.findUnique({ where: { phoneE164: '+919876500004' } })).toBeNull();
    });

    it('supports contact deletion requests and suppresses the deleted number', async () => {
      const created = await request(app.getHttpServer()).post('/api/contacts').set('Authorization', `Bearer ${t.OPERATOR}`)
        .send({ phone: '+919876500099', name: 'Delete Me', source: 'WEB_FORM', lawfulBasis: 'Opt-in', consentAt: '2026-01-01T00:00:00Z' });
      expect(created.status).toBe(201);
      const del = await request(app.getHttpServer()).delete(`/api/contacts/${created.body.id}?reason=Citizen%20request`).set('Authorization', `Bearer ${t.OPERATOR}`);
      expect(del.status).toBe(200);
      expect(await prisma.contact.findUnique({ where: { id: created.body.id } })).toBeNull();
      expect(await prisma.suppression.findUnique({ where: { phoneE164: '+919876500099' } })).not.toBeNull();
    });
  });

  describe('Voice & SMS content approval and Campaign lifecycle', () => {
    let smsTemplateId: string;
    let audioAssetId: string;
    let campaignId: string;

    it('rejects non-audio files and approves valid WAV and SMS templates', async () => {
      const badAudio = await request(app.getHttpServer())
        .post('/api/voice-announcements')
        .set('Authorization', `Bearer ${t.OPERATOR}`)
        .field('title', 'Fake')
        .attach('file', Buffer.from('not really audio'), { filename: 'fake.wav', contentType: 'audio/wav' });
      expect(badAudio.status).toBe(400);

      const goodAudio = await request(app.getHttpServer())
        .post('/api/voice-announcements')
        .set('Authorization', `Bearer ${t.OPERATOR}`)
        .field('title', 'Town Hall Notice')
        .attach('file', makeWavBuffer(2), { filename: 'notice.wav', contentType: 'audio/wav' });
      expect(goodAudio.status).toBe(201);
      expect(goodAudio.body.durationSec).toBe(2);
      audioAssetId = goodAudio.body.id;

      const revA = await request(app.getHttpServer()).post(`/api/voice-announcements/${audioAssetId}/review`).set('Authorization', `Bearer ${t.APPROVER}`)
        .send({ decision: 'APPROVED', note: 'Clear audio' });
      expect(revA.status).toBe(201);

      const sms = await request(app.getHttpServer()).post('/api/sms-templates').set('Authorization', `Bearer ${t.OPERATOR}`)
        .send({ name: 'Booth Timing', body: 'Authorised public notice: Booth open 8am-5pm. Reply STOP to opt out.' });
      expect(sms.status).toBe(201);
      expect(sms.body.segments).toBe(1);
      smsTemplateId = sms.body.id;
    });

    it('blocks submitting a campaign whose template is not yet APPROVED, enforces maker-checker, and blocks scheduling before approval', async () => {
      // Rejects sensitive targeting attributes in audience schema (.strict()).
      const badAudience = await request(app.getHttpServer()).post('/api/campaigns').set('Authorization', `Bearer ${t.OPERATOR}`)
        .send({ name: 'Bad', channel: 'SMS', smsTemplateId, audience: { religion: 'x' } });
      expect(badAudience.status).toBe(400);

      const c = await request(app.getHttpServer()).post('/api/campaigns').set('Authorization', `Bearer ${t.OPERATOR}`)
        .send({ name: 'Public Notice SMS', channel: 'SMS', smsTemplateId, audience: { sources: ['BOOTH_CAMP_JAN'] } });
      expect(c.status).toBe(201);
      campaignId = c.body.id;

      // Cannot schedule a DRAFT campaign.
      expect((await request(app.getHttpServer()).post(`/api/campaigns/${campaignId}/schedule`).set('Authorization', `Bearer ${t.OPERATOR}`).send({})).status).toBe(400);

      // Cannot submit while SMS template is still IN_REVIEW.
      expect((await request(app.getHttpServer()).post(`/api/campaigns/${campaignId}/submit`).set('Authorization', `Bearer ${t.OPERATOR}`)).status).toBe(400);

      // Approve the SMS template, then submit campaign.
      await request(app.getHttpServer()).post(`/api/sms-templates/${smsTemplateId}/review`).set('Authorization', `Bearer ${t.APPROVER}`).send({ decision: 'APPROVED' });
      const sub = await request(app.getHttpServer()).post(`/api/campaigns/${campaignId}/submit`).set('Authorization', `Bearer ${t.OPERATOR}`);
      expect(sub.status).toBe(200);
      expect(sub.body.status).toBe('PENDING_APPROVAL');

      // Approver approves, rejects back to draft, re-submits, re-approves.
      const rej = await request(app.getHttpServer()).post(`/api/campaigns/${campaignId}/reject`).set('Authorization', `Bearer ${t.APPROVER}`).send({ reason: 'Add date' });
      expect(rej.status).toBe(200);
      expect(rej.body.status).toBe('DRAFT');

      await request(app.getHttpServer()).post(`/api/campaigns/${campaignId}/submit`).set('Authorization', `Bearer ${t.OPERATOR}`);
      const app1 = await request(app.getHttpServer()).post(`/api/campaigns/${campaignId}/approve`).set('Authorization', `Bearer ${t.APPROVER}`).send({ note: 'Approved for release' });
      expect(app1.status).toBe(200);
      expect(app1.body.status).toBe('APPROVED');

      // Schedule the approved campaign: creates recipient rows and an outbox event.
      const sch = await request(app.getHttpServer()).post(`/api/campaigns/${campaignId}/schedule`).set('Authorization', `Bearer ${t.OPERATOR}`).send({});
      expect(sch.status).toBe(200);
      expect(sch.body.status).toBe('SCHEDULED');
      expect(await prisma.campaignRecipient.count({ where: { campaignId } })).toBe(3);
      expect(await prisma.outboxEvent.count({ where: { type: 'campaign.schedule' } })).toBe(1);
    });

    it('verifies webhooks, rejects invalid signatures and malformed payloads, handles duplicate and out-of-order events, and exports masked CSV', async () => {
      // Simulate the worker having submitted recipient +919876500002 to the mock voice/sms provider.
      const rec = await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId, phoneE164: '+919876500002' } });
      await prisma.campaignRecipient.update({ where: { id: rec.id }, data: { status: 'PROVIDER_ACCEPTED', providerRef: 'mocksms_ref_2' } });
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'PROCESSING' } });

      // 1. Invalid signature -> 401
      const badSig = await request(app.getHttpServer()).post('/api/webhooks/sms').set('x-signature', 'wrong')
        .send({ eventId: 'ev1', providerRef: 'mocksms_ref_2', status: 'delivered', occurredAt: new Date().toISOString() });
      expect(badSig.status).toBe(401);

      // 2. Valid signature, malformed payload -> 400
      const secret = process.env.WEBHOOK_SIGNING_SECRET!;
      const malformed = JSON.stringify({ eventId: 'ev_bad', status: 'unknown_status', occurredAt: new Date().toISOString() });
      const badBody = await request(app.getHttpServer()).post('/api/webhooks/sms')
        .set('Content-Type', 'application/json').set('x-signature', signBody(malformed, secret)).send(malformed);
      expect(badBody.status).toBe(400);

      // 3. Valid delivered callback -> updates recipient to DELIVERED.
      const okPayload = JSON.stringify({
        eventId: 'ev_deliv_1', providerRef: 'mocksms_ref_2', status: 'delivered',
        occurredAt: new Date().toISOString(), cost: { amount: 0.18, currency: 'INR' },
      });
      const ok1 = await request(app.getHttpServer()).post('/api/webhooks/sms')
        .set('Content-Type', 'application/json').set('x-signature', signBody(okPayload, secret)).send(okPayload);
      expect(ok1.status).toBe(200);
      expect(ok1.body).toMatchObject({ duplicate: false, applied: true });
      expect((await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe('DELIVERED');

      // 4. Duplicate callback (same eventId) -> safely ignored.
      const dup = await request(app.getHttpServer()).post('/api/webhooks/sms')
        .set('Content-Type', 'application/json').set('x-signature', signBody(okPayload, secret)).send(okPayload);
      expect(dup.status).toBe(200);
      expect(dup.body.duplicate).toBe(true);

      // 5. Out-of-order older status ('accepted' arriving after 'delivered') -> stored but not applied (no regression).
      const latePayload = JSON.stringify({
        eventId: 'ev_late_1', providerRef: 'mocksms_ref_2', status: 'accepted', occurredAt: new Date().toISOString(),
      });
      const late = await request(app.getHttpServer()).post('/api/webhooks/sms')
        .set('Content-Type', 'application/json').set('x-signature', signBody(latePayload, secret)).send(latePayload);
      expect(late.status).toBe(200);
      expect(late.body.applied).toBe(false);
      expect((await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe('DELIVERED');

      // 6. Reports & masked CSV export.
      const rep = await request(app.getHttpServer()).get('/api/reports/outcomes').set('Authorization', `Bearer ${t.AUDITOR}`);
      expect(rep.status).toBe(200);
      expect(rep.body.counts.DELIVERED.simulated).toBe(1);

      const csv = await request(app.getHttpServer()).get('/api/reports/export.csv').set('Authorization', `Bearer ${t.AUDITOR}`);
      expect(csv.status).toBe(200);
      expect(csv.text).toContain('+9198******02'); // masked for auditor
      expect(csv.text).not.toContain('+919876500002');
      expect(csv.text).toContain('SIMULATED');
    });

    it('enforces emergency stop and blocks enabling PRODUCTION mode on unapproved/mock providers', async () => {
      // Activate emergency stop -> pauses processing campaigns and blocks scheduling.
      const stop = await request(app.getHttpServer()).post('/api/settings/emergency-stop').set('Authorization', `Bearer ${t.OPERATOR}`)
        .send({ active: true, reason: 'Verification drill' });
      expect(stop.status).toBe(200);
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe('PAUSED');

      // Clear emergency stop, then cancel campaign.
      await request(app.getHttpServer()).post('/api/settings/emergency-stop').set('Authorization', `Bearer ${t.OPERATOR}`).send({ active: false });
      const can = await request(app.getHttpServer()).post(`/api/campaigns/${campaignId}/cancel`).set('Authorization', `Bearer ${t.OPERATOR}`).send({ reason: 'Done' });
      expect(can.status).toBe(200);
      expect(can.body.status).toBe('CANCELLED');

      // Provider config: cannot switch mock adapter to PRODUCTION.
      const provs = await request(app.getHttpServer()).get('/api/providers').set('Authorization', `Bearer ${t.ADMIN}`);
      expect(provs.status).toBe(200);
      const mockId = provs.body.configs[0].id;
      const badProd = await request(app.getHttpServer()).patch(`/api/providers/${mockId}`).set('Authorization', `Bearer ${t.ADMIN}`)
        .send({ mode: 'PRODUCTION' });
      expect(badProd.status).toBe(400);
    });
  });
});
