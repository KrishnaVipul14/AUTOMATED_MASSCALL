/**
 * DEMO SEED. Creates demo staff accounts, provider configs (mock only), the compliance
 * checklist and a few clearly-labelled DEMO contacts. Never run against production.
 */
import 'dotenv/config';
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
export const DEMO_PASSWORD = 'Demo-Password-2026!';

export const COMPLIANCE_ITEMS = [
  { key: 'provider_political_approval', label: 'Provider has explicitly approved the political/public-service use case in writing' },
  { key: 'trai_dlt_registration', label: 'TRAI DLT entity, header/sender ID and template registration verified (India)' },
  { key: 'election_rules_reviewed', label: 'Applicable election-commission rules and silence periods reviewed' },
  { key: 'privacy_review', label: 'Privacy / data-protection review completed (DPDP Act 2023 or applicable law)' },
  { key: 'consent_basis_documented', label: 'Consent or lawful basis documented for every contact source' },
  { key: 'opt_out_mechanism', label: 'Opt-out mechanism available to recipients and processed promptly' },
  { key: 'operating_hours', label: 'Permitted calling/SMS hours configured' },
  { key: 'retention_policy', label: 'Data retention and deletion policy approved' },
];

async function main() {
  const hash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const users: [string, string, Role][] = [
    ['admin@demo.local', 'Demo Administrator', 'ADMIN'],
    ['operator@demo.local', 'Demo Operator', 'OPERATOR'],
    ['approver@demo.local', 'Demo Approver', 'APPROVER'],
    ['auditor@demo.local', 'Demo Auditor', 'AUDITOR'],
  ];
  for (const [email, name, role] of users) {
    await prisma.user.upsert({ where: { email }, update: {}, create: { email, name, role, passwordHash: hash } });
  }
  for (const channel of ['VOICE', 'SMS'] as const) {
    await prisma.providerConfig.upsert({
      where: { channel_adapter: { channel, adapter: 'mock' } },
      update: {},
      create: { channel, adapter: 'mock', enabled: true, mode: 'MOCK', ratePerSecond: 10, maxConcurrency: 4, capabilities: { simulated: true, statuses: channel === 'VOICE' ? ['SUBMITTED', 'PROVIDER_ACCEPTED', 'ANSWERED', 'COMPLETED', 'FAILED'] : ['SUBMITTED', 'PROVIDER_ACCEPTED', 'DELIVERED', 'FAILED'] } },
    });
  }
  for (const item of COMPLIANCE_ITEMS) {
    await prisma.complianceItem.upsert({ where: { key: item.key }, update: { label: item.label }, create: item });
  }
  await prisma.systemSetting.upsert({ where: { key: 'emergencyStop' }, update: {}, create: { key: 'emergencyStop', value: { active: false } } });
  await prisma.systemSetting.upsert({
    where: { key: 'operatingWindow' }, update: {},
    create: { key: 'operatingWindow', value: { timezone: 'Asia/Kolkata', startHour: 9, endHour: 21 } },
  });
  for (let i = 1; i <= 25; i++) {
    const phone = `+9198765${String(43210 + i).padStart(5, '0')}`;
    await prisma.contact.upsert({
      where: { phoneE164: phone }, update: {},
      create: { phoneE164: phone, name: `DEMO Contact ${i}`, source: 'DEMO_SEED', lawfulBasis: 'DEMO_ONLY', consentAt: new Date(), allowSms: true, allowVoice: i % 3 !== 0 },
    });
  }
  await prisma.suppression.upsert({ where: { phoneE164: '+919876543215' }, update: {}, create: { phoneE164: '+919876543215', reason: 'DEMO opt-out', source: 'DEMO_SEED' } });
  console.log(`Demo seed complete. Demo users use password: ${DEMO_PASSWORD}`);
}

if (require.main === module) {
  main().finally(() => prisma.$disconnect());
}
