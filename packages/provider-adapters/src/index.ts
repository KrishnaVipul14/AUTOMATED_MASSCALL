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

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
}

export class TwilioVoiceProvider implements VoiceProvider {
  readonly name = 'twilio';
  readonly simulated = false;
  constructor(private cfg: TwilioConfig) {}

  async validateConfiguration(): Promise<ConfigCheck> {
    const problems: string[] = [];
    if (!this.cfg.accountSid) problems.push('TWILIO_ACCOUNT_SID is required');
    if (!this.cfg.authToken) problems.push('TWILIO_AUTH_TOKEN is required');
    if (!this.cfg.phoneNumber) problems.push('TWILIO_PHONE_NUMBER is required');
    return { ok: problems.length === 0, problems };
  }

  verifyWebhook(_req: WebhookRequest): boolean { return true; }

  parseWebhook(rawBody: string): NormalisedEvent {
    const params = new URLSearchParams(rawBody);
    const sid = params.get('CallSid') || `call_${Date.now()}`;
    const rawStatus = (params.get('CallStatus') || '').toLowerCase();
    const map: Record<string, OutcomeStatus> = {
      queued: 'SUBMITTED',
      initiated: 'SUBMITTED',
      ringing: 'PROVIDER_ACCEPTED',
      'in-progress': 'ANSWERED',
      completed: 'COMPLETED',
      busy: 'FAILED',
      'no-answer': 'FAILED',
      canceled: 'CANCELLED',
      failed: 'FAILED',
    };
    return {
      kind: 'status',
      eventId: `tw_${sid}_${Date.now()}`,
      providerRef: sid,
      rawStatus,
      status: map[rawStatus] || 'COMPLETED',
      occurredAt: new Date(),
    };
  }

  async submitCall(input: { to: string; audioUrl: string; idempotencyKey: string }): Promise<SubmitResult> {
    if (!this.cfg.accountSid || !this.cfg.authToken || !this.cfg.phoneNumber) {
      return { status: 'FAILED', error: 'Twilio credentials or phone number missing', simulated: false };
    }
    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${this.cfg.accountSid}/Calls.json`;
      const auth = Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64');
      const twiml = input.audioUrl.startsWith('http')
        ? `<Response><Play>${input.audioUrl}</Play></Response>`
        : `<Response><Say voice="Polly.Aditi" language="hi-IN">${input.audioUrl}</Say></Response>`;

      const body = new URLSearchParams({
        To: input.to,
        From: this.cfg.phoneNumber,
        Twiml: twiml,
      });

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      if (!res.ok) {
        const text = await res.text();
        return { status: 'FAILED', error: `Twilio call failed (${res.status}): ${text.slice(0, 200)}`, simulated: false };
      }

      const data = (await res.json()) as { sid?: string };
      return { status: 'PROVIDER_ACCEPTED', providerRef: data.sid || `tw_${Date.now()}`, simulated: false };
    } catch (err) {
      return { status: 'RETRYABLE', error: err instanceof Error ? err.message : String(err), simulated: false };
    }
  }

  async getCallStatus(providerRef: string): Promise<StatusResult> {
    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${this.cfg.accountSid}/Calls/${providerRef}.json`;
      const auth = Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64');
      const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
      if (res.ok) {
        const d = (await res.json()) as { status?: string };
        const raw = (d.status || '').toLowerCase();
        const map: Record<string, OutcomeStatus> = {
          'in-progress': 'ANSWERED',
          completed: 'COMPLETED',
          busy: 'FAILED',
          'no-answer': 'FAILED',
          failed: 'FAILED',
        };
        return { status: map[raw] || 'PROVIDER_ACCEPTED', providerRef, simulated: false };
      }
    } catch { /* ignore */ }
    return { status: 'PROVIDER_ACCEPTED', providerRef, simulated: false };
  }
}

export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio_sms';
  readonly simulated = false;
  constructor(private cfg: TwilioConfig) {}

  async validateConfiguration(): Promise<ConfigCheck> {
    const problems: string[] = [];
    if (!this.cfg.accountSid) problems.push('TWILIO_ACCOUNT_SID is required');
    if (!this.cfg.authToken) problems.push('TWILIO_AUTH_TOKEN is required');
    if (!this.cfg.phoneNumber) problems.push('TWILIO_PHONE_NUMBER is required');
    return { ok: problems.length === 0, problems };
  }

  verifyWebhook(_req: WebhookRequest): boolean { return true; }
  parseWebhook(rawBody: string): NormalisedEvent {
    const params = new URLSearchParams(rawBody);
    const sid = params.get('MessageSid') || `msg_${Date.now()}`;
    const rawStatus = (params.get('MessageStatus') || '').toLowerCase();
    const map: Record<string, OutcomeStatus> = {
      queued: 'SUBMITTED',
      sent: 'PROVIDER_ACCEPTED',
      delivered: 'DELIVERED',
      undelivered: 'FAILED',
      failed: 'FAILED',
    };
    return {
      kind: 'status',
      eventId: `tw_${sid}_${Date.now()}`,
      providerRef: sid,
      rawStatus,
      status: map[rawStatus] || 'DELIVERED',
      occurredAt: new Date(),
    };
  }

  async submitMessage(input: { to: string; body: string; idempotencyKey: string }): Promise<SubmitResult> {
    if (!this.cfg.accountSid || !this.cfg.authToken || !this.cfg.phoneNumber) {
      return { status: 'FAILED', error: 'Twilio credentials or phone number missing', simulated: false };
    }
    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${this.cfg.accountSid}/Messages.json`;
      const auth = Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64');
      const body = new URLSearchParams({
        To: input.to,
        From: this.cfg.phoneNumber,
        Body: input.body,
      });

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      if (!res.ok) {
        const text = await res.text();
        return { status: 'FAILED', error: `Twilio SMS failed (${res.status}): ${text.slice(0, 200)}`, simulated: false };
      }

      const data = (await res.json()) as { sid?: string };
      return { status: 'PROVIDER_ACCEPTED', providerRef: data.sid || `tw_msg_${Date.now()}`, simulated: false };
    } catch (err) {
      return { status: 'RETRYABLE', error: err instanceof Error ? err.message : String(err), simulated: false };
    }
  }

  async getMessageStatus(providerRef: string): Promise<StatusResult> {
    return { status: 'DELIVERED', providerRef, simulated: false };
  }
}

/**
 * Factory for voice and SMS adapters.
 */
export function createProviders(mode: string, secret: string, twilio?: TwilioConfig): { voice: VoiceProvider; sms: SmsProvider } {
  if (twilio?.accountSid && twilio?.authToken && twilio?.phoneNumber) {
    return { voice: new TwilioVoiceProvider(twilio), sms: new TwilioSmsProvider(twilio) };
  }
  return { voice: new MockVoiceProvider(secret), sms: new MockSmsProvider(secret) };
}
