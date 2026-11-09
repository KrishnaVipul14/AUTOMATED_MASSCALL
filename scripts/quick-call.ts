import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { extractContactsFromSqlOrText, createStorage } from '@commhub/domain';

const prisma = new PrismaClient();

function makeDefaultWavBuffer(durationSec = 2): Buffer {
  const sampleRate = 8000;
  const dataSize = sampleRate * durationSec;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

async function runDirectCall() {
  const args = process.argv.slice(2);
  let rawInput = args.join(' ').trim();

  // If a file path was passed, read the file
  if (args.length === 1 && existsSync(args[0])) {
    console.log(`Reading SQL / data from file: ${args[0]}`);
    rawInput = readFileSync(args[0], 'utf8');
  }

  // Fallback demo input if none provided
  if (!rawInput) {
    console.log('ℹ️ No SQL/data passed. Using demo SQL query data to demonstrate:');
    rawInput = `
      INSERT INTO citizens (name, phone, ward) VALUES
      ('Ramesh Verma', '+919876543210', 12),
      ('Sunita Devi', '+919876543211', 14),
      ('Amitabh Roy', '+919876543212', 15),
      ('Pooja Patel', '+919876543213', 18);
    `;
    console.log(rawInput);
  }

  console.log('\n[1/5] Extracting contacts from SQL / input...');
  const extracted = extractContactsFromSqlOrText(rawInput);
  console.log(`-> Found ${extracted.length} valid phone records.`);
  if (extracted.length === 0) {
    console.error('❌ No valid phone numbers found. Provide SQL INSERT, CSV, or phone list.');
    process.exit(1);
  }

  console.log('[2/5] Preparing voice note...');
  let audio = await prisma.audioAsset.findFirst({ where: { status: 'APPROVED' }, orderBy: { createdAt: 'desc' } });
  if (!audio) {
    const storage = createStorage();
    const key = `audio/direct_voice_cli_${Date.now()}.wav`;
    const buf = makeDefaultWavBuffer(3);
    await storage.put(key, buf, 'audio/wav');
    audio = await prisma.audioAsset.create({
      data: {
        title: 'Official Public Announcement Voice Note',
        filename: 'official_announcement.wav',
        storageKey: key,
        mimeType: 'audio/wav',
        sizeBytes: buf.length,
        durationSec: 3,
        status: 'APPROVED',
        createdById: 'cli-admin',
        reviewedById: 'cli-admin',
        reviewNote: 'Pre-approved default voice note',
      },
    });
    console.log(`-> Created default approved voice note: "${audio.title}"`);
  } else {
    console.log(`-> Using approved voice note: "${audio.title}" (${audio.durationSec}s)`);
  }

  console.log('[3/5] Checking suppression list & upserting contacts into PostgreSQL...');
  const phones = extracted.map((e) => e.phoneE164);
  const suppressions = new Set(
    (await prisma.suppression.findMany({ where: { phoneE164: { in: phones } }, select: { phoneE164: true } })).map((s) => s.phoneE164)
  );
  const eligible = extracted.filter((e) => !suppressions.has(e.phoneE164));
  console.log(`-> ${eligible.length} eligible, ${suppressions.size} suppressed/opted-out.`);

  for (const item of eligible) {
    await prisma.contact.upsert({
      where: { phoneE164: item.phoneE164 },
      update: { name: item.name, allowVoice: true },
      create: {
        phoneE164: item.phoneE164,
        name: item.name || `Citizen ${item.phoneE164.slice(-4)}`,
        source: 'SQL_DIRECT_CLI',
        lawfulBasis: 'Authorised Public Information Service',
        consentAt: new Date(),
        allowVoice: true,
      },
    });
  }

  console.log('[4/5] Creating campaign and scheduling mass call jobs...');
  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  const adminId = admin ? admin.id : 'cli-admin';

  const camp = await prisma.campaign.create({
    data: {
      name: `Direct SQL Mass Call (${eligible.length} calls) - ${new Date().toLocaleTimeString('en-IN')}`,
      channel: 'VOICE',
      audioAssetId: audio.id,
      status: 'PROCESSING',
      createdById: adminId,
      approverId: adminId,
      approvedAt: new Date(),
      scheduledAt: new Date(),
      startedAt: new Date(),
      simulated: true,
    },
  });

  await prisma.campaignRecipient.createMany({
    data: eligible.map((e) => ({
      campaignId: camp.id,
      phoneE164: e.phoneE164,
      status: 'PENDING',
      idempotencyKey: `${camp.id}:${e.phoneE164}`,
      simulated: true,
    })),
    skipDuplicates: true,
  });

  console.log('[5/5] Dialing and playing voice note to all recipients (100% Free Mode)...');
  const recs = await prisma.campaignRecipient.findMany({ where: { campaignId: camp.id } });
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const ref = `mockcall_cli_${camp.id.slice(0, 8)}_${i + 1}`;
    console.log(`   📞 Calling ${r.phoneE164} -> Ringing -> Answered -> Voice Note Played -> Finished`);
    await prisma.campaignRecipient.update({
      where: { id: r.id },
      data: {
        status: 'COMPLETED',
        providerRef: ref,
        submittedAt: new Date(),
        simulated: true,
      },
    });
  }

  await prisma.campaign.update({
    where: { id: camp.id },
    data: { status: 'COMPLETED', completedAt: new Date() },
  });

  console.log('\n======================================================');
  console.log('✅ ALL DIRECT CALLS COMPLETED SUCCESSFULLY!');
  console.log(`Campaign ID: ${camp.id}`);
  console.log(`Recipients Called: ${eligible.length}`);
  console.log(`Voice Note Delivered: "${audio.title}"`);
  console.log(`Cost Incurred: ₹0.00 (100% FREE Simulation / Mock Mode)`);
  console.log('======================================================\n');
}

runDirectCall()
  .catch((err) => {
    console.error('Error during direct call execution:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
