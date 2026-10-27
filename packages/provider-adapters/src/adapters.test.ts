import { describe, it, expect } from 'vitest';
import { MockVoiceProvider, MockSmsProvider, parseMockWebhook, signBody, createProviders } from './index';
import { shouldApplyOutcome, canTransition } from '@commhub/shared-types';

describe('mock providers', () => {
  it('is idempotent per key (provider-side dedupe)', async () => {
    const p = new MockSmsProvider('s');
    const a = await p.submitMessage({ to: '+919876543212', body: 'x', idempotencyKey: 'k' });
    const b = await p.submitMessage({ to: '+919876543212', body: 'x', idempotencyKey: 'k' });
    expect(a.status).toBe('PROVIDER_ACCEPTED');
    expect(a.providerRef).toBe(b.providerRef);
    expect(a.simulated).toBe(true);
  });
  it('simulates rejected, retryable and uncertain outcomes deterministically', async () => {
    const p = new MockVoiceProvider('s');
    expect((await p.submitCall({ to: '+919876543210', audioUrl: 'u', idempotencyKey: 'a' })).status).toBe('FAILED');
    expect((await p.submitCall({ to: '+919876543218', audioUrl: 'u', idempotencyKey: 'b' })).status).toBe('RETRYABLE');
    expect((await p.submitCall({ to: '+919876543219', audioUrl: 'u', idempotencyKey: 'c' })).status).toBe('UNCERTAIN');
  });
  it('verifies webhook signatures', () => {
    const p = new MockSmsProvider('sec');
    const body = '{"a":1}';
    expect(p.verifyWebhook({ rawBody: body, headers: { 'x-signature': signBody(body, 'sec') } })).toBe(true);
    expect(p.verifyWebhook({ rawBody: body, headers: { 'x-signature': signBody(body, 'other') } })).toBe(false);
    expect(p.verifyWebhook({ rawBody: body + ' ', headers: { 'x-signature': signBody(body, 'sec') } })).toBe(false);
    expect(p.verifyWebhook({ rawBody: body, headers: {} })).toBe(false);
  });
  it('refuses to build non-mock providers', () => {
    expect(() => createProviders('PRODUCTION', 's')).toThrow(/No approved/);
  });
});

describe('webhook parsing', () => {
  const at = '2026-10-27T10:00:00Z';
  it('normalises statuses', () => {
    const e = parseMockWebhook(JSON.stringify({ eventId: 'e1', providerRef: 'r', status: 'no_answer', occurredAt: at }));
    expect(e).toMatchObject({ kind: 'status', status: 'FAILED', rawStatus: 'no_answer' });
  });
  it('rejects malformed payloads', () => {
    expect(() => parseMockWebhook('not json')).toThrow(/Malformed/);
    expect(() => parseMockWebhook(JSON.stringify({ providerRef: 'r', status: 'delivered', occurredAt: at }))).toThrow(/eventId/);
    expect(() => parseMockWebhook(JSON.stringify({ eventId: 'e', providerRef: 'r', status: 'weird', occurredAt: at }))).toThrow(/Unknown/);
    expect(() => parseMockWebhook(JSON.stringify({ eventId: 'e', providerRef: 'r', status: 'delivered' }))).toThrow(/occurredAt/);
  });
  it('parses opt-outs', () => {
    expect(parseMockWebhook(JSON.stringify({ eventId: 'o', type: 'opt_out', phone: '+919876543212', occurredAt: at }))).toMatchObject({ kind: 'opt_out' });
  });
});

describe('status model', () => {
  it('ignores out-of-order and duplicate events', () => {
    expect(shouldApplyOutcome('COMPLETED', 'ANSWERED')).toBe(false);
    expect(shouldApplyOutcome('ANSWERED', 'ANSWERED')).toBe(false);
    expect(shouldApplyOutcome('PROVIDER_ACCEPTED', 'ANSWERED')).toBe(true);
    expect(shouldApplyOutcome('UNCERTAIN', 'DELIVERED')).toBe(true);
  });
  it('enforces campaign transitions', () => {
    expect(canTransition('DRAFT', 'SCHEDULED')).toBe(false);
    expect(canTransition('APPROVED', 'SCHEDULED')).toBe(true);
  });
});
