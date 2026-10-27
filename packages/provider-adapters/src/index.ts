import { createHmac, timingSafeEqual } from 'node:crypto';
import type { OutcomeStatus } from '@commhub/shared-types';

export interface SubmitResult {
  /**
   * PROVIDER_ACCEPTED/SUBMITTED: provider has the request.
   * FAILED: provider definitively rejected it (safe: nothing was sent).
   * RETRYABLE: request definitely did NOT reach the provider (e.g. connection refused) - safe to retry.
   * UNCERTAIN: request may or may not have reached the provider (timeout). Never blindly retry.
   */
  status: 'SUBMITTED' | 'PROVIDER_ACCEPTED' | 'FAILED' | 'RETRYABLE' | 'UNCERTAIN';
  providerRef?: string;
  error?: string;
  simulated: boolean;
}
export interface StatusResult { status: OutcomeStatus; providerRef: string; simulated: boolean }
export interface ConfigCheck { ok: boolean; problems: string[] }
export interface WebhookRequest { rawBody: string; headers: Record<string, string | undefined> }

/** Provider-agnostic event produced by parsing a verified webhook. */
export type NormalisedEvent =
  | { kind: 'status'; eventId: string; providerRef: string; rawStatus: string; status: OutcomeStatus; occurredAt: Date; cost?: { amount: number; currency: string } }
  | { kind: 'opt_out'; eventId: string; phone: string; occurredAt: Date };

interface ProviderBase {
  readonly name: string;
  readonly simulated: boolean;
  validateConfiguration(): Promise<ConfigCheck>;
  verifyWebhook(req: WebhookRequest): boolean;
  /** Validates and normalises a webhook body. Throws on malformed payloads. */
  parseWebhook(rawBody: string): NormalisedEvent;
}
export interface VoiceProvider extends ProviderBase {
  submitCall(input: { to: string; audioUrl: string; idempotencyKey: string }): Promise<SubmitResult>;
  getCallStatus(providerRef: string): Promise<StatusResult>;
}
export interface SmsProvider extends ProviderBase {
  submitMessage(input: { to: string; body: string; idempotencyKey: string }): Promise<SubmitResult>;
  getMessageStatus(providerRef: string): Promise<StatusResult>;
}

export function signBody(rawBody: string, secret: string) {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}
export function verifyHmac(req: WebhookRequest, secret: string, header = 'x-signature'): boolean {
  const given = req.headers[header];
  if (!given || !secret) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(signBody(req.rawBody, secret));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Mock provider raw statuses -> normalised internal statuses. */
export const MOCK_STATUS_MAP: Record<string, OutcomeStatus> = {
  accepted: 'PROVIDER_ACCEPTED',
  answered: 'ANSWERED',
  completed: 'COMPLETED',
  delivered: 'DELIVERED',
  failed: 'FAILED',
  no_answer: 'FAILED',
  busy: 'FAILED',
  undelivered: 'FAILED',
};

export function parseMockWebhook(rawBody: string): NormalisedEvent {
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(rawBody);
  } catch {
    throw new Error('Malformed JSON');
  }
  if (!b || typeof b !== 'object') throw new Error('Payload must be an object');
  const eventId = b.eventId;
  if (typeof eventId !== 'string' || !eventId || eventId.length > 128) throw new Error('eventId is required');
  const occurredAt = new Date(typeof b.occurredAt === 'string' ? b.occurredAt : NaN);
  if (isNaN(occurredAt.getTime())) throw new Error('occurredAt must be an ISO timestamp');
  if (b.type === 'opt_out') {
    if (typeof b.phone !== 'string') throw new Error('phone is required for opt_out');
    return { kind: 'opt_out', eventId, phone: b.phone, occurredAt };
  }
  if (typeof b.providerRef !== 'string' || !b.providerRef) throw new Error('providerRef is required');
  const raw = String(b.status ?? '');
  const status = MOCK_STATUS_MAP[raw];
  if (!status) throw new Error(`Unknown status "${raw.slice(0, 32)}"`);
  let cost: { amount: number; currency: string } | undefined;
  const c = b.cost as { amount?: unknown; currency?: unknown } | undefined;
  if (c && typeof c.amount === 'number' && typeof c.currency === 'string') cost = { amount: c.amount, currency: c.currency };
  return { kind: 'status', eventId, providerRef: b.providerRef, rawStatus: raw, status, occurredAt, cost };
}

/**
 * Mock behaviour is deterministic by the last digit of the destination number so tests and demos are repeatable:
 *   ...0 -> provider rejects (FAILED)     ...9 -> UNCERTAIN (simulated timeout)
 *   ...8 -> RETRYABLE (simulated connection refused, nothing sent)
 * All other numbers are accepted.
 */
abstract class MockBase {
  readonly simulated = true;
  protected refs = new Map<string, OutcomeStatus>();
  protected seen = new Map<string, string>();
  constructor(protected secret: string, public readonly name = 'mock') {}
  protected submit(prefix: string, to: string, key: string): SubmitResult {
    const prior = this.seen.get(key);
    if (prior) return { status: 'PROVIDER_ACCEPTED', providerRef: prior, simulated: true }; // provider-side idempotency
    const last = to.slice(-1);
    if (last === '9') return { status: 'UNCERTAIN', error: 'Simulated timeout: outcome unknown', simulated: true };
    if (last === '8') return { status: 'RETRYABLE', error: 'Simulated connection refused', simulated: true };
    if (last === '0') return { status: 'FAILED', error: 'Simulated provider rejection', simulated: true };
    const ref = `${prefix}_${key.replace(/[^a-zA-Z0-9]/g, '').slice(-24)}_${this.seen.size + 1}`;
    this.seen.set(key, ref);
    this.refs.set(ref, 'PROVIDER_ACCEPTED');
    return { status: 'PROVIDER_ACCEPTED', providerRef: ref, simulated: true };
  }
  /** Test/simulator hook to advance a simulated outcome. */
  simulate(ref: string, status: OutcomeStatus) { this.refs.set(ref, status); }
  protected status(ref: string): StatusResult {
    return { status: this.refs.get(ref) ?? 'UNCERTAIN', providerRef: ref, simulated: true };
  }
  async validateConfiguration(): Promise<ConfigCheck> {
    return this.secret ? { ok: true, problems: [] } : { ok: false, problems: ['WEBHOOK_SIGNING_SECRET not set'] };
  }
  verifyWebhook(req: WebhookRequest) { return verifyHmac(req, this.secret); }
  parseWebhook(rawBody: string) { return parseMockWebhook(rawBody); }
}

export class MockVoiceProvider extends MockBase implements VoiceProvider {
  async submitCall(i: { to: string; audioUrl: string; idempotencyKey: string }) { return this.submit('mockcall', i.to, i.idempotencyKey); }
  async getCallStatus(ref: string) { return this.status(ref); }
  /** Simulated callback sequence for an accepted call (answered != heard). */
  static plannedEvents(to: string): string[] {
    const d = Number(to.slice(-1));
    if (d === 1) return ['no_answer'];
    if (d === 2) return ['busy'];
    if (d === 3) return ['completed', 'answered']; // deliberately out of order
    return ['answered', 'completed'];
  }
}
export class MockSmsProvider extends MockBase implements SmsProvider {
  async submitMessage(i: { to: string; body: string; idempotencyKey: string }) { return this.submit('mocksms', i.to, i.idempotencyKey); }
  async getMessageStatus(ref: string) { return this.status(ref); }
  static plannedEvents(to: string): string[] {
    const d = Number(to.slice(-1));
    if (d === 1) return ['undelivered'];
    if (d === 3) return ['delivered', 'delivered']; // duplicate callback
    return ['delivered'];
  }
}

/**
 * Factory. Only mock adapters exist. A production adapter must be added only after the provider's official
 * documentation and written approval for the intended political/public-service use case are verified.
 */
export function createProviders(mode: string, secret: string): { voice: VoiceProvider; sms: SmsProvider } {
  if (mode === 'MOCK') return { voice: new MockVoiceProvider(secret), sms: new MockSmsProvider(secret) };
  throw new Error(`No approved ${mode} provider adapter is implemented. Real sending is disabled.`);
}
