import { Prisma, PrismaClient } from '@prisma/client';
import type { OperatingWindow } from './window';

type Db = PrismaClient | Prisma.TransactionClient;

export const QUEUES = {
  contactImport: 'contact-import',
  campaign: 'campaign-processing',
  submitSms: 'provider-submit-sms',
  submitVoice: 'provider-submit-voice',
  providerStatus: 'provider-status',
  reports: 'report-generation',
  maintenance: 'maintenance',
} as const;

export type OutboxType =
  | 'contact-import.validate'
  | 'contact-import.commit'
  | 'campaign.schedule'
  | 'campaign.resume'
  | 'provider-event.process'
  | 'report.generate';

/** Write an outbox event. Call inside the same transaction as the state change it describes. */
export function enqueueOutbox(db: Db, type: OutboxType, payload: Record<string, unknown>) {
  return db.outboxEvent.create({ data: { type, payload: payload as Prisma.InputJsonValue } });
}

export interface Audience { sources?: string[] }

function audienceSql(audience: Audience, channel: 'VOICE' | 'SMS') {
  const sources = audience.sources?.filter(Boolean) ?? [];
  return Prisma.sql`
    FROM "Contact" c
    WHERE ${sources.length ? Prisma.sql`c."source" = ANY(${sources})` : Prisma.sql`TRUE`}
      AND ${channel === 'SMS' ? Prisma.sql`c."allowSms" = TRUE` : Prisma.sql`c."allowVoice" = TRUE`}
      AND NOT EXISTS (SELECT 1 FROM "Suppression" s WHERE s."phoneE164" = c."phoneE164")`;
}

/** Contacts eligible for a channel/audience right now (suppression and channel preference applied). */
export function findEligibleContacts(db: Db, audience: Audience, channel: 'VOICE' | 'SMS') {
  return db.$queryRaw<{ id: string; phoneE164: string }[]>(Prisma.sql`SELECT c."id", c."phoneE164" ${audienceSql(audience, channel)}`);
}

export async function countEligibleContacts(db: Db, audience: Audience, channel: 'VOICE' | 'SMS') {
  const r = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*)::bigint AS n ${audienceSql(audience, channel)}`);
  return Number(r[0]?.n ?? 0);
}

export type IneligibleReason = 'SUPPRESSED' | 'CONTACT_DELETED' | 'CHANNEL_OPTED_OUT' | null;

/** Authoritative, uncached eligibility check performed immediately before every provider submission. */
export async function recheckRecipient(db: Db, phoneE164: string, contactId: string | null, channel: 'VOICE' | 'SMS'): Promise<IneligibleReason> {
  const [sup, contact] = await Promise.all([
    db.suppression.findUnique({ where: { phoneE164 } }),
    contactId ? db.contact.findUnique({ where: { id: contactId } }) : null,
  ]);
  if (sup) return 'SUPPRESSED';
  if (!contact) return 'CONTACT_DELETED';
  if (channel === 'SMS' ? !contact.allowSms : !contact.allowVoice) return 'CHANNEL_OPTED_OUT';
  return null;
}

export interface EmergencyStop { active: boolean; reason?: string; by?: string; at?: string }
export async function getEmergencyStop(db: Db): Promise<EmergencyStop> {
  const s = await db.systemSetting.findUnique({ where: { key: 'emergencyStop' } });
  return (s?.value as unknown as EmergencyStop) ?? { active: false };
}

export const DEFAULT_WINDOW: OperatingWindow = { timezone: 'Asia/Kolkata', startHour: 9, endHour: 21, enforceInMockMode: false };
export async function getOperatingWindow(db: Db): Promise<OperatingWindow> {
  const s = await db.systemSetting.findUnique({ where: { key: 'operatingWindow' } });
  return { ...DEFAULT_WINDOW, ...((s?.value as object) ?? {}) };
}

export async function complianceStatus(db: Db) {
  const items = await db.complianceItem.findMany();
  const missing = items.filter((i) => i.required && !i.checked).map((i) => i.key);
  return { complete: items.length > 0 && missing.length === 0, missing };
}

/**
 * Determines whether REAL communications may be sent. Returns a list of blocking reasons; empty = allowed.
 * In MOCK mode real sending is always blocked (simulated sending is allowed separately).
 */
export async function productionBlockers(db: Db, mode: string, channel: 'VOICE' | 'SMS', env: Record<string, string | undefined> = process.env) {
  const reasons: string[] = [];
  if (mode !== 'PRODUCTION') reasons.push(`Provider mode is ${mode}`);
  const cfg = await db.providerConfig.findFirst({ where: { channel, enabled: true, adapter: { not: 'mock' } } });
  if (!cfg) reasons.push(`No enabled non-mock ${channel} provider adapter`);
  else {
    if (!cfg.approvalVerified) reasons.push('Provider approval for this use case not verified');
    if (cfg.mode !== 'PRODUCTION') reasons.push('Provider adapter is not in production mode');
  }
  const key = channel === 'SMS' ? env.SMS_PROVIDER_API_KEY : env.VOICE_PROVIDER_API_KEY;
  if (!key) reasons.push('Provider credentials not configured on the server');
  const c = await complianceStatus(db);
  if (!c.complete) reasons.push(`Compliance checklist incomplete (${c.missing.length} items)`);
  return reasons;
}
